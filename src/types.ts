// --- Task Types ---

export type TaskStatus = "todo" | "in_progress" | "done" | "failed";

export interface TaskAttachment {
  id: string;
  name: string;
  filePath: string;
  mimeType?: string;
  createdAt: string;
}

export interface TaskComment {
  id: string;
  text: string;
  createdAt: string;
  source: "system" | "user";
}

export interface TaskChecklist {
  id: string;
  name: string;
  checkItems: TaskCheckItem[];
}

export interface TaskCheckItem {
  id: string;
  name: string;
  state: "complete" | "incomplete";
}

export interface Task {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  status: TaskStatus;
  checklists: TaskChecklist[];
  attachments: TaskAttachment[];
  comments: TaskComment[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskStore {
  projectName: string;
  tasks: Task[];
  nextSequence: number;
}

// --- GitHub Types ---

export interface PullRequestInfo {
  number: number;
  html_url: string;
  head: { ref: string };
  title: string;
}

// --- Pipeline Types ---

export interface PipelineResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

// --- Multi-Project Types ---

export interface ProjectConfig {
  name: string;
  githubOwner: string;
  githubRepo: string;
  createdAt: string;
  vercelUrl?: string;
}

export interface ProjectRegistry {
  projects: Record<string, ProjectConfig>;
}
