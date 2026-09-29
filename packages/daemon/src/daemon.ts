import {
  refreshSigningBytes, signEnvelope, generateSeatKeys, toB64u, webCrypto,
  type AgentProfile, type Envelope, type LobbyEvent, type Recipient, type ServerFrame,
} from "@agentlobbies/protocol";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { Connection, type ConnectionState } from "./connection";
import { openDb, type Db, type JoinRequest, type Seat } from "./db";
import { findSecret } from "./guard";
import { loadKey, saveKey } from "./keys";
import { DaemonError } from "./rpc";

export const CLIENT_VERSION = "0.1.1";

interface Session {
  client: string;
  cwd: string;
  seatKey: string;
}

type Params = Record<string, unknown>;
type OkOrErr = Extract<ServerFrame, { t: "ok" | "err" }>;

/** A message as handed to an MCP server or the CLI. */
export interface SurfacedMessage {
  id: string;
  seq: number;
  from: string;
  fromAgentId: string;
  fromClient?: string;
  fromModel?: string;
  type: Envelope["type"];
  to: Recipient;
  body: string;
  inReplyTo?: string;
  attachments?: Envelope["attachments"];
}

function expiresWithinAnHour(jwt: string): boolean {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { exp: number };
    return exp * 1000 - Date.now() < 3_600_000;
  } catch {
    return true;
  }
}

/** Same client in the same folder gets the same identity back (LLD 7.1). */
export function seatKeyFor(client: string, cwd: string): string {
  const input = [client, realpathSync(cwd), process.env.AGENTLOBBIES_SEAT ?? ""].join("\0");
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/**
 * Owns every seat on this machine: keys, relay connections, inbox, and outbox (LLD 7).
 * MCP servers and the CLI talk to it through `call()` (over the RPC socket in production).
 * Emits "notify" with { method, params } for push notifications.
 */
export class Daemon extends EventEmitter {
  private db!: Db;
  private running = false;
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Map<string, Connection>();
  private readonly waiters = new Map<string, (frame: OkOrErr) => void>();
  private readonly rejectedTokens = new Set<string>();
  private readonly pendingAcks = new Map<string, { seq: number; count: number; timer: NodeJS.Timeout; conn: Connection }>();
  private readonly inboxWaiters = new Map<string, (result: { unread: number } | { cancelled: true }) => void>();

  constructor(private readonly opts: { home: string; relayUrl: string; agentJoin?: "confirm" | "allow" }) {
    super();
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.home, { recursive: true, mode: 0o700 });
    this.db = openDb(join(this.opts.home, "daemon.db"));
    this.running = true;
    for (const seat of this.db.activeSeats()) this.connect(seat);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    for (const seatId of [...this.pendingAcks.keys()]) this.flushAck(seatId);
    this.running = false;
    for (const conn of this.connections.values()) conn.stop();
    this.connections.clear();
    this.db.close();
  }

  async call(method: string, params: Params): Promise<any> {
    const handler = this.methods[method];
    if (!handler) throw new DaemonError("method_not_found", `unknown method ${method}`);
    return handler(params);
  }


  private readonly methods: Record<string, (p: Params) => Promise<unknown>> = {
    "daemon.info": async () => ({ version: CLIENT_VERSION, pid: process.pid, seats: this.db.activeSeats().length }),

    "daemon.shutdown": async () => {
      setImmediate(() => this.emit("shutdown"));
      return {};
    },

    "session.open": async (p) => {
      const client = String(p.client ?? "custom");
      const cwd = String(p.cwd ?? process.cwd());
      const sessionId = randomUUID();
      const seatKey = seatKeyFor(client, cwd);
      this.sessions.set(sessionId, { client, cwd, seatKey });
      const seat = this.db.activeSeat(seatKey);
      return { sessionId, seatKey, lobby: seat ? { lobbyId: seat.lobby_id, handle: seat.handle } : null };
    },

    "session.close": async (p) => {
      this.sessions.delete(String(p.sessionId));
      return {};
    },

    "lobby.create": async (p) => {
      const session = this.session(p);
      const keys = await generateSeatKeys();
      const profile = this.profile(session, p, toB64u(keys.publicKey));
      const res = await this.relay<{ lobbyId: string; agentId: string; token: string; code: string; codeExpiresAt: number }>(
        "/v1/lobbies", { host: profile, settings: p.name ? { name: String(p.name) } : {} },
      );
      this.addSeat(session.seatKey, { lobbyId: res.lobbyId, lobbyName: p.name ? String(p.name) : null, agentId: res.agentId,
                              handle: profile.handle, role: "host", token: res.token }, keys.secretKey);
      return { lobbyId: res.lobbyId, code: res.code, codeExpiresAt: res.codeExpiresAt, handle: profile.handle };
    },

    "lobby.join": async (p) => {
      const session = this.session(p);
      const request = { id: ulid(), seat_key: session.seatKey, client: session.client, code: String(p.code ?? ""),
                        handle: String(p.handle ?? ""), owns: (p.owns as string[] | undefined) ?? [] };
      // An agent can't let itself into a lobby; its human approves with `agentlobbies approve` (G42).
      if (p.source === "agent" && (this.opts.agentJoin ?? "confirm") === "confirm") {
        this.db.addJoinRequest(request);
        this.emit("notify", { method: "approval.pending", params: { scope: "join" } });
        throw new DaemonError("join_pending", "Ask your user to approve this join with `agentlobbies approve`.");
      }
      return this.join(request);
    },

    "lobby.code": async (p) => {
      const seat = this.seat(p);
      return this.relay(`/v1/lobbies/${seat.lobby_id}/codes`, {
        role: p.role ?? "member",
        ...(p.ttlMs ? { ttlMs: Number(p.ttlMs) } : {}),
        ...(p.maxUses ? { maxUses: Number(p.maxUses) } : {}),
      }, seat.jwt);
    },

    "approval.list": async (p) => (p.scope === "join" ? this.db.joinRequests() : []),

    "approval.decide": async (p) => {
      const request = this.db.joinRequests().find((r) => r.id === p.id);
      if (!request) throw new DaemonError("not_found", "no such request");
      this.db.deleteJoinRequest(request.id);
      return p.approve ? this.join(request) : {};
    },

    "lobby.status": async (p) => {
      const seat = this.seat(p);
      return {
        lobbyId: seat.lobby_id, lobbyName: seat.lobby_name, handle: seat.handle, role: seat.role,
        connection: this.connections.get(seat.seat_id)?.state ?? "stopped", unread: this.db.unreadCount(seat.seat_id),
      };
    },

    "lobby.players": async (p) => this.db.roster(this.seat(p).seat_id),

    "message.send": async (p) => this.sendMessage(this.seat(p), p),

    "inbox.pull": async (p) => {
      const seat = this.seat(p);
      if (p.messageId) {
        const envelope = this.db.findEnvelope(seat.seat_id, String(p.messageId));
        if (!envelope) throw new DaemonError("not_found", `no message with id ${p.messageId}`);
        this.db.markSurfaced(seat.seat_id, envelope.id);
        return [this.surface(seat, this.db.findEvent(seat.seat_id, envelope.id)!)];
      }
      const limit = Math.min(Number(p.limit ?? 10), 25);
      return this.db.takeUnread(seat.seat_id, limit).map((e) => this.surface(seat, e));
    },

    "inbox.peek": async (p) => ({ unread: this.db.unreadCount(this.seat(p).seat_id) }),

    // One waiter per seat: a newer wait (the next idle period) replaces the older one.
    "inbox.wait": async (p) => {
      const seatId = this.seat(p).seat_id;
      const unread = this.db.unreadCount(seatId);
      if (unread > 0) return { unread };
      this.inboxWaiters.get(seatId)?.({ cancelled: true });
      return new Promise((resolve) => {
        const finish = (result: { unread: number } | { cancelled: true }) => {
          clearTimeout(timer);
          if (this.inboxWaiters.get(seatId) === finish) this.inboxWaiters.delete(seatId);
          resolve(result);
        };
        const timer = setTimeout(() => finish({ unread: 0 }), Number(p.timeoutMs ?? 60_000));
        this.inboxWaiters.set(seatId, finish);
      });
    },

    "presence.set": async (p) => {
      const seat = this.seat(p);
      const status = (p.status ?? "active") as "active" | "busy" | "idle";
      this.connections.get(seat.seat_id)?.send({ t: "presence", status, workingOn: String(p.workingOn ?? "") });
      return {};
    },
  };


  private async join(r: Omit<JoinRequest, "id">): Promise<{ lobbyId: string; handle: string; role: string }> {
    const keys = await generateSeatKeys();
    const profile = { handle: r.handle, client: r.client as AgentProfile["client"], owns: r.owns, workingOn: "", publicKey: toB64u(keys.publicKey) };
    const res = await this.relay<{ lobbyId: string; agentId: string; token: string; role: "member" | "observer"; handle: string }>(
      "/v1/join", { code: r.code, agent: profile },
    );
    this.addSeat(r.seat_key, { lobbyId: res.lobbyId, lobbyName: null, agentId: res.agentId, handle: res.handle,
                               role: res.role, token: res.token }, keys.secretKey);
    return { lobbyId: res.lobbyId, handle: res.handle, role: res.role };
  }

  private async sendMessage(seat: Seat, p: Params): Promise<{ id: string; seq?: number; held?: boolean; queued?: boolean }> {
    const body = String(p.body ?? "");
    const attachments = (p.attachments ?? undefined) as Envelope["attachments"];
    const secret = findSecret([body, ...(attachments ?? []).map((a) => a.content)].join("\n"));
    if (secret && !p.allowSecret) throw new DaemonError("secret_detected", `message contains what looks like a secret (${secret})`);

    const inReplyTo = p.inReplyTo ? String(p.inReplyTo) : undefined;
    const parent = inReplyTo ? this.db.findEnvelope(seat.seat_id, inReplyTo) : undefined;
    if (inReplyTo && !parent) throw new DaemonError("bad_reply", `no message with id ${inReplyTo}`);

    const envelope = await signEnvelope(webCrypto, loadKey(this.opts.home, seat.seat_id), {
      v: 1, id: ulid(), lobbyId: seat.lobby_id, from: seat.agent_id,
      to: p.to === undefined && parent ? { kind: "direct", agentId: parent.from } : this.resolveTo(seat, String(p.to ?? "all")),
      type: (p.type ?? "update") as Envelope["type"], threadDepth: parent ? parent.threadDepth + 1 : 0,
      body, createdAt: Date.now(),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(attachments ? { attachments } : {}),
    });

    // The outbox keeps the signed frame, so retries after a reconnect reuse the same envelope id (I5).
    const reqId = ulid();
    const frame = { t: "send" as const, reqId, envelope };
    this.db.addOutbox(reqId, seat.seat_id, frame);
    this.db.touchSeat(seat.seat_id, Date.now());
    const conn = this.connections.get(seat.seat_id);
    if (conn?.state === "live") conn.send(frame);

    const reply = await this.waitForReply(reqId);
    if (!reply) return { id: envelope.id, queued: true };
    if (reply.t === "err") throw new DaemonError(reply.code, reply.message);
    return { id: envelope.id, ...(reply.seq ? { seq: reply.seq } : {}), ...(reply.held ? { held: true } : {}) };
  }

  private waitForReply(reqId: string): Promise<OkOrErr | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(reqId);
        resolve(undefined);
      }, 10_000);
      this.waiters.set(reqId, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  /** "all", "#topic", "owner:<area>", or a handle (LLD 7.7). */
  private resolveTo(seat: Seat, to: string): Recipient {
    if (to === "all") return { kind: "broadcast" };
    if (to.startsWith("#")) return { kind: "topic", topic: to.slice(1) };

    const others = this.db.roster(seat.seat_id).filter((a) => a.agentId !== seat.agent_id);
    const members = others.map((a) => `${a.handle} (${a.owns.join(", ") || "no areas"})`).join("; ");
    if (to.startsWith("owner:")) {
      const area = to.slice("owner:".length);
      const owner = others.filter((a) => a.owns.includes(area)).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
      if (!owner) throw new DaemonError("no_owner", `no member owns '${area}'. Members: ${members || "none"}`);
      return { kind: "direct", agentId: owner.agentId };
    }
    const target = others.find((a) => a.handle === to);
    if (!target) throw new DaemonError("unknown_recipient", `no member named '${to}'. Members: ${members || "none"}`);
    return { kind: "direct", agentId: target.agentId };
  }


  private connect(seat: Seat): void {
    const conn: Connection = new Connection({
      url: `${seat.relay_url.replace(/^http/, "ws")}/v1/lobbies/${seat.lobby_id}/ws`,
      token: () => this.tokenFor(seat.seat_id),
      onRejected: () => this.rejectedTokens.add(seat.seat_id),
      clientVersion: CLIENT_VERSION,
      cursor: () => this.db.cursor(seat.seat_id),
      onFrame: (frame): void => this.onFrame(seat, conn, frame),
      onState: (state): void => this.onState(seat, conn, state),
    });
    this.connections.set(seat.seat_id, conn);
    void conn.start();
  }

  /** The seat's token, refreshed with a signature from its key when it's expiring or was refused (C6). */
  private async tokenFor(seatId: string): Promise<string> {
    const seat = this.db.seat(seatId);
    if (!this.rejectedTokens.has(seatId) && !expiresWithinAnHour(seat.jwt)) return seat.jwt;

    const ts = Date.now();
    const sig = await webCrypto.sign(loadKey(this.opts.home, seatId), refreshSigningBytes({ lobbyId: seat.lobby_id, agentId: seat.agent_id, ts }));
    try {
      const { token } = await this.relay<{ token: string }>(`/v1/lobbies/${seat.lobby_id}/token`, { agentId: seat.agent_id, ts, sig: toB64u(sig) });
      this.db.setJwt(seatId, token);
      this.rejectedTokens.delete(seatId);
      return token;
    } catch (e) {
      if (e instanceof DaemonError && e.code === "kicked") {
        this.db.setSeatState(seatId, "kicked");
        this.connections.get(seatId)?.stop();
      }
      throw e;
    }
  }

  private onState(seat: Seat, conn: Connection, state: ConnectionState): void {
    if (!this.running) return;
    if (state === "live") {
      for (const frame of this.db.pendingOutbox(seat.seat_id)) conn.send(frame as never);
    }
    if (state === "kicked" || state === "closed" || state === "upgrade_required") {
      this.db.setSeatState(seat.seat_id, state);
    }
    this.emit("notify", { method: "seat.state", params: { seatId: seat.seat_id, state } });
  }

  private onFrame(seat: Seat, conn: Connection, frame: ServerFrame): void {
    if (!this.running) return;
    switch (frame.t) {
      case "welcome":
        this.db.replaceRoster(seat.seat_id, frame.roster);
        return;
      case "roster":
        this.db.upsertRoster(seat.seat_id, [frame.agent]);
        return;
      case "events":
        this.store(seat, frame.events);
        if (frame.events.length > 0) conn.send({ t: "ack", seq: frame.events.at(-1)!.seq });
        if (frame.more) conn.send({ t: "replay.more", afterSeq: frame.events.at(-1)?.seq ?? this.db.cursor(seat.seat_id) });
        return;
      case "event":
        this.store(seat, [frame.event]);
        this.ackSoon(seat.seat_id, conn, frame.event.seq);
        return;
      case "ok":
      case "err":
        if (frame.reqId) this.onReply(seat, frame);
        return;
    }
  }

  /** Stores events and moves the cursor. Callers ack only after this, so a crash can only cause a harmless redelivery (I13). */
  private store(seat: Seat, events: LobbyEvent[]): void {
    if (events.length === 0) return;
    this.db.ingest(seat.seat_id, events);
    for (const e of events) {
      if (e.kind === "system" && e.system.type === "joined") this.db.addToRoster(seat.seat_id, e.system.agent);
      if (e.kind === "system" && e.system.type === "left") this.db.removeFromRoster(seat.seat_id, e.system.agentId);
    }
    const last = events.at(-1)!.seq;
    this.db.setCursor(seat.seat_id, last);
    const unread = this.db.unreadCount(seat.seat_id);
    if (unread > 0) {
      this.inboxWaiters.get(seat.seat_id)?.({ unread });
      this.emit("notify", { method: "inbox.new", params: { seatId: seat.seat_id, unread } });
    }
  }

  /** Acks live events every 250 ms or 20 events, whichever comes first, to save relay writes (LLD 7.5). */
  private ackSoon(seatId: string, conn: Connection, seq: number): void {
    const pending = this.pendingAcks.get(seatId) ?? { seq, count: 0, conn, timer: setTimeout(() => this.flushAck(seatId), 250) };
    pending.seq = seq;
    pending.count++;
    this.pendingAcks.set(seatId, pending);
    if (pending.count >= 20) this.flushAck(seatId);
  }

  private flushAck(seatId: string): void {
    const pending = this.pendingAcks.get(seatId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(seatId);
    pending.conn.send({ t: "ack", seq: pending.seq });
  }

  private onReply(seat: Seat, frame: OkOrErr): void {
    const reqId = frame.reqId!;
    this.db.finishOutbox(reqId, frame.t === "ok" ? "done" : "failed");
    if (frame.t === "ok" && frame.seq) {
      const sent = this.db.outboxFrame(reqId) as { envelope: Envelope } | undefined;
      if (sent) this.db.recordOwn(seat.seat_id, { kind: "message", seq: frame.seq, committedAt: Date.now(), envelope: sent.envelope });
    }
    this.waiters.get(reqId)?.(frame);
    this.waiters.delete(reqId);
  }


  private surface(seat: Seat, e: LobbyEvent): SurfacedMessage {
    if (e.kind !== "message") throw new Error("only messages are surfaced");
    const env = e.envelope;
    const sender = this.db.roster(seat.seat_id).find((a) => a.agentId === env.from);
    return {
      id: env.id, seq: e.seq, from: sender?.handle ?? env.from, fromAgentId: env.from, type: env.type, to: env.to, body: env.body,
      ...(sender ? { fromClient: sender.client } : {}),
      ...(sender?.model ? { fromModel: sender.model } : {}),
      ...(env.inReplyTo ? { inReplyTo: env.inReplyTo } : {}),
      ...(env.attachments ? { attachments: env.attachments } : {}),
    };
  }

  private addSeat(seatKey: string, s: { lobbyId: string; lobbyName: string | null; agentId: string; handle: string; role: Seat["role"]; token: string }, secretKey: Uint8Array): void {
    const seatId = ulid();
    saveKey(this.opts.home, seatId, secretKey);
    this.db.insertSeat({
      seat_id: seatId, seat_key: seatKey, lobby_id: s.lobbyId, lobby_name: s.lobbyName, agent_id: s.agentId,
      handle: s.handle, role: s.role, relay_url: this.opts.relayUrl, jwt: s.token,
    }, Date.now());
    this.connect(this.db.activeSeat(seatKey)!);
  }

  private profile(session: Session, p: Params, publicKey: string): Pick<AgentProfile, "handle" | "client" | "owns" | "publicKey"> & { workingOn: string } {
    return {
      handle: String(p.handle ?? ""), client: session.client as AgentProfile["client"],
      owns: (p.owns as string[] | undefined) ?? [], workingOn: "", publicKey,
    };
  }

  private session(p: Params): Session {
    const session = this.sessions.get(String(p.sessionId));
    if (!session) throw new DaemonError("no_session", "call session.open first");
    return session;
  }

  private seat(p: Params): Seat {
    const seat = this.db.activeSeat(this.session(p).seatKey);
    if (!seat) throw new DaemonError("no_seat", "You are not in a lobby. Ask the user for a lobby code, then join it.");
    return seat;
  }

  private async relay<T>(path: string, body: unknown, token?: string): Promise<T> {
    const res = await fetch(this.opts.relayUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Agentlobbies-Client": CLIENT_VERSION,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: { code: string; message: string } };
    if (!res.ok) throw new DaemonError(json.error?.code ?? "relay_error", json.error?.message ?? `relay returned ${res.status}`);
    return json;
  }
}
