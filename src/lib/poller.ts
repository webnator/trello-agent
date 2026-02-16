import * as fs from "fs";
import { getCardsInList, findListByName, getCard } from "./trello.js";
import { runLocalPipeline } from "./local-pipeline.js";
import { getAllProjects } from "./projects.js";
import type { ProjectConfig } from "../types.js";

const MAX_CONCURRENT = 3;

interface CardState {
  attempt: number;
  inFlight: boolean;
  lastError?: string;
  lastFailedAt?: number;
}

// Card states keyed by "projectName:cardId" to avoid collisions across projects
const cardStates = new Map<string, CardState>();
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let pollCycleCount = 0;

function cardKey(projectName: string, cardId: string): string {
  return `${projectName}:${cardId}`;
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
    fs.writeFileSync("/tmp/trello-agent-alive", String(Date.now()));
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
      await checkProjectForCards(project);
    } catch (err) {
      // Log error but continue with other projects
      console.error(`Error polling project "${project.name}":`, err);
    }
  }
}

async function checkProjectForCards(project: ProjectConfig): Promise<void> {
  const { name: projectName, trelloBoardId: boardId } = project;

  // Find list IDs
  const todoList = await findListByName(boardId, "To Do");
  const inProgressList = await findListByName(boardId, "In Progress");

  if (!todoList && !inProgressList) {
    return;
  }

  // Fetch cards from both lists
  const todoCards = todoList ? await getCardsInList(todoList.id) : [];
  const inProgressCards = inProgressList ? await getCardsInList(inProgressList.id) : [];

  if (todoCards.length === 0 && inProgressCards.length === 0) {
    return; // Nothing to do
  }

  // Collect all current card IDs for cleanup
  const currentCardKeys = new Set<string>();

  const allCards = [
    ...todoCards.map((c) => ({ card: c, isRetry: false })),
    ...inProgressCards.map((c) => ({ card: c, isRetry: true })),
  ];

  for (const { card } of allCards) {
    currentCardKeys.add(cardKey(projectName, card.id));
  }

  // Clean up cardStates for cards no longer on the board
  for (const key of cardStates.keys()) {
    if (key.startsWith(`${projectName}:`) && !currentCardKeys.has(key)) {
      const state = cardStates.get(key);
      if (state && !state.inFlight) {
        cardStates.delete(key);
      }
    }
  }

  const actionable = allCards.filter((c) => {
    const key = cardKey(projectName, c.card.id);
    const state = cardStates.get(key);
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
    return; // All cards already being processed or in backoff, stay quiet
  }

  console.log(
    `[${projectName}] Found ${todoCards.length} To-Do card(s), ${inProgressCards.length} In-Progress card(s) (${actionable.length} actionable)`
  );

  // Process actionable cards with concurrency limit
  const queue = [...actionable];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    // Fill up to MAX_CONCURRENT slots
    while (queue.length > 0 && running.length < MAX_CONCURRENT) {
      const item = queue.shift()!;
      const promise = processCard(project, item.card, item.isRetry).then(() => {
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

async function processCard(
  project: ProjectConfig,
  card: { id: string; name: string },
  isRetry: boolean
): Promise<void> {
  if (shuttingDown) return;

  const { name: projectName } = project;
  const key = cardKey(projectName, card.id);
  let state = cardStates.get(key);

  if (!state) {
    state = { attempt: 0, inFlight: false };
    cardStates.set(key, state);
  }

  // Skip if already being processed
  if (state.inFlight) {
    return;
  }

  // For retries, only process if it was a previous failure (has attempt > 0)
  if (isRetry && state.attempt === 0) {
    // This card was moved to In Progress by another process or manually.
    // Treat it as a new task.
    state.attempt = 0;
  }

  state.attempt++;
  state.inFlight = true;

  console.log(
    `\n[${projectName}] Processing card: "${card.name}" (${isRetry ? "retry" : "new"}, attempt ${state.attempt})`
  );

  try {
    // Fetch full card details (with checklists)
    const fullCard = await getCard(card.id);

    const result = await runLocalPipeline(
      project,
      fullCard,
      state.attempt,
      state.lastError
    );

    if (result.success) {
      // Clean up state on success
      cardStates.delete(key);
      console.log(`[${projectName}] Card "${card.name}" completed successfully!`);
    } else {
      state.lastError = result.error;
      state.lastFailedAt = pollCycleCount;
      console.log(`[${projectName}] Card "${card.name}" failed (attempt ${state.attempt}): ${result.error?.slice(0, 200)}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    state.lastFailedAt = pollCycleCount;
    console.error(`[${projectName}] Card "${card.name}" threw: ${message}`);
  } finally {
    state.inFlight = false;
  }
}
