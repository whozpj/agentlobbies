import {
  ClientFrame, LIMITS, PING, PONG, TIMINGS, fromB64u, refreshSigningBytes, verifyBytes, verifyEnvelope, webCrypto,
  type AgentProfile, type LobbyEvent, type LobbySettings, type MessageMeta, type Role, type ServerFrame,
} from "@agentlobbies/protocol";
import { DurableObject } from "cloudflare:workers";
import { headSeq, pageFor } from "./lobby/events";
import { currentEpoch, keysFrame, markRotate, memberMachines, putKeys, rotateNeeded, type Machine } from "./lobby/keys";
import {
  admit, getAgent, initLobby, isActive, removeFromLobby, roleOf, roster, updateProfile, type AdmitResult, type NewAgent,
} from "./lobby/membership";
import { getMeta, getSettings, isOpen } from "./lobby/meta";
import { lobbyExists, migrate } from "./lobby/schema";
import { doSend } from "./lobby/send";
import { isVisible } from "./lobby/visibility";

type SocketState = "awaiting_hello" | "replaying" | "live";

/** A person watching the lobby from the hosted dashboard (LLD 15.6). */
interface Watcher {
  userId: string;
  isOwner: boolean;
}

interface SocketAttachment {
  agentId: string; // empty for watchers
  state: SocketState;
  connectedAt: number;
  helloAt?: number;
  lastPresenceAt?: number;
  machineId?: string; // verified by the Worker from the account token (LLD 15.3)
  watcher?: Watcher;
  sessionId?: string; // a watcher's browser sign-in
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
 * One lobby. Every handler does cheap checks, then any `await` (signature checks, D1 reads), then one
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


  async init(args: { lobbyId: string; host?: NewAgent; settings: Partial<LobbySettings> }): Promise<void> {
    initLobby(this.ctx.storage, { ...args, now: Date.now() });
  }

  async admit(agent: NewAgent, role: Role): Promise<AdmitResult> {
    const result = admit(this.ctx.storage, agent, role, Date.now());
    if ("joined" in result) this.fanOut(result.joined);
    return result;
  }

  async summary(): Promise<{ roster: AgentProfile[]; keyEpoch: number }> {
    if (!lobbyExists(this.ctx.storage.sql)) return { roster: [], keyEpoch: 0 };
    return { roster: roster(this.ctx.storage), keyEpoch: currentEpoch(this.ctx.storage.sql) };
  }

  /** Checks an agent's refresh signature. The Worker also checks that its machine (if known) is still signed in. */
  async verifySeat(agentId: string, ts: number, sig: string): Promise<{ role: Role; machineId: string | null } | { error: "unauthorized" | "kicked" }> {
    const { sql } = this.ctx.storage;
    const agent = lobbyExists(sql) ? getAgent(sql, agentId) : undefined;
    if (!agent) return { error: "unauthorized" };
    if (!isActive(agent)) return { error: "kicked" };
    const lobbyId = getMeta(sql, "lobby_id")!;
    const ok = await verifyBytes(webCrypto, fromB64u(agent.public_key), refreshSigningBytes({ lobbyId, agentId, ts }), sig);
    return ok ? { role: agent.role as Role, machineId: agent.machine_id } : { error: "unauthorized" };
  }

  /** An agent's owner, or the lobby owner, removes an agent (LLD 14.1). */
  async removeAgent(agentId: string, actor: { userId: string; isLobbyOwner: boolean }): Promise<{ removed: true } | { error: "not_found" | "forbidden" }> {
    const { sql } = this.ctx.storage;
    const agent = lobbyExists(sql) ? getAgent(sql, agentId) : undefined;
    if (!isActive(agent)) return { error: "not_found" };
    if (agent.role === "host" || (agent.owner_id !== actor.userId && !actor.isLobbyOwner)) return { error: "forbidden" };
    this.fanOut(removeFromLobby(this.ctx.storage, agentId, Date.now()));
    for (const ws of this.ctx.getWebSockets(agentId)) ws.close(4003, "removed");
    return { removed: true };
  }

  /** An agent's owner, or the lobby owner, renames an agent or changes what it owns. People's names come from GitHub. */
  async updateAgent(
    agentId: string, changes: { handle?: string; owns?: string[] }, actor: { userId: string; isLobbyOwner: boolean },
  ): Promise<{ profile: AgentProfile } | { error: "not_found" | "forbidden" | "handle_taken" }> {
    const { sql } = this.ctx.storage;
    const agent = lobbyExists(sql) ? getAgent(sql, agentId) : undefined;
    if (!isActive(agent)) return { error: "not_found" };
    if (agent.client === "cli") return { error: "forbidden" };
    if (agent.owner_id !== actor.userId && !actor.isLobbyOwner) return { error: "forbidden" };
    const result = updateProfile(this.ctx.storage, agentId, changes);
    if ("profile" in result) this.broadcastRoster(agentId);
    return result;
  }

  /** A person left or was removed: their agents go, and the lobby key rotates (LLD 15.4). */
  async removeUser(userId: string): Promise<void> {
    const { sql } = this.ctx.storage;
    if (!lobbyExists(sql)) return;
    this.removeAgents(sql.exec<{ agent_id: string }>(
      "SELECT agent_id FROM agents WHERE owner_id = ? AND left_at IS NULL AND kicked_at IS NULL", userId,
    ).toArray());
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) ws.close(4003, "removed");
    await this.rotateKeys();
  }

  /** A device was revoked: the agents it added go, its sockets close, and the lobby key rotates. */
  async removeMachine(machineId: string): Promise<void> {
    const { sql } = this.ctx.storage;
    if (!lobbyExists(sql)) return;
    this.removeAgents(sql.exec<{ agent_id: string }>(
      "SELECT agent_id FROM agents WHERE machine_id = ? AND left_at IS NULL AND kicked_at IS NULL", machineId,
    ).toArray());
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as SocketAttachment | null)?.machineId === machineId) ws.close(4003, "device revoked");
    }
    await this.rotateKeys();
  }

  /** A browser signed out or was revoked: its watching tabs disconnect. */
  async closeSession(sessionId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`session:${sessionId}`)) ws.close(4003, "signed out");
  }

  private removeAgents(agents: { agent_id: string }[]): void {
    for (const { agent_id } of agents) {
      this.fanOut(removeFromLobby(this.ctx.storage, agent_id, Date.now()));
      for (const ws of this.ctx.getWebSockets(agent_id)) ws.close(4003, "removed");
    }
  }

  /** The owner deleted the lobby: everyone is disconnected and everything stored here is erased. */
  async deleteLobby(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4010, "lobby deleted");
    await this.ctx.storage.deleteAll();
  }

  /** Member machines changed (someone joined or signed in on a new machine): tell everyone who needs a key. */
  async refreshKeys(): Promise<void> {
    const { sql } = this.ctx.storage;
    if (!lobbyExists(sql)) return;
    this.broadcastKeys(await memberMachines(this.env.DB, getMeta(sql, "lobby_id")!));
  }

  /** A member machine signed out: the next online member makes a new key. */
  async rotateKeys(): Promise<void> {
    if (!lobbyExists(this.ctx.storage.sql)) return;
    markRotate(this.ctx.storage.sql);
    await this.refreshKeys();
  }

  /** Message metadata for the hosted dashboard; never content (LLD 15.6). */
  async messageMeta(watcher: Watcher, limit: number): Promise<MessageMeta[]> {
    const { sql } = this.ctx.storage;
    if (!lobbyExists(sql)) return [];
    const rows = sql.exec<{ event_json: string }>("SELECT event_json FROM events WHERE kind = 'message' ORDER BY seq DESC LIMIT ?", limit).toArray();
    const visible = [];
    for (const row of rows.reverse()) {
      const event = JSON.parse(row.event_json) as LobbyEvent;
      if (event.kind === "message" && this.watcherSees(watcher, event)) visible.push(this.toMeta(event));
    }
    return visible;
  }

  /**
   * Closes sockets whose heartbeats stopped (a laptop that slept, a dropped network), so peers see
   * them go offline. Runs on lobby activity rather than on a timer, so idle lobbies cost nothing.
   */
  closeStaleSockets(now = Date.now()): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att) continue;
      const lastSeen = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? att.helloAt ?? att.connectedAt;
      if (now - lastSeen <= TIMINGS.offlineAfterMs) continue;
      ws.close(1001, "no heartbeat");
      this.markOfflineIfLastSocket(ws);
    }
  }

  async fetch(req: Request): Promise<Response> {
    this.closeStaleSockets();
    const { 0: client, 1: server } = new WebSocketPair();
    const headers = { "Sec-WebSocket-Protocol": PROTOCOL };
    const { sql } = this.ctx.storage;
    const open = lobbyExists(sql) && isOpen(sql);

    // Only the Worker reaches this object, and it builds these requests itself after checking who is asking.
    if (new URL(req.url).pathname === "/watch") {
      const userId = req.headers.get("X-Watch-User") ?? "";
      const sessionId = req.headers.get("X-Session-Id") ?? "";
      this.ctx.acceptWebSocket(server, ["watch", `user:${userId}`, `session:${sessionId}`]);
      if (!open) server.close(4010, "lobby closed");
      const watcher = { userId, isOwner: req.headers.get("X-Watch-Owner") === "1" };
      server.serializeAttachment({ agentId: "", state: "live", connectedAt: Date.now(), watcher, sessionId } satisfies SocketAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    const agentId = req.headers.get("X-Agent-Id") ?? "";
    const agent = open ? getAgent(sql, agentId) : undefined;
    if (!open || !isActive(agent)) {
      this.ctx.acceptWebSocket(server);
      if (open) server.close(4003, "not a member");
      else server.close(4010, "lobby closed");
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    // The machine counts only if it belongs to the agent's owner (LLD 15.3).
    const machineId = req.headers.get("X-Machine-Id");
    const sameOwner = machineId !== null && agent.owner_id === req.headers.get("X-User-Id");
    // An agent connects only from one of its owner's signed-in machines, and belongs to the last one it
    // connected from: revoking that machine removes it (signing in again on a machine gives it a new id).
    if (agent.owner_id !== null && !sameOwner) {
      this.ctx.acceptWebSocket(server);
      server.close(4001, "connect from one of your signed-in machines");
      return new Response(null, { status: 101, webSocket: client, headers });
    }
    if (sameOwner && agent.machine_id !== machineId) sql.exec("UPDATE agents SET machine_id = ? WHERE agent_id = ?", machineId, agentId);

    for (const old of this.ctx.getWebSockets(agentId)) old.close(4009, "replaced");
    const attachment: SocketAttachment = { agentId, state: "awaiting_hello", connectedAt: Date.now() };
    if (sameOwner) attachment.machineId = machineId;
    this.ctx.acceptWebSocket(server, [agentId]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att || att.watcher) return; // refused sockets have no attachment; watchers only listen
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
    this.closeStaleSockets();

    if (att.state === "awaiting_hello" && frame.t !== "hello") return ws.close(4000, "hello first");
    switch (frame.t) {
      case "hello": return this.onHello(ws, att, frame);
      case "replay.more": return this.onReplayMore(ws, att, frame.afterSeq);
      case "ack": return this.onAck(att.agentId, frame.seq);
      case "send": return this.onSend(ws, att, frame);
      case "presence": return this.onPresence(ws, att, frame);
      case "subscribe":
      case "unsubscribe": return this.onSubscribe(ws, att.agentId, frame);
      case "keys.put": return this.onKeysPut(ws, att, frame);
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


  private async onHello(ws: WebSocket, att: SocketAttachment, frame: Extract<ClientFrame, { t: "hello" }>): Promise<void> {
    if (versionBelow(frame.clientVersion, this.env.MIN_CLIENT_VERSION)) return ws.close(4011, "upgrade required");
    const { sql } = this.ctx.storage;
    const machines = await memberMachines(this.env.DB, getMeta(sql, "lobby_id")!);

    const agent = getAgent(sql, att.agentId);
    if (!isActive(agent)) return ws.close(4003, "not a member");
    const settings = getSettings(sql);
    const floor = settings.historyOnJoin === "since_join" ? Number(agent.joined_seq) - 1 : 0;
    const after = Math.max(frame.afterSeq, floor);
    const minRetained = Number(getMeta(sql, "min_retained_seq") ?? 1);

    att.helloAt = Date.now();
    ws.serializeAttachment(att);
    // Online and waiting until the agent says it's working (its hooks report each turn).
    this.setStatus(att.agentId, "idle");
    const welcome: Extract<ServerFrame, { t: "welcome" }> = {
      t: "welcome",
      agentId: att.agentId,
      role: agent.role as Role,
      headSeq: headSeq(this.ctx.storage),
      roster: roster(this.ctx.storage),
      board: [],
      settings,
      subscriptions: this.subscriptionsOf(att.agentId),
    };
    // Older history was archived, so the agent knows its replay starts later than it asked.
    if (after + 1 < minRetained) welcome.truncatedBefore = minRetained;
    this.send(ws, welcome);
    // Keys before history, so the replayed messages can be decrypted as they arrive.
    this.send(ws, keysFrame(sql, att.machineId, machines));
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
    if (e.v !== 2) return this.sendErr(ws, frame.reqId, "bad_request", "messages must be end-to-end encrypted; update agentlobbies");
    // After someone leaves, nothing more goes out under a key they had: wait for the new one.
    const epoch = currentEpoch(sql);
    if (epoch > 0 && (rotateNeeded(sql) || e.sealed!.epoch < epoch)) {
      return this.sendErr(ws, frame.reqId, "key_rotating", "the lobby is switching to a new key; try again in a moment", 2_000);
    }

    const publicKey = getAgent(sql, att.agentId)?.public_key;
    if (!publicKey || !(await verifyEnvelope(webCrypto, fromB64u(publicKey), e))) {
      return this.sendErr(ws, frame.reqId, "bad_signature");
    }

    const result = doSend(this.ctx.storage, att.agentId, e, Date.now());
    if ("error" in result) return this.sendErr(ws, frame.reqId, result.error, undefined, result.retryAfterMs);
    this.send(ws, { t: "ok", reqId: frame.reqId, seq: result.seq });
    if (result.event) this.fanOut(result.event);
  }

  private async onKeysPut(ws: WebSocket, att: SocketAttachment, frame: Extract<ClientFrame, { t: "keys.put" }>): Promise<void> {
    const { sql } = this.ctx.storage;
    const machines = await memberMachines(this.env.DB, getMeta(sql, "lobby_id")!);
    const result = putKeys(sql, att.machineId, frame, machines);
    if ("error" in result) return this.sendErr(ws, frame.reqId, result.error);
    this.send(ws, { t: "ok", reqId: frame.reqId });
    this.broadcastKeys(machines);
  }

  /** Status changes (working, waiting) always apply; changes to only "working on" are throttled. */
  private onPresence(ws: WebSocket, att: SocketAttachment, frame: Extract<ClientFrame, { t: "presence" }>): void {
    const now = Date.now();
    const agent = getAgent(this.ctx.storage.sql, att.agentId);
    if (!agent || (agent.status === frame.status && agent.working_on === frame.workingOn)) return;
    const statusChanged = agent.status !== frame.status;
    if (!statusChanged && att.lastPresenceAt && now - att.lastPresenceAt < 5_000) return;
    att.lastPresenceAt = now;
    ws.serializeAttachment(att);

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
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att?.state !== "live") continue; // replaying sockets get it from the next page
      if (att.watcher) {
        this.sendToWatcher(ws, att.watcher, event);
        continue;
      }
      const role = roleOf(sql, att.agentId);
      if (!role) continue;
      const viewer = { agentId: att.agentId, role, topics: new Set(this.subscriptionsOf(att.agentId)), observersSeeDirects };
      if (!isVisible(event, viewer)) continue;
      this.trySend(ws, frame);
    }
  }

  /** Watchers get system events as they are and messages as metadata only. */
  private sendToWatcher(ws: WebSocket, watcher: Watcher, event: LobbyEvent): void {
    if (event.kind === "system") this.trySend(ws, JSON.stringify({ t: "event", event } satisfies ServerFrame));
    if (event.kind === "message" && this.watcherSees(watcher, event)) {
      this.trySend(ws, JSON.stringify({ t: "meta", message: this.toMeta(event) } satisfies ServerFrame));
    }
  }

  /** The lobby owner sees every message; anyone else sees broadcasts and what their own agents sent or can see. */
  private watcherSees(watcher: Watcher, event: LobbyEvent): boolean {
    if (event.kind !== "message") return false;
    if (watcher.isOwner || event.envelope.to.kind === "broadcast") return true;
    const { sql } = this.ctx.storage;
    const observersSeeDirects = getSettings(sql).observersSeeDirects;
    const theirAgents = sql.exec<{ agent_id: string; role: Role }>(
      "SELECT agent_id, role FROM agents WHERE owner_id = ? AND left_at IS NULL AND kicked_at IS NULL", watcher.userId,
    ).toArray();
    for (const agent of theirAgents) {
      if (event.envelope.from === agent.agent_id) return true;
      const viewer = { agentId: agent.agent_id, role: agent.role, topics: new Set(this.subscriptionsOf(agent.agent_id)), observersSeeDirects };
      if (isVisible(event, viewer)) return true;
    }
    return false;
  }

  private toMeta(event: Extract<LobbyEvent, { kind: "message" }>): MessageMeta {
    const { sql } = this.ctx.storage;
    const { envelope: e } = event;
    const handleOf = (agentId: string) => getAgent(sql, agentId)?.handle ?? agentId;
    let to: string;
    if (e.to.kind === "broadcast") to = "all";
    else if (e.to.kind === "topic") to = `#${e.to.topic}`;
    else to = handleOf(e.to.agentId);
    const meta: MessageMeta = {
      id: e.id, seq: event.seq, from: handleOf(e.from), fromAgentId: e.from, to, type: e.type,
      inReplyTo: e.inReplyTo ?? null, committedAt: event.committedAt,
    };
    if (e.sealed) meta.sealed = e.sealed;
    return meta;
  }

  /** The lobby keys sealed to one device, for a browser to open (LLD 15.11). */
  async sealedKeysFor(machineId: string): Promise<{ epoch: number; sealed: string }[]> {
    const { sql } = this.ctx.storage;
    if (!lobbyExists(sql)) return [];
    return sql.exec<{ epoch: number; sealed: string }>("SELECT epoch, sealed FROM lobby_keys WHERE machine_id = ? ORDER BY epoch", machineId)
      .toArray().map((r) => ({ epoch: r.epoch, sealed: r.sealed }));
  }

  /** Every agent socket gets the keys frame for its own machine. */
  private broadcastKeys(machines: Machine[]): void {
    const { sql } = this.ctx.storage;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (!att || att.watcher || !att.helloAt) continue;
      this.trySend(ws, JSON.stringify(keysFrame(sql, att.machineId, machines)));
    }
  }

  private subscriptionsOf(agentId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ topic: string }>("SELECT topic FROM subscriptions WHERE agent_id = ? ORDER BY topic", agentId)
      .toArray()
      .map((r) => r.topic);
  }

  private setStatus(agentId: string, status: "idle" | "offline"): void {
    this.ctx.storage.sql.exec("UPDATE agents SET status = ?, last_seen_at = ? WHERE agent_id = ?", status, Date.now(), agentId);
    this.broadcastRoster(agentId);
  }

  private broadcastRoster(agentId: string): void {
    const agent = roster(this.ctx.storage).find((a) => a.agentId === agentId);
    if (!agent) return;
    const frame = JSON.stringify({ t: "roster", agent } satisfies ServerFrame);
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as SocketAttachment | null)?.state === "live") this.trySend(ws, frame);
    }
  }

  private markOfflineIfLastSocket(closing: WebSocket): void {
    const att = closing.deserializeAttachment() as SocketAttachment | null;
    if (!att || att.watcher || !lobbyExists(this.ctx.storage.sql)) return;
    const others = this.ctx.getWebSockets(att.agentId).filter((ws) => ws !== closing);
    if (others.length === 0) this.setStatus(att.agentId, "offline");
  }

  private trySend(ws: WebSocket, frame: string): void {
    try {
      ws.send(frame);
    } catch {
      // The socket is closing; an agent replays from its cursor on reconnect.
    }
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private sendErr(ws: WebSocket, reqId: string | undefined, code: string, message = code, retryAfterMs?: number): void {
    const frame: Extract<ServerFrame, { t: "err" }> = { t: "err", code, message };
    if (reqId) frame.reqId = reqId;
    if (retryAfterMs) frame.retryAfterMs = retryAfterMs;
    this.send(ws, frame);
  }
}
