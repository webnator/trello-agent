import * as fs from "fs";
import { getTasksByStatus, getTask } from "./task-store.js";
import { runLocalPipeline } from "./local-pipeline.js";
import { getAllProjects } from "./projects.js";
import type { ProjectConfig } from "../types.js";

const MAX_CONCURRENT = 3;

interface TaskState {
  attempt: number;
  inFlight: boolean;
  lastError?: string;
  lastFailedAt?: number;
}

// Task states keyed by "projectName:taskId" to avoid collisions across projects
const taskStates = new Map<string, TaskState>();
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let pollCycleCount = 0;

function taskKey(projectName: string, taskId: string): string {
  return `${projectName}:${taskId}`;
}

export function stopPolling(): void {
  shuttingDown = true;
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

export function pollLoop(intervalMs: number = 30_000): void {
  console.log(`Poller started (interval: ${intervalMs / 1000}s)`);

  async function tick(): Promise<void> {
    if (shuttingDown) return;

    try {
      await checkAllProjects();
    } catch (err) {
      console.error("Poll cycle error:", err);
    }

    if (!shuttingDown) {
      pollTimeout = setTimeout(tick, intervalMs);
    }
  }

  // Run immediately on start
  tick();
}

async function checkAllProjects(): Promise<void> {
  pollCycleCount++;

  // Touch health check file for Docker
  try {
    fs.writeFileSync("/tmp/task-agent-alive", String(Date.now()));
  } catch {
    // Non-fatal if /tmp isn't writable
  }

  const projects = getAllProjects();

  if (projects.length === 0) {
    return;
  }

  // Process each project sequentially to avoid overwhelming APIs
  for (const project of projects) {
    if (shuttingDown) break;

    try {
      await checkProjectForTasks(project);
    } catch (err) {
      // Log error but continue with other projects
      console.error(`Error polling project "${project.name}":`, err);
    }
  }
}

async function checkProjectForTasks(project: ProjectConfig): Promise<void> {
  const { name: projectName } = project;

  // Fetch tasks by status
  const todoTasks = getTasksByStatus(projectName, "todo");
  const inProgressTasks = getTasksByStatus(projectName, "in_progress");

  if (todoTasks.length === 0 && inProgressTasks.length === 0) {
    return; // Nothing to do
  }

  // Collect all current task IDs for cleanup
  const currentTaskKeys = new Set<string>();

  const allTasks = [
    ...todoTasks.map((t) => ({ task: t, isRetry: false })),
    ...inProgressTasks.map((t) => ({ task: t, isRetry: true })),
  ];

  for (const { task } of allTasks) {
    currentTaskKeys.add(taskKey(projectName, task.id));
  }

  // Clean up taskStates for tasks no longer active
  for (const key of taskStates.keys()) {
    if (key.startsWith(`${projectName}:`) && !currentTaskKeys.has(key)) {
      const state = taskStates.get(key);
      if (state && !state.inFlight) {
        taskStates.delete(key);
      }
    }
  }

  const actionable = allTasks.filter((t) => {
    const key = taskKey(projectName, t.task.id);
    const state = taskStates.get(key);
    if (!state) return true;
    if (state.inFlight) return false;

    // Retry backoff: skip if not enough poll cycles have elapsed since last failure
    if (state.lastFailedAt && state.attempt > 0) {
      const backoffCycles = state.attempt * 2;
      const cyclesSinceFailure = pollCycleCount - state.lastFailedAt;
      if (cyclesSinceFailure < backoffCycles) {
        return false;
      }
    }

    return true;
  });

  if (actionable.length === 0) {
    return; // All tasks already being processed or in backoff, stay quiet
  }

  console.log(
    `[${projectName}] Found ${todoTasks.length} todo task(s), ${inProgressTasks.length} in-progress task(s) (${actionable.length} actionable)`
  );

  // Process actionable tasks with concurrency limit
  const queue = [...actionable];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    // Fill up to MAX_CONCURRENT slots
    while (queue.length > 0 && running.length < MAX_CONCURRENT) {
      const item = queue.shift()!;
      const promise = processTask(project, item.task.id, item.task.name, item.isRetry).then(() => {
        running.splice(running.indexOf(promise), 1);
      });
      running.push(promise);
    }

    // Wait for at least one to finish before filling more
    if (running.length > 0) {
      await Promise.race(running);
    }
  }
}

async function processTask(
  project: ProjectConfig,
  taskId: string,
  taskName: string,
  isRetry: boolean
): Promise<void> {
  if (shuttingDown) return;

  const { name: projectName } = project;
  const key = taskKey(projectName, taskId);
  let state = taskStates.get(key);

  if (!state) {
    state = { attempt: 0, inFlight: false };
    taskStates.set(key, state);
  }

  // Skip if already being processed
  if (state.inFlight) {
    return;
  }

  // For retries, only process if it was a previous failure (has attempt > 0)
  if (isRetry && state.attempt === 0) {
    // This task was moved to in_progress by another process or manually.
    // Treat it as a new task.
    state.attempt = 0;
  }

  state.attempt++;
  state.inFlight = true;

  console.log(
    `\n[${projectName}] Processing task: "${taskName}" (${isRetry ? "retry" : "new"}, attempt ${state.attempt})`
  );

  try {
    // Fetch full task details
    const fullTask = getTask(projectName, taskId);
    if (!fullTask) {
      console.error(`[${projectName}] Task "${taskName}" (${taskId}) not found in store`);
      taskStates.delete(key);
      return;
    }

    const result = await runLocalPipeline(
      project,
      fullTask,
      state.attempt,
      state.lastError
    );

    if (result.success) {
      // Clean up state on success
      taskStates.delete(key);
      console.log(`[${projectName}] Task "${taskName}" completed successfully!`);
    } else {
      state.lastError = result.error;
      state.lastFailedAt = pollCycleCount;
      console.log(`[${projectName}] Task "${taskName}" failed (attempt ${state.attempt}): ${result.error?.slice(0, 200)}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    state.lastFailedAt = pollCycleCount;
    console.error(`[${projectName}] Task "${taskName}" threw: ${message}`);
  } finally {
    state.inFlight = false;
  }
}
