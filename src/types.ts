// --- Trello Types ---

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType?: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  shortLink: string;
  idList: string;
  url: string;
  checklists?: TrelloChecklist[];
  attachments?: TrelloAttachment[];
}

export interface TrelloChecklist {
  id: string;
  name: string;
  checkItems: TrelloCheckItem[];
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state: "complete" | "incomplete";
}

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloWebhookPayload {
  action: {
    type: string;
    data: {
      card?: { id: string; name: string; shortLink: string };
      list?: { id: string; name: string };
      listAfter?: { id: string; name: string };
      listBefore?: { id: string; name: string };
      board?: { id: string; name: string };
    };
    memberCreator?: { fullName: string };
  };
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
  trelloBoardId: string;
  githubOwner: string;
  githubRepo: string;
  createdAt: string;
  vercelUrl?: string;
}

export interface ProjectRegistry {
  projects: Record<string, ProjectConfig>;
  defaultProject?: string;
}
