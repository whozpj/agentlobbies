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
  connection: string;
  keyEpoch: number;
  roster: Agent[];
}

export interface MyAgent {
  seatKey: string;
  client: string;
  folder: string;
  cwd: string;
  online: boolean;
  machineId?: string;
  machine?: string;
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
  body: string | null; // null: encrypted, and this dashboard can't read it
  inReplyTo: string | null;
  committedAt: number;
}

export interface InvitePreview {
  lobbyName: string | null;
  role: "member" | "viewer";
  invitedBy: string;
}

export type Activity =
  | { type: "message"; lobbyId: string; message: Message }
  | { type: "roster"; lobbyId: string }
  | { type: "connection"; lobbyId: string; state: string }
  | { type: "agents" }
  | { type: "lobbies" };

export const lobbyName = (l: Lobby) => l.name ?? l.lobbyId.slice(0, 8);

// `agentlobbies dashboard` opens the app with a token for the local daemon. Without one, it is the hosted dashboard.
const token = new URLSearchParams(location.search).get("token") ?? "";
export const isHosted = token === "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(isHosted ? path : `${path}?token=${token}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  return body as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const SEAT_ROLE = { owner: "host", member: "member", viewer: "observer" } as const;

/** The local daemon's API, used by `agentlobbies dashboard`. It can read message bodies. */
const local = {
  me: () => request<Me | null>("/api/me"),
  lobbies: () => request<Lobby[]>("/api/lobbies"),
  agents: () => request<MyAgent[]>("/api/agents"),
  messages: (lobbyId: string) => request<Message[]>(`/api/lobbies/${lobbyId}/messages`),
  createLobby: (name: string) => send<{ lobbyId: string }>("POST", "/api/lobbies", { name }),
  invite: (lobbyId: string, role: "member" | "viewer") => send<{ url: string }>("POST", `/api/lobbies/${lobbyId}/invites`, { role }),
  acceptInvite: (invite: string) => send<{ lobbyId: string }>("POST", "/api/invites/accept", { invite }),
  addAgent: (lobbyId: string, agent: MyAgent, owns: string[]) => send("POST", `/api/lobbies/${lobbyId}/agents`, { seatKey: agent.seatKey, owns }),
  removeAgent: (lobbyId: string, agentId: string) => send("DELETE", `/api/lobbies/${lobbyId}/agents/${agentId}`),
  removeMember: (lobbyId: string, login: string) => send("DELETE", `/api/lobbies/${lobbyId}/members/${login}`),
};

interface RelayLobby {
  lobbyId: string;
  name: string | null;
  role: "owner" | "member" | "viewer";
  keyEpoch: number;
  roster: Agent[];
}

interface RelayMachine {
  machineId: string;
  name: string;
  online: boolean;
  agents: Omit<MyAgent, "cwd" | "machineId" | "machine">[];
}

/** The relay's API, used by the hosted dashboard. Messages arrive without their (encrypted) content. */
const relay = {
  me: () => request<Me>("/v1/me").catch(() => null),
  async lobbies(): Promise<Lobby[]> {
    const lobbies = await request<RelayLobby[]>("/v1/lobbies");
    return lobbies.map((l) => ({ lobbyId: l.lobbyId, name: l.name, myRole: SEAT_ROLE[l.role], connection: "live", keyEpoch: l.keyEpoch, roster: l.roster }));
  },
  async agents(): Promise<MyAgent[]> {
    const machines = await request<RelayMachine[]>("/v1/me/agents");
    return machines.flatMap((m) => m.agents.map((a) => ({ ...a, cwd: "", online: m.online && a.online, machineId: m.machineId, machine: m.name })));
  },
  async messages(lobbyId: string): Promise<Message[]> {
    const metadata = await request<Omit<Message, "body">[]>(`/v1/lobbies/${lobbyId}/events`);
    return metadata.map((m) => ({ ...m, body: null }));
  },
  createLobby: (name: string) => send<{ lobbyId: string }>("POST", "/v1/lobbies", { name }),
  invite: (lobbyId: string, role: "member" | "viewer") => send<{ url: string }>("POST", `/v1/lobbies/${lobbyId}/invites`, { role }),
  acceptInvite: (invite: string) => send<{ lobbyId: string }>("POST", "/v1/invites/accept", { token: invite.trim().split("/").pop() }),
  addAgent: (lobbyId: string, agent: MyAgent, owns: string[]) =>
    send("POST", `/v1/lobbies/${lobbyId}/agents`, { machineId: agent.machineId, seatKey: agent.seatKey, owns }),
  removeAgent: (lobbyId: string, agentId: string) => send("DELETE", `/v1/lobbies/${lobbyId}/agents/${agentId}`),
  removeMember: (lobbyId: string, login: string) => send("DELETE", `/v1/lobbies/${lobbyId}/members/${login}`),
};

/** A WebSocket that reconnects after a drop and keeps itself alive with heartbeats. */
function liveSocket(path: string, onFrame: (frame: { t: string; [key: string]: unknown }) => void): () => void {
  let socket: WebSocket | undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const connect = () => {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
    socket.onmessage = (e) => {
      try {
        onFrame(JSON.parse(e.data as string));
      } catch {
        // Not a frame we know; ignore it.
      }
    };
    socket.onopen = () => {
      heartbeat = setInterval(() => socket?.send('{"t":"ping"}'), 20_000);
    };
    socket.onclose = () => {
      clearInterval(heartbeat);
      if (!closed) setTimeout(connect, 2_000);
    };
  };
  connect();

  return () => {
    closed = true;
    clearInterval(heartbeat);
    socket?.close();
  };
}

/** Live updates: everything for the local dashboard; for the hosted one, one lobby or the user's machines. */
function subscribe(onActivity: (activity: Activity) => void, lobbyId?: string): () => void {
  if (!isHosted) {
    const events = new EventSource(`/api/events?token=${token}`);
    events.onmessage = (e) => onActivity(JSON.parse(e.data) as Activity);
    return () => events.close();
  }
  if (lobbyId) {
    return liveSocket(`/v1/lobbies/${lobbyId}/watch`, (frame) => {
      if (frame.t === "meta") onActivity({ type: "message", lobbyId, message: { ...(frame.message as Omit<Message, "body">), body: null } });
      if (frame.t === "roster" || frame.t === "event") onActivity({ type: "roster", lobbyId });
    });
  }
  return liveSocket("/v1/me/live", (frame) => {
    if (frame.t === "machines") onActivity({ type: "agents" });
    if (frame.t === "lobbies") onActivity({ type: "lobbies" });
  });
}

export const api = {
  ...(isHosted ? relay : local),
  subscribe,
  invitePreview: (invite: string) => request<InvitePreview>(`/v1/invites/${invite}`),
  signOut: () => send("POST", "/auth/logout"),
};
