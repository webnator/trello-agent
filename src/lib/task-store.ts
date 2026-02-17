import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Task, TaskStore, TaskStatus, TaskAttachment, TaskComment } from "../types.js";

// --- Data directory ---

function getDataDir(): string {
  if (process.env.PROJECTS_FILE) {
    // Derive data dir from projects file location
    return path.join(path.dirname(process.env.PROJECTS_FILE), "data");
  }
  const home = process.env.HOME || "/root";
  return path.join(home, ".task-agent", "data");
}

function getStorePath(projectName: string): string {
  return path.join(getDataDir(), projectName, "tasks.json");
}

function getAttachmentsDir(projectName: string, taskId: string): string {
  return path.join(getDataDir(), projectName, "attachments", taskId);
}

// --- ID generation ---

function generateId(): string {
  const bytes = crypto.randomBytes(6);
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < 7; i++) {
    result += chars[bytes[i % bytes.length] % chars.length];
  }
  return result;
}

// --- In-memory cache with mtime invalidation ---

const cache = new Map<string, { store: TaskStore; mtimeMs: number }>();

function loadStore(projectName: string): TaskStore {
  const filePath = getStorePath(projectName);

  // Check cache validity
  const cached = cache.get(projectName);
  if (cached) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs === cached.mtimeMs) {
        return cached.store;
      }
    } catch {
      // File may have been deleted
    }
  }

  if (!fs.existsSync(filePath)) {
    const empty: TaskStore = { projectName, tasks: [], nextSequence: 1 };
    return empty;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const store = JSON.parse(content) as TaskStore;
  const stat = fs.statSync(filePath);
  cache.set(projectName, { store, mtimeMs: stat.mtimeMs });
  return store;
}

function saveStore(projectName: string, store: TaskStore): void {
  const filePath = getStorePath(projectName);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to .tmp then rename
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, filePath);

  const stat = fs.statSync(filePath);
  cache.set(projectName, { store, mtimeMs: stat.mtimeMs });
}

// --- Public API ---

export function initTaskStore(projectName: string): void {
  const existing = loadStore(projectName);
  if (existing.tasks.length > 0) {
    return; // Already initialized
  }
  saveStore(projectName, { projectName, tasks: [], nextSequence: 1 });
}

export function createTask(projectName: string, name: string, desc?: string): Task {
  const store = loadStore(projectName);
  const id = generateId();
  const now = new Date().toISOString();

  const task: Task = {
    id,
    shortLink: id,
    name,
    desc: desc || "",
    status: "todo",
    checklists: [],
    attachments: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };

  store.tasks.push(task);
  store.nextSequence++;
  saveStore(projectName, store);
  return task;
}

export function getTask(projectName: string, taskId: string): Task | undefined {
  const store = loadStore(projectName);
  return store.tasks.find((t) => t.id === taskId);
}

export function getTasksByStatus(projectName: string, status: TaskStatus): Task[] {
  const store = loadStore(projectName);
  return store.tasks.filter((t) => t.status === status);
}

export function updateTaskStatus(projectName: string, taskId: string, status: TaskStatus): void {
  const store = loadStore(projectName);
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in project ${projectName}`);
  task.status = status;
  task.updatedAt = new Date().toISOString();
  saveStore(projectName, store);
}

export function addTaskComment(projectName: string, taskId: string, text: string, source: "system" | "user" = "system"): void {
  const store = loadStore(projectName);
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in project ${projectName}`);

  task.comments.push({
    id: generateId(),
    text,
    createdAt: new Date().toISOString(),
    source,
  });
  task.updatedAt = new Date().toISOString();
  saveStore(projectName, store);
}

export async function addTaskAttachment(
  projectName: string,
  taskId: string,
  url: string,
  name?: string
): Promise<TaskAttachment> {
  const store = loadStore(projectName);
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in project ${projectName}`);

  const dir = getAttachmentsDir(projectName, taskId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Download file from URL
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const fileName = (name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, Buffer.from(buffer));

  // Detect mime type from response headers
  const mimeType = response.headers.get("content-type") || undefined;

  const attachment: TaskAttachment = {
    id: generateId(),
    name: fileName,
    filePath,
    mimeType,
    createdAt: new Date().toISOString(),
  };

  task.attachments.push(attachment);
  task.updatedAt = new Date().toISOString();
  saveStore(projectName, store);
  return attachment;
}

export function getAllTasks(projectName: string): Task[] {
  const store = loadStore(projectName);
  return store.tasks;
}

export function getAttachmentPaths(task: Task): string[] {
  return task.attachments.map((a) => a.filePath);
}
