import type { ProjectConfig } from "../types.js";
import { getProject } from "./projects.js";

interface Session {
  projectName: string;
  lastActivity: number;
}

// Session expiry: 1 hour of inactivity
const SESSION_EXPIRY_MS = 60 * 60 * 1000;

// In-memory session storage keyed by chat ID
const sessions = new Map<string, Session>();

function isExpired(session: Session): boolean {
  return Date.now() - session.lastActivity > SESSION_EXPIRY_MS;
}

export function getActiveProject(chatId: string | number): ProjectConfig | null {
  const key = String(chatId);
  const session = sessions.get(key);

  if (!session) {
    return null;
  }

  if (isExpired(session)) {
    sessions.delete(key);
    return null;
  }

  // Update last activity on access
  session.lastActivity = Date.now();

  // Verify project still exists
  const project = getProject(session.projectName);
  if (!project) {
    sessions.delete(key);
    return null;
  }

  return project;
}

export function setActiveProject(chatId: string | number, projectName: string): boolean {
  const key = String(chatId);
  const project = getProject(projectName);

  if (!project) {
    return false;
  }

  sessions.set(key, {
    projectName,
    lastActivity: Date.now(),
  });

  return true;
}

export function ensureActiveProject(chatId: string | number): ProjectConfig | null {
  // Return active project if exists, otherwise null (user must select)
  return getActiveProject(chatId);
}
