import {
  ClientFrame, LIMITS, PING, PONG, TIMINGS, fromB64u, verifyEnvelope, webCrypto,
  type LobbyEvent, type LobbySettings, type Role, type ServerFrame,
} from "@agentlobbies/protocol";
import { DurableObject } from "cloudflare:workers";
import { headSeq, pageFor } from "./lobby/events";
import { admit, getAgent, initLobby, isActive, roleOf, roster, type AdmitResult, type NewAgent } from "./lobby/membership";
import { getMeta, getSettings, isOpen } from "./lobby/meta";
import { lobbyExists, migrate } from "./lobby/schema";
import { doSend } from "./lobby/send";
import { isVisible } from "./lobby/visibility";

type SocketState = "awaiting_hello" | "replaying" | "live";

interface SocketAttachment {
  agentId: string;
  state: SocketState;
  connectedAt: number;
  lastPresenceAt?: number;
}

const PROTOCOL = "agentlobbies.v1";

/** Compares dotted versions numerically, e.g. "0.10.0" > "0.9.1". */
function versionBelow(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * One lobby. Every handler does cheap checks, then any `await` (signature checks), then one
 * synchronous block that re-reads state, commits, replies, and fans out (LLD 5.1).
 */
export class LobbyDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Only an existing lobby migrates, so stray requests create no tables (G17).
    ctx.blockConcurrencyWhile(async () => {
      if (lobbyExists(ctx.storage.sql)) migrate(ctx.storage.sql);
    });
    // Heartbeats are answered without waking the object (C7).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }


  async init(args: { lobbyId: string; host: NewAgent; settings: Partial<LobbySettings> }): Promise<void> {
    initLobby(this.ctx.storage, { ...args, now: Date.now() });
  }

  async admit(agent: NewAgent, role: Role): Promise<AdmitResult> {
    const result = admit(this.ctx.storage, agent, role, Date.now());
    if ("joined" in result) this.fanOut(result.joined);
    return result;
  }


  async fetch(req: Request): Promise<Response> {
    const agentId = req.headers.get("X-Agent-Id") ?? "";
    const { 0: client, 1: server } = new WebSocketPair();
    const headers = { "Sec-WebSocket-Protocol": PROTOCOL };

    const open = lobbyExists(this.ctx.storage.sql) && isOpen(this.ctx.storage.sql);
    if (!open || !isActive(getAgent(this.ctx.storage.sql, agentId))) {
      this.ctx.acceptWebSocket(server);
      server.close(open ? 4003 : 4010, open ? "not a member" : "lobby closed");
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    for (const old of this.ctx.getWebSockets(agentId)) old.close(4009, "replaced");

    this.ctx.acceptWebSocket(server, [agentId]);
    server.serializeAttachment({ agentId, state: "awaiting_hello", connectedAt: Date.now() } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).length > LIMITS.maxFrameBytes) {
      return ws.close(4000, "bad frame");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return ws.close(4000, "invalid json");
    }
    const parsed = ClientFrame.safeParse(json);
    if (!parsed.success) return this.sendErr(ws, undefined, "bad_request", parsed.error.issues[0]?.message ?? "invalid frame");
    const frame = parsed.data;
    const att = ws.deserializeAttachment() as SocketAttachment;

    if (att.state === "awaiting_hello" && frame.t !== "hello") return ws.close(4000, "hello first");
    switch (frame.t) {
      case "hello": return this.onHello(ws, att, frame);
      case "replay.more": return this.onReplayMore(ws, att, frame.afterSeq);
      case "ack": return this.onAck(att.agentId, frame.seq);
      case "send": return this.onSend(ws, att, frame);
      case "presence": return this.onPresence(ws, att, frame);
      case "subscribe":
      case "unsubscribe": return this.onSubscribe(ws, att.agentId, frame);
      case "board.put":
      case "board.delete": return this.sendErr(ws, frame.reqId, "bad_request", "the board is not available yet");
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.markOfflineIfLastSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.markOfflineIfLastSocket(ws);
  }


  private onHello(ws: WebSocket, att: SocketAttachment, frame: Extract<ClientFrame, { t: "hello" }>): void {
    if (versionBelow(frame.clientVersion, this.env.MIN_CLIENT_VERSION)) return ws.close(4011, "upgrade required");
    const { sql } = this.ctx.storage;
    const agent = getAgent(sql, att.agentId);
    if (!isActive(agent)) return ws.close(4003, "not a member");

    const settings = getSettings(sql);
    const floor = settings.historyOnJoin === "since_join" ? Number(agent.joined_seq) - 1 : 0;
    const after = Math.max(frame.afterSeq, floor);
    const minRetained = Number(getMeta(sql, "min_retained_seq") ?? 1);

    this.setStatus(att.agentId, "active");
    this.send(ws, {
      t: "welcome",
      agentId: att.agentId,
      role: agent.role as Role,
      headSeq: headSeq(this.ctx.storage),
      roster: roster(this.ctx.storage),
      board: [],
      settings,
      subscriptions: this.subscriptionsOf(att.agentId),
      ...(after + 1 < minRetained ? { truncatedBefore: minRetained } : {}),
    });
    this.sendPage(ws, att, after);
  }

  private onReplayMore(ws: WebSocket, att: SocketAttachment, afterSeq: number): void {
    if (att.state === "replaying") this.sendPage(ws, att, afterSeq);
  }

  /** Replay is pull-paged; a socket goes live only after the last page (LLD 5.6, I3). */
  private sendPage(ws: WebSocket, att: SocketAttachment, after: number): void {
    const { events, more } = pageFor(this.ctx.storage, att.agentId, after, TIMINGS.replayPageSize);
    this.send(ws, { t: "events", events, more });
    att.state = more ? "replaying" : "live";
    ws.serializeAttachment(att);
  }

  private onAck(agentId: string, seq: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE agents SET last_acked_seq = MAX(last_acked_seq, MIN(?, ?)) WHERE agent_id = ?",
      seq, headSeq(this.ctx.storage), agentId,
    );
  }

  private async onSend(ws: WebSocket, att: SocketAttachment, frame: Extract<ClientFrame, { t: "send" }>): Promise<void> {
    const e = frame.envelope;
    const { sql } = this.ctx.storage;

    if (e.lobbyId !== getMeta(sql, "lobby_id") || e.from !== att.agentId) return this.sendErr(ws, frame.reqId, "lobby_mismatch");
    if (roleOf(sql, att.agentId) === "observer") return this.sendErr(ws, frame.reqId, "forbidden");
    const attachmentBytes = (e.attachments ?? []).reduce((n, a) => n + new TextEncoder().encode(a.content).length, 0);
    if (new TextEncoder().encode(e.body).length > LIMITS.maxBodyBytes || attachmentBytes > LIMITS.maxAttachmentBytesTotal) {
      return this.sendErr(ws, frame.reqId, "too_large");
    }

    const publicKey = getAgent(sql, att.agentId)?.public_key;
    if (!publicKey || !(await verifyEnvelope(webCrypto, fromB64u(publicKey), e))) {
      return this.sendErr(ws, frame.reqId, "bad_signature");
    }

    const result = doSend(this.ctx.storage, att.agentId, e, Date.now());
    if ("error" in result) return this.sendErr(ws, frame.reqId, result.error, undefined, result.retryAfterMs);
    this.send(ws, { t: "ok", reqId: frame.reqId, ...("held" in result ? { held: true } : { seq: result.seq }) });
    if ("event" in result && result.event) this.fanOut(result.event);
  }

  private onPresence(ws: WebSocket, att: SocketAttachment, frame: Extract<ClientFrame, { t: "presence" }>): void {
    const now = Date.now();
    if (att.lastPresenceAt && now - att.lastPresenceAt < 5_000) return;
    att.lastPresenceAt = now;
    ws.serializeAttachment(att);

    const agent = getAgent(this.ctx.storage.sql, att.agentId);
    if (!agent || (agent.status === frame.status && agent.working_on === frame.workingOn)) return;
    this.ctx.storage.sql.exec(
      "UPDATE agents SET status = ?, working_on = ?, last_seen_at = ? WHERE agent_id = ?",
      frame.status, frame.workingOn, now, att.agentId,
    );
    this.broadcastRoster(att.agentId);
  }

  private onSubscribe(ws: WebSocket, agentId: string, frame: Extract<ClientFrame, { t: "subscribe" | "unsubscribe" }>): void {
    const { sql } = this.ctx.storage;
    if (frame.t === "unsubscribe") {
      sql.exec("DELETE FROM subscriptions WHERE topic = ? AND agent_id = ?", frame.topic, agentId);
    } else {
      if (this.subscriptionsOf(agentId).length >= LIMITS.maxSubscriptionsPerAgent) {
        return this.sendErr(ws, frame.reqId, "too_large", "too many subscriptions");
      }
      sql.exec("INSERT OR IGNORE INTO subscriptions VALUES (?, ?)", frame.topic, agentId);
    }
    this.send(ws, { t: "ok", reqId: frame.reqId });
  }


  /** Sends a committed event to every live socket allowed to see it. Call only after commit (I2). */
  private fanOut(event: LobbyEvent): void {
    const { sql } = this.ctx.storage;
    const observersSeeDirects = getSettings(sql).observersSeeDirects;
    const frame = JSON.stringify({ t: "event", event } satisfies ServerFrame);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment;
      if (att.state !== "live") continue; // replaying sockets get it from the next page
      const role = roleOf(sql, att.agentId);
      if (!role) continue;
      const viewer = { agentId: att.agentId, role, topics: new Set(this.subscriptionsOf(att.agentId)), observersSeeDirects };
      if (!isVisible(event, viewer)) continue;
      try {
        ws.send(frame);
      } catch {
        // Socket is closing; the agent replays from its cursor on reconnect.
      }
    }
  }

  private subscriptionsOf(agentId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ topic: string }>("SELECT topic FROM subscriptions WHERE agent_id = ? ORDER BY topic", agentId)
      .toArray()
      .map((r) => r.topic);
  }

  private setStatus(agentId: string, status: "active" | "offline"): void {
    this.ctx.storage.sql.exec("UPDATE agents SET status = ?, last_seen_at = ? WHERE agent_id = ?", status, Date.now(), agentId);
    this.broadcastRoster(agentId);
  }

  private broadcastRoster(agentId: string): void {
    const agent = roster(this.ctx.storage).find((a) => a.agentId === agentId);
    if (!agent) return;
    const frame = JSON.stringify({ t: "roster", agent } satisfies ServerFrame);
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as SocketAttachment).state === "live") ws.send(frame);
    }
  }

  private markOfflineIfLastSocket(closing: WebSocket): void {
    const att = closing.deserializeAttachment() as SocketAttachment | null;
    if (!att || !lobbyExists(this.ctx.storage.sql)) return;
    const others = this.ctx.getWebSockets(att.agentId).filter((ws) => ws !== closing);
    if (others.length === 0) this.setStatus(att.agentId, "offline");
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private sendErr(ws: WebSocket, reqId: string | undefined, code: string, message = code, retryAfterMs?: number): void {
    this.send(ws, { t: "err", ...(reqId ? { reqId } : {}), code, message, ...(retryAfterMs ? { retryAfterMs } : {}) });
  }
}

