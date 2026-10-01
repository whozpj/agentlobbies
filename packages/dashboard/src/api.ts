export interface Agent {
  agentId: string;
  handle: string;
  client: string;
  model?: string;
  owns: string[];
  workingOn: string;
  status: "active" | "busy" | "idle" | "offline";
  role: "host" | "member" | "observer";
  owner?: { login: string; avatarUrl: string };
}

export interface Lobby {
  lobbyId: string;
  name: string | null;
  myRole: "host" | "member" | "observer" | null;
  local: { handle: string; agentId: string; seatKey: string }[];
  connection: string;
  roster: Agent[];
}

export interface MyAgent {
  seatKey: string;
  client: string;
  folder: string;
  cwd: string;
  online: boolean;
  lobbies: { lobbyId: string; name: string | null; handle: string; agentId: string }[];
}

export interface Me {
  login: string;
  avatarUrl: string;
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

export type Activity =
  | { type: "message"; lobbyId: string; message: Message }
  | { type: "roster"; lobbyId: string }
  | { type: "connection"; lobbyId: string; state: string }
  | { type: "agents" }
  | { type: "lobbies" };

const token = new URLSearchParams(location.search).get("token") ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${path}?token=${token}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  me: () => request<Me | null>("/api/me"),
  lobbies: () => request<Lobby[]>("/api/lobbies"),
  agents: () => request<MyAgent[]>("/api/agents"),
  messages: (lobbyId: string) => request<Message[]>(`/api/lobbies/${lobbyId}/messages`),
  createLobby: (name: string) => post<{ lobbyId: string }>("/api/lobbies", { name }),
  invite: (lobbyId: string, role: "member" | "viewer") => post<{ url: string; expiresAt: number }>(`/api/lobbies/${lobbyId}/invites`, { role }),
  acceptInvite: (invite: string) => post<{ lobbyId: string }>("/api/invites/accept", { invite }),
  addAgent: (lobbyId: string, seatKey: string, owns: string[]) => post<{ handle: string }>(`/api/lobbies/${lobbyId}/agents`, { seatKey, owns }),
  removeAgent: (lobbyId: string, agentId: string) => request(`/api/lobbies/${lobbyId}/agents/${agentId}`, { method: "DELETE" }),
  subscribe(onActivity: (activity: Activity) => void): () => void {
    const events = new EventSource(`/api/events?token=${token}`);
    events.onmessage = (e) => onActivity(JSON.parse(e.data) as Activity);
    return () => events.close();
  },
};

export const lobbyName = (l: Lobby) => l.name ?? l.lobbyId.slice(0, 8);
