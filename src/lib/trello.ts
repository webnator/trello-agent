import type { TrelloCard, TrelloList } from "../types.js";

const BASE_URL = "https://api.trello.com/1";

function authParams(): URLSearchParams {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("Missing TRELLO_API_KEY or TRELLO_TOKEN");
  return new URLSearchParams({ key, token });
}

async function trelloFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  const params = authParams();
  // Merge any existing search params
  for (const [k, v] of params) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Trello API error ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export async function getCard(cardId: string): Promise<TrelloCard> {
  return trelloFetch<TrelloCard>(
    `/cards/${cardId}?checklists=all&attachments=true`
  );
}

export async function getLists(boardId: string): Promise<TrelloList[]> {
  return trelloFetch<TrelloList[]>(`/boards/${boardId}/lists`);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function findListByName(
  boardId: string,
  name: string
): Promise<TrelloList | undefined> {
  const lists = await getLists(boardId);
  const target = normalize(name);
  return lists.find((l) => normalize(l.name) === target);
}

export async function moveCard(
  cardId: string,
  listId: string
): Promise<void> {
  await trelloFetch(`/cards/${cardId}`, {
    method: "PUT",
    body: JSON.stringify({ idList: listId }),
  });
}

export async function addComment(
  cardId: string,
  text: string
): Promise<void> {
  const url = new URL(`${BASE_URL}/cards/${cardId}/actions/comments`);
  const params = authParams();
  for (const [k, v] of params) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Trello comment error ${res.status}: ${body}`);
  }
}

export async function getCardsInList(listId: string): Promise<TrelloCard[]> {
  return trelloFetch<TrelloCard[]>(`/lists/${listId}/cards?checklists=all`);
}

export async function createCard(
  listId: string,
  name: string,
  desc?: string
): Promise<TrelloCard> {
  const body: Record<string, string> = { idList: listId, name };
  if (desc) body.desc = desc;
  return trelloFetch<TrelloCard>("/cards", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function addAttachment(
  cardId: string,
  url: string,
  name?: string
): Promise<void> {
  const authUrl = new URL(`${BASE_URL}/cards/${cardId}/attachments`);
  const params = authParams();
  for (const [k, v] of params) authUrl.searchParams.set(k, v);

  const body: Record<string, string> = { url };
  if (name) body.name = name;

  const res = await fetch(authUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Trello attachment error ${res.status}: ${errorBody}`);
  }
}

interface TrelloBoard {
  id: string;
  name: string;
  url: string;
}

export async function createBoard(name: string): Promise<TrelloBoard> {
  const board = await trelloFetch<TrelloBoard>("/boards", {
    method: "POST",
    body: JSON.stringify({
      name,
      defaultLists: false,
    }),
  });

  // Create standard lists in order (they appear in reverse order of creation)
  const lists = ["Failed", "Done", "In Progress", "To Do"];
  for (const listName of lists) {
    await trelloFetch(`/boards/${board.id}/lists`, {
      method: "POST",
      body: JSON.stringify({ name: listName }),
    });
  }

  return board;
}
