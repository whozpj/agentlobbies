export interface Agent {
  agentId: string;
  handle: string;
  client: string;
  model?: string;
  owns: string[];
  workingOn: string;
  status: "active" | "busy" | "idle" | "offline";
  role: "host" | "member" | "observer";
}

export interface Lobby {
  lobbyId: string;
  name: string | null;
  local: { handle: string; role: string }[];
  connection: string;
  roster: Agent[];
}

export interface Message {
  id: string;
  seq: number;
  from: string;
  to: string;
  type: "question" | "answer" | "update";
  body: string;
  inReplyTo: string | null;
  committedAt: number;
}

export interface JoinRequest {
  id: string;
  client: string;
  handle: string;
  code: string;
  owns: string[];
}

export type Activity =
  | { type: "message"; lobbyId: string; message: Message }
  | { type: "roster"; lobbyId: string }
  | { type: "connection"; lobbyId: string; state: string }
  | { type: "approvals" };

const token = new URLSearchParams(location.search).get("token") ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${path}?token=${token}`, init);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  lobbies: () => request<Lobby[]>("/api/lobbies"),
  messages: (lobbyId: string) => request<Message[]>(`/api/lobbies/${lobbyId}/messages`),
  approvals: () => request<JoinRequest[]>("/api/approvals"),
  decide: (id: string, approve: boolean) =>
    request(`/api/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) }),
  subscribe(onActivity: (activity: Activity) => void): () => void {
    const events = new EventSource(`/api/events?token=${token}`);
    events.onmessage = (e) => onActivity(JSON.parse(e.data) as Activity);
    return () => events.close();
  },
};
