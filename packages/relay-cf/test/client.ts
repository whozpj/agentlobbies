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

export function postJson(path: string, body: unknown, ip = randomIp()): Promise<Response> {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

/** A lobby agent as the relay sees it after create or join. */
export interface Seat {
  lobbyId: string;
  agentId: string;
  token: string;
  keys: Awaited<ReturnType<typeof newAgent>>["keys"];
  profile: JoinProfile;
}

export async function createLobby(handle = "host"): Promise<Seat & { code: string }> {
  const a = await newAgent(handle);
  const res = await postJson("/v1/lobbies", { host: a.profile });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ lobbyId: string; agentId: string; token: string; code: string }>();
  return { ...body, keys: a.keys, profile: a.profile };
}

export async function joinLobby(code: string, handle: string): Promise<Seat> {
  const a = await newAgent(handle);
  const res = await postJson("/v1/join", { code, agent: a.profile });
  if (res.status !== 200) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ lobbyId: string; agentId: string; token: string }>();
  return { ...body, keys: a.keys, profile: a.profile };
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
    this.send({ t: "hello", v: 1, afterSeq, clientVersion: "0.1.0" });
    await this.next("events", (f) => !f.more);
    return this.frames.find((f) => f.t === "welcome") as Extract<ServerFrame, { t: "welcome" }>;
  }
}

export { toB64u };
