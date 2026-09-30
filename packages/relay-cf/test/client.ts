import { toB64u, type JoinProfile, type ServerFrame } from "@agentlobbies/protocol";
import { exports } from "cloudflare:workers";
import { newAgent } from "./helpers";

const BASE = "https://relay.test";

export function api(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(BASE + path, init));
}

/** A random client IP, so tests don't share the per-IP rate limits. */
export function randomIp(): string {
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join(".");
}

export function postJson(path: string, body: unknown, ip = randomIp(), accountToken?: string): Promise<Response> {
  return api(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(accountToken ? { authorization: `Bearer ${accountToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const realFetch = globalThis.fetch;

/** Stands in for api.github.com: a token "gho_fake_<login>" belongs to user <login>. */
export function fakeGitHub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.github.com") return realFetch(input, init);
    const auth = new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "";
    const login = auth.match(/gho_fake_([\w-]+)/)?.[1];
    if (!login) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    const id = [...login].reduce((n, c) => n * 31 + c.charCodeAt(0), 7) % 1_000_000_000;
    return Response.json({ id, login, avatar_url: `https://avatars.githubusercontent.com/u/${id}` });
  }) as typeof fetch;
}

export interface Account {
  token: string;
  userId: string;
  machineId: string;
  machineKeys: Awaited<ReturnType<typeof newAgent>>["keys"];
}

export async function signIn(login: string): Promise<Account> {
  const { keys } = await newAgent("machine");
  const res = await postJson("/v1/auth/github", { githubToken: `gho_fake_${login}`, machinePublicKey: toB64u(keys.publicKey), machineName: "test-mac" });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ token: string; user: { userId: string }; machineId: string }>();
  return { token: body.token, userId: body.user.userId, machineId: body.machineId, machineKeys: keys };
}

/** A lobby agent as the relay sees it after create or join. */
export interface Seat {
  lobbyId: string;
  agentId: string;
  token: string;
  keys: Awaited<ReturnType<typeof newAgent>>["keys"];
  profile: JoinProfile;
}

export type Lobby = Seat & { account: Account };

/** Creates a lobby as `owner` (a fresh user by default); the returned seat is the owner's person seat. */
export async function createLobby(handle = "host", owner?: Account): Promise<Lobby> {
  const a = await newAgent(handle, "cli");
  const account = owner ?? (await signIn(`owner-${handle}`));
  const res = await postJson("/v1/lobbies", { host: a.profile }, randomIp(), account.token);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ lobbyId: string; agentId: string; token: string }>();
  return { ...body, keys: a.keys, profile: a.profile, account };
}

/** `owner` places one of their agents into the lobby (they must be a member). */
export async function addAgent(lobbyId: string, handle: string, owner: Account): Promise<Seat> {
  const a = await newAgent(handle);
  const res = await postJson(`/v1/lobbies/${lobbyId}/agents`, { agent: a.profile }, randomIp(), owner.token);
  if (res.status !== 201) throw new Error(`add failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ lobbyId: string; agentId: string; token: string }>();
  return { ...body, keys: a.keys, profile: a.profile };
}

export async function createInvite(lobby: Lobby, options: Record<string, unknown> = {}): Promise<{ token: string; url: string }> {
  const res = await postJson(`/v1/lobbies/${lobby.lobbyId}/invites`, options, randomIp(), lobby.account.token);
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function acceptInvite(token: string, person: Account, handle: string): Promise<Response> {
  return newAgent(handle, "cli").then((a) => postJson("/v1/invites/accept", { token, person: a.profile }, randomIp(), person.token));
}

/** Invites `person` into `lobby` and returns their account, now a member. */
export async function member(lobby: Lobby, login: string): Promise<Account> {
  const account = await signIn(login);
  const { token } = await createInvite(lobby);
  const res = await acceptInvite(token, account, login);
  if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${await res.text()}`);
  return account;
}

/** A WebSocket to the relay that records every frame it receives. */
export class TestSocket {
  frames: ServerFrame[] = [];
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (m) => {
      this.frames.push(JSON.parse(m.data as string));
      this.waiters.forEach((w) => w());
    });
    ws.addEventListener("close", (c) => {
      this.closeCode = c.code;
      this.waiters.forEach((w) => w());
    });
  }

  static async open(seat: Pick<Seat, "lobbyId" | "token">): Promise<TestSocket> {
    const res = await api(`/v1/lobbies/${seat.lobbyId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `agentlobbies.v1, bearer.${seat.token}` },
    });
    if (!res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
    return new TestSocket(res.webSocket);
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Resolves with the first recorded frame matching `predicate`, waiting up to 2 s. */
  async next<T extends ServerFrame["t"]>(t: T, predicate: (f: Extract<ServerFrame, { t: T }>) => boolean = () => true) {
    const find = () => this.frames.find((f): f is Extract<ServerFrame, { t: T }> => f.t === t && predicate(f as Extract<ServerFrame, { t: T }>));
    for (const deadline = Date.now() + 2000; Date.now() < deadline; ) {
      const found = find();
      if (found) return found;
      await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 50); });
    }
    throw new Error(`no ${t} frame; got ${JSON.stringify(this.frames.map((f) => f.t))}`);
  }

  async closed(): Promise<number> {
    for (const deadline = Date.now() + 2000; Date.now() < deadline && this.closeCode === undefined; ) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 50); });
    }
    if (this.closeCode === undefined) throw new Error("socket did not close");
    return this.closeCode;
  }

  /** Sends hello and waits until replay is finished (the last events page). */
  async hello(afterSeq = 0) {
    this.send({ t: "hello", v: 1, afterSeq, clientVersion: "0.3.0" });
    await this.next("events", (f) => !f.more);
    return this.frames.find((f) => f.t === "welcome") as Extract<ServerFrame, { t: "welcome" }>;
  }
}

export { toB64u };
