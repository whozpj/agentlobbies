import { decryptContent, ensureDevice, forgetDevice, openLobbyKey, type Device, type Sealed } from "./crypto";

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
  userId?: string; // the hosted dashboard's user, for its device key
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

/** A new name and areas, as typed; the relay turns "Mobile App" into mobile-app. */
export interface AgentChanges {
  handle: string;
  owns: string[];
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

/** People in a lobby, once each: a person has a seat on each of their machines. */
export function peopleIn(lobby: Lobby): Agent[] {
  const byLogin = new Map<string, Agent>();
  for (const seat of lobby.roster) {
    if (seat.client === "cli" && seat.owner && !byLogin.has(seat.owner.login)) byLogin.set(seat.owner.login, seat);
  }
  return [...byLogin.values()];
}

// `agentlobbies dashboard` opens the app with a token for the local daemon. Without one, it is the hosted dashboard.
const token = new URLSearchParams(location.search).get("token") ?? "";
export const isHosted = token === "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(isHosted ? path : `${path}?token=${token}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  return body as T;
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return request<T>(path, init);
}

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
  updateAgent: (lobbyId: string, agentId: string, changes: AgentChanges) => send("PATCH", `/api/lobbies/${lobbyId}/agents/${agentId}`, changes),
  removeAgent: (lobbyId: string, agentId: string) => send("DELETE", `/api/lobbies/${lobbyId}/agents/${agentId}`),
  removeMember: (lobbyId: string, login: string) => send("DELETE", `/api/lobbies/${lobbyId}/members/${login}`),
  deleteLobby: (lobbyId: string) => send("DELETE", `/api/lobbies/${lobbyId}`),
  forgetLobby: (lobbyId: string) => send("POST", `/api/lobbies/${lobbyId}/forget`),
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
/** A message as the relay sends it: metadata, and the content still encrypted. */
interface SealedMessage extends Omit<Message, "body"> {
  fromAgentId: string;
  sealed?: Sealed;
}

/** This browser as one of the signed-in user's devices, set up once they've signed in (LLD 15.11). */
let device: Promise<Device> | undefined;
const lobbyKeys = new Map<string, CryptoKey>(); // "<lobbyId>/<epoch>"

function useDevice(me: Me): void {
  if (!me.userId) return;
  const register = async (boxPublicKey: string) => {
    const name = `Web browser (${navigator.platform || "unknown"})`;
    return (await send<{ machineId: string }>("POST", "/v1/me/devices", { boxPublicKey, name })).machineId;
  };
  device = ensureDevice(me.userId, register);
}

/** The lobby key for an epoch, opened with this browser's device key; undefined until a member machine has shared it. */
async function lobbyKey(lobbyId: string, epoch: number): Promise<CryptoKey | undefined> {
  const cacheKey = `${lobbyId}/${epoch}`;
  if (lobbyKeys.has(cacheKey)) return lobbyKeys.get(cacheKey);
  if (!device) return undefined;
  const { machineId, privateKey } = await device;
  const sealedKeys = await request<{ epoch: number; sealed: string }[]>(`/v1/lobbies/${lobbyId}/keys?device=${machineId}`);
  for (const k of sealedKeys) {
    lobbyKeys.set(`${lobbyId}/${k.epoch}`, await openLobbyKey(privateKey, lobbyId, k.epoch, k.sealed));
  }
  return lobbyKeys.get(cacheKey);
}

/** Decrypts in this browser; the body stays null if the key hasn't reached this device yet or decryption fails. */
async function readMessage(lobbyId: string, m: SealedMessage): Promise<Message> {
  const { fromAgentId, sealed, ...message } = m;
  if (!sealed) return { ...message, body: null };
  try {
    const key = await lobbyKey(lobbyId, sealed.epoch);
    if (!key) return { ...message, body: null };
    const content = await decryptContent(key, { lobbyId, id: m.id, from: fromAgentId, type: m.type, epoch: sealed.epoch }, sealed);
    return { ...message, body: content.body };
  } catch {
    return { ...message, body: null };
  }
}

const relay = {
  async me(): Promise<Me | null> {
    try {
      const me = await request<Me>("/v1/me");
      useDevice(me);
      return me;
    } catch {
      return null;
    }
  },
  async lobbies(): Promise<Lobby[]> {
    const lobbies = await request<RelayLobby[]>("/v1/lobbies");
    return lobbies.map((l) => ({ lobbyId: l.lobbyId, name: l.name, myRole: SEAT_ROLE[l.role], connection: "live", keyEpoch: l.keyEpoch, roster: l.roster }));
  },
  async agents(): Promise<MyAgent[]> {
    const machines = await request<RelayMachine[]>("/v1/me/agents");
    return machines.flatMap((m) => m.agents.map((a) => ({ ...a, cwd: "", online: m.online && a.online, machineId: m.machineId, machine: m.name })));
  },
  async messages(lobbyId: string): Promise<Message[]> {
    const sealed = await request<SealedMessage[]>(`/v1/lobbies/${lobbyId}/events`);
    return Promise.all(sealed.map((m) => readMessage(lobbyId, m)));
  },
  createLobby: (name: string) => send<{ lobbyId: string }>("POST", "/v1/lobbies", { name }),
  invite: (lobbyId: string, role: "member" | "viewer") => send<{ url: string }>("POST", `/v1/lobbies/${lobbyId}/invites`, { role }),
  acceptInvite: (invite: string) => send<{ lobbyId: string }>("POST", "/v1/invites/accept", { token: invite.trim().split("/").pop() }),
  addAgent: (lobbyId: string, agent: MyAgent, owns: string[]) =>
    send("POST", `/v1/lobbies/${lobbyId}/agents`, { machineId: agent.machineId, seatKey: agent.seatKey, owns }),
  updateAgent: (lobbyId: string, agentId: string, changes: AgentChanges) => send("PATCH", `/v1/lobbies/${lobbyId}/agents/${agentId}`, changes),
  removeAgent: (lobbyId: string, agentId: string) => send("DELETE", `/v1/lobbies/${lobbyId}/agents/${agentId}`),
  removeMember: (lobbyId: string, login: string) => send("DELETE", `/v1/lobbies/${lobbyId}/members/${login}`),
  deleteLobby: (lobbyId: string) => send("DELETE", `/v1/lobbies/${lobbyId}`),
  // The web only lists lobbies you belong to, so there is nothing to forget there.
  forgetLobby: async (_lobbyId: string) => {},
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
      if (frame.t === "meta") {
        void readMessage(lobbyId, frame.message as SealedMessage).then((message) => onActivity({ type: "message", lobbyId, message }));
      }
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
  /** Signing out also removes this browser as a device, so it stops receiving lobby keys. */
  async signOut(): Promise<void> {
    if (device) {
      try {
        const { userId, machineId } = await device;
        await send("DELETE", `/v1/me/devices/${machineId}`);
        await forgetDevice(userId);
      } catch {
        // Signing out still works; the device just stays registered.
      }
    }
    await send("POST", "/auth/logout");
  },
};
