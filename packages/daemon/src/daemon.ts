import {
  LIMITS, refreshSigningBytes, signEnvelope, generateSeatKeys, toAreas, toB64u, toHandle, webCrypto,
  type AgentProfile, type Envelope, type LobbyEvent, type Recipient, type ServerFrame,
} from "@agentlobbies/protocol";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { ulid } from "ulid";
import { Connection, type ConnectionState } from "./connection";
import { startDashboard, type Dashboard } from "./dashboard";
import { openDb, type Account, type Db, type Seat } from "./db";
import { decryptContent, encryptContent, generateBoxKeys, newLobbyKey, openLobbyKey, sealLobbyKey, type BoxKeys } from "./encryption";
import { findSecret } from "./guard";
import { hasKey, loadKey, saveKey } from "./keys";
import { DaemonError } from "./rpc";
import { UserLink } from "./user-link";

import { CLIENT_VERSION } from "./version";

export { CLIENT_VERSION };

interface Session {
  client: string;
  cwd: string;
  seatKey: string;
  /** A hook's session: it doesn't mean the agent is running (a hook can outlive its agent). */
  passive: boolean;
}

type Params = Record<string, unknown>;
type OkOrErr = Extract<ServerFrame, { t: "ok" | "err" }>;
type KeysFrame = Extract<ServerFrame, { t: "keys" }>;

const KEY_WAIT_MS = 5_000;

/** Only these may be asked for from the hosted dashboard, through the user object (LLD 15.6). */
const WEB_METHODS = new Set(["lobby.addAgent", "agent.setSecure"]);

/** A message as handed to an MCP server or the CLI. */
export interface SurfacedMessage {
  id: string;
  seq: number;
  from: string;
  fromAgentId: string;
  fromClient?: string;
  fromModel?: string;
  fromOwner?: string;
  type: Envelope["type"] | "notice";
  to: Recipient;
  body: string;
  inReplyTo?: string;
  attachments?: Envelope["attachments"];
}

/** An invite can be pasted as the whole link or just the token at its end. */
function inviteToken(invite: string): string {
  const parts = invite.trim().split("/");
  return parts[parts.length - 1] ?? "";
}

function expiresWithinAnHour(jwt: string): boolean {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { exp: number };
    return exp * 1000 - Date.now() < 3_600_000;
  } catch {
    return true;
  }
}

/** The seat key of the signed-in person (the CLI and dashboard act through it), one seat per lobby. */
export const PERSON = "person";

const CLIENT_SHORT_NAMES: Record<string, string> = { "claude-code": "claude", "gemini-cli": "gemini", custom: "agent" };

/** A lobby handle from a GitHub login: lowercase letters, digits, and hyphens, at most 32 characters. */
export function personHandle(login: string): string {
  return login.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 32).padEnd(2, "0");
}

/** "web" + Claude Code becomes "web-claude". */
export function defaultHandle(client: string, cwd: string): string {
  const folder = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${folder.slice(0, 20)}-${CLIENT_SHORT_NAMES[client] ?? client}`.slice(0, 32);
}

/** Same client in the same folder gets the same identity back (LLD 7.1). */
export function seatKeyFor(client: string, cwd: string): string {
  if (client === PERSON) return PERSON;
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

  private dashboard: Dashboard | undefined;
  private userLink: UserLink | undefined;
  private syncing: Promise<void> = Promise.resolve();
  /** Each lobby's people, as the relay lists them (members needn't have a seat on this machine). */
  private readonly people = new Map<string, LobbyPerson[]>();
  /** Lobbies whose key must change (someone left) before anything more is sent. */
  private readonly rotating = new Set<string>();
  /** How many times each outgoing message was sealed again after a key change. */
  private readonly reseals = new Map<string, number>();

  constructor(private readonly opts: { home: string; relayUrl: string; dashboardDir?: string }) {
    super();
    this.on("activity", (activity: { type: string }) => {
      if (activity.type === "agents") this.userLink?.sendAgents();
    });
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.home, { recursive: true, mode: 0o700 });
    this.db = openDb(join(this.opts.home, "daemon.db"));
    this.running = true;
    // People are always in their lobbies; an agent connects while its session runs (see session.open).
    for (const seat of this.db.activeSeats()) {
      if (seat.seat_key === PERSON) this.connect(seat);
    }
    void this.afterSignIn();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    for (const seatId of [...this.pendingAcks.keys()]) this.flushAck(seatId);
    await this.dashboard?.close();
    this.userLink?.stop();
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
    "daemon.info": async () => ({
      version: CLIENT_VERSION, pid: process.pid, seats: this.db.activeSeats().length,
      codexHooksAllowed: this.db.setting("codex_hooks_ran") === "1",
    }),

    "account.login": async (p) => {
      const keys = await generateSeatKeys();
      const box = await generateBoxKeys();
      const res = await this.relay<{ token: string; machineId: string; user: { userId: string; login: string; avatarUrl: string } }>(
        "/v1/auth/github", {
          githubToken: String(p.githubToken ?? ""), machinePublicKey: toB64u(keys.publicKey), boxPublicKey: toB64u(box.publicKey), machineName: hostname(),
        },
      );
      saveKey(this.opts.home, "machine", keys.secretKey);
      this.saveBoxKeys(box);
      this.db.setAccount({ user_id: res.user.userId, login: res.user.login, avatar_url: res.user.avatarUrl, token: res.token, machine_id: res.machineId });
      await this.afterSignIn();
      return { login: res.user.login, avatarUrl: res.user.avatarUrl };
    },

    "account.status": async () => {
      const account = this.db.account();
      return account ? { login: account.login, avatarUrl: account.avatar_url } : null;
    },

    "account.logout": async () => {
      const account = this.db.account();
      if (account) {
        try {
          await this.relay("/v1/auth/logout", {}, account.token);
        } catch {
          // Signing out on this machine still works when the relay can't be reached.
        }
      }
      this.signOutLocally();
      return {};
    },

    "devices.list": async () => this.relay("/v1/me/devices", undefined, await this.accountToken(), "GET"),

    /** Revokes one of your devices; revoking this machine signs it out. */
    "devices.revoke": async (p) => {
      const deviceId = String(p.deviceId ?? "");
      const account = this.requireAccount();
      await this.relay(`/v1/me/devices/${deviceId}`, undefined, await this.accountToken(), "DELETE");
      if (deviceId === account.machine_id) this.signOutLocally();
      return {};
    },

    "account.export": async () => this.relay("/v1/me/export", undefined, await this.accountToken(), "GET"),

    /** Deletes your account everywhere, then everything this machine kept for it. */
    "account.delete": async () => {
      await this.relay("/v1/me", undefined, await this.accountToken(), "DELETE");
      for (const seat of this.db.activeSeats()) this.forgetLobby(seat.lobby_id);
      this.signOutLocally();
      return {};
    },

    "daemon.shutdown": async () => {
      setImmediate(() => this.emit("shutdown"));
      return {};
    },

    "session.open": async (p) => {
      const client = String(p.client ?? "custom");
      const cwd = String(p.cwd ?? process.cwd());
      const sessionId = randomUUID();
      const seatKey = seatKeyFor(client, cwd);
      const passive = p.passive === true;
      this.sessions.set(sessionId, { client, cwd, seatKey, passive });
      // Codex runs a hook only once the user has allowed it (in /hooks), so one connecting proves they did.
      if (passive && client === "codex") this.db.setSetting("codex_hooks_ran", "1");
      if (seatKey !== PERSON && !passive) {
        this.db.upsertLocalAgent(seatKey, client, realpathSync(cwd));
        this.connectAgent(seatKey);
        this.emit("activity", { type: "agents" });
      }
      const seat = this.db.activeSeat(seatKey);
      return { sessionId, seatKey, lobby: seat ? { lobbyId: seat.lobby_id, handle: seat.handle } : null };
    },

    "session.close": async (p) => {
      const session = this.sessions.get(String(p.sessionId));
      this.sessions.delete(String(p.sessionId));
      if (session && session.seatKey !== PERSON && !this.isRunning(session.seatKey)) {
        // The agent's session closed, so it goes offline; messages wait on the relay until it's back.
        for (const seat of this.db.seatsFor(session.seatKey)) {
          this.connections.get(seat.seat_id)?.stop();
          this.connections.delete(seat.seat_id);
        }
      }
      this.emit("activity", { type: "agents" });
      return {};
    },

    // The relay creates the lobby; syncing adds this machine's person seat to it (LLD 15.6).
    "lobby.create": async (p) => {
      this.requireAccount();
      const name = p.name ? String(p.name) : undefined;
      const res = await this.relay<{ lobbyId: string; name: string | null }>("/v1/lobbies", name ? { name } : {}, await this.accountToken());
      await this.syncMemberships();
      return { lobbyId: res.lobbyId, name: res.name };
    },

    "invite.create": async (p) => {
      const lobbyId = String(p.lobbyId ?? this.seat(p).lobby_id);
      const body: { role: unknown; maxUses?: number } = { role: p.role ?? "member" };
      if (p.maxUses) body.maxUses = Number(p.maxUses);
      return this.relay(`/v1/lobbies/${lobbyId}/invites`, body, await this.accountToken());
    },

    "invite.accept": async (p) => {
      this.requireAccount();
      const token = inviteToken(String(p.invite ?? ""));
      const res = await this.relay<{ lobbyId: string; name: string | null; role: string }>("/v1/invites/accept", { token }, await this.accountToken());
      await this.syncMemberships();
      return res;
    },

    "agents.list": async () => this.localAgents(),

    /** You put one of your own agents into a lobby; the agent is told on its next turn (LLD 14.5). */
    "lobby.addAgent": async (p) => {
      const account = this.requireAccount();
      const lobbyId = String(p.lobbyId ?? "");
      const local = this.db.localAgent(String(p.seatKey ?? ""));
      if (!local) throw new DaemonError("not_found", "that agent hasn't connected on this machine");
      const you = this.db.activeSeatIn(PERSON, lobbyId);
      if (!you) throw new DaemonError("not_found", "you aren't in that lobby");

      const keys = await generateSeatKeys();
      const profile = {
        handle: p.handle ? toHandle(String(p.handle)) : defaultHandle(local.client, local.cwd),
        client: local.client as AgentProfile["client"],
        owns: toAreas((p.owns as string[] | undefined) ?? []),
        workingOn: "",
        publicKey: toB64u(keys.publicKey),
      };
      const res = await this.relay<{ agentId: string; token: string; handle: string }>(
        `/v1/lobbies/${lobbyId}/agents`, { agent: profile }, await this.accountToken(),
      );
      const seat = this.addSeat(local.seat_key, { lobbyId, lobbyName: you.lobby_name, agentId: res.agentId, handle: res.handle, role: "member", token: res.token }, keys.secretKey);
      this.db.addNotice(seat.seat_id,
        `You were added to lobby ${you.lobby_name ?? lobbyId.slice(0, 8)} by @${account.login} as ${res.handle}. ` +
        `Tell your user, in one short line, that you joined ${you.lobby_name ?? "the lobby"} as ${res.handle}. ` +
        "Don't post anything to the lobby about it; call lobby_players when you need to know who's here.");
      this.wakeWaiter(seat.seat_id);
      this.emit("activity", { type: "agents" });
      return { agentId: res.agentId, handle: res.handle };
    },

    "lobby.removeAgent": async (p) => {
      const lobbyId = String(p.lobbyId ?? "");
      const agentId = String(p.agentId ?? "");
      await this.relay(`/v1/lobbies/${lobbyId}/agents/${agentId}`, undefined, await this.accountToken(), "DELETE");
      const local = this.db.activeSeats().find((s) => s.agent_id === agentId);
      if (local) {
        this.db.setSeatState(local.seat_id, "left");
        this.connections.get(local.seat_id)?.stop();
        this.connections.delete(local.seat_id);
      }
      this.emit("activity", { type: "agents" });
      return {};
    },

    /** Renames an agent or changes the areas it owns; the agent is told on its next turn. */
    "lobby.updateAgent": async (p) => {
      const body: { handle?: string; owns?: string[] } = {};
      if (p.handle !== undefined) body.handle = String(p.handle);
      if (p.owns !== undefined) body.owns = p.owns as string[];
      return this.relay(`/v1/lobbies/${String(p.lobbyId ?? "")}/agents/${String(p.agentId ?? "")}`, body, await this.accountToken(), "PATCH");
    },

    /** The owner deletes a lobby for everyone. */
    "lobby.delete": async (p) => {
      const lobbyId = String(p.lobbyId ?? "");
      await this.relay(`/v1/lobbies/${lobbyId}`, undefined, await this.accountToken(), "DELETE");
      this.forgetLobby(lobbyId);
      return {};
    },

    /**
     * Drops a lobby from this machine only: for old lobbies from before lobbies had owners. A lobby you
     * are still a member of comes back on the next sync; leave it or delete it instead.
     */
    "lobby.forget": async (p) => {
      this.forgetLobby(String(p.lobbyId ?? ""));
      return {};
    },

    /** The lobby owner removes a person, or you leave (your own login). Their agents go and the key rotates. */
    "lobby.removeMember": async (p) => {
      const lobbyId = String(p.lobbyId ?? "");
      await this.relay(`/v1/lobbies/${lobbyId}/members/${encodeURIComponent(String(p.login ?? ""))}`, undefined, await this.accountToken(), "DELETE");
      this.emit("activity", { type: "lobbies" });
      return {};
    },

    "lobby.status": async (p) => {
      const seat = this.seat(p);
      return {
        lobbyId: seat.lobby_id, lobbyName: seat.lobby_name, handle: seat.handle, role: seat.role,
        connection: this.connections.get(seat.seat_id)?.state ?? "stopped", unread: this.db.unreadCount(seat.seat_id),
        keyEpoch: this.db.latestLobbyKey(seat.lobby_id)?.epoch ?? 0,
      };
    },

    "lobby.players": async (p) => this.db.roster(this.seat(p).seat_id),

    // In secure mode an agent's message waits for its user's approval instead of going out.
    "message.send": async (p) => {
      const seat = this.seat(p);
      const { seatKey } = this.session(p);
      if (seatKey !== PERSON && this.isSecure(seatKey)) return this.holdForApproval(seat, p);
      return this.sendMessage(seat, p);
    },

    /** Secure mode: every message the agent sends waits for approval, and peer messages don't wake it. */
    "agent.setSecure": async (p) => {
      const seatKey = String(p.seatKey ?? "");
      if (!this.db.localAgent(seatKey)) throw new DaemonError("not_found", "that agent hasn't connected on this machine");
      this.db.setSecure(seatKey, p.secure === true);
      if (p.secure === true) {
        // Stop any wait that would wake the agent.
        for (const seat of this.db.seatsFor(seatKey)) {
          const waiter = this.inboxWaiters.get(seat.seat_id);
          if (waiter) waiter({ cancelled: true });
        }
      }
      this.emit("activity", { type: "agents" });
      return {};
    },

    "approvals.list": async () => this.db.pendingSends().map((pending) => this.describePending(pending)),

    /** Sends a held message, with the user's edits to its text if any. */
    "approvals.approve": async (p) => {
      const pending = this.db.pendingSend(String(p.id ?? ""));
      if (!pending) throw new DaemonError("not_found", "that message isn't waiting for approval");
      const seat = this.db.seat(pending.seat_id);
      const params = JSON.parse(pending.params) as Params;
      if (typeof p.body === "string" && p.body.trim()) params.body = p.body;
      const result = await this.sendMessage(seat, params);
      this.db.removePendingSend(pending.id);
      const { to, type } = this.describePending(pending);
      this.db.addNotice(seat.seat_id, `Your user approved your ${type} to ${to}, and it was sent.`);
      this.emit("activity", { type: "agents" });
      return result;
    },

    "approvals.discard": async (p) => {
      const pending = this.db.pendingSend(String(p.id ?? ""));
      if (!pending) throw new DaemonError("not_found", "that message isn't waiting for approval");
      this.db.removePendingSend(pending.id);
      const { to, type, body } = this.describePending(pending);
      this.db.addNotice(pending.seat_id, `Your user decided not to send your ${type} to ${to}: "${body.slice(0, 200)}"`);
      this.emit("activity", { type: "agents" });
      return {};
    },

    "inbox.pull": async (p) => {
      const seat = this.seat(p);
      if (p.messageId) {
        const envelope = this.db.findEnvelope(seat.seat_id, String(p.messageId));
        if (!envelope) throw new DaemonError("not_found", `no message with id ${p.messageId}`);
        this.db.markSurfaced(seat.seat_id, envelope.id);
        return [this.surface(seat, this.db.findEvent(seat.seat_id, envelope.id)!)];
      }
      const limit = Math.min(Number(p.limit ?? 10), 25);
      const notices: SurfacedMessage[] = this.db.takeNotices(seat.seat_id).map((n) => ({
        id: `notice-${n.id}`, seq: 0, from: "lobby", fromAgentId: "", type: "notice", to: { kind: "broadcast" }, body: n.body,
      }));
      return [...notices, ...this.db.takeUnread(seat.seat_id, limit).map((e) => this.surface(seat, e))];
    },

    "inbox.peek": async (p) => ({ unread: this.db.unreadCount(this.seat(p).seat_id) }),

    "dashboard.start": async () => {
      if (!this.dashboard) this.dashboard = await startDashboard(this, this.opts.dashboardDir);
      return { url: this.dashboard.url };
    },

    "dashboard.lobbies": async () => {
      const byLobby = Map.groupBy(this.db.activeSeats(), (s) => s.lobby_id);
      return [...byLobby].map(([lobbyId, seats]) => {
        const view = this.viewSeat(seats);
        const connection = this.connections.get(view.seat_id)?.state ?? "stopped";
        let roster = this.db.roster(view.seat_id);
        // Not connected to this lobby: the saved roster is out of date, so don't claim anyone is online.
        if (connection !== "live") roster = roster.map((a) => ({ ...a, status: "offline" as const }));
        return {
          lobbyId,
          name: seats.find((s) => s.lobby_name)?.lobby_name ?? null,
          myRole: seats.find((s) => s.seat_key === PERSON)?.role ?? null,
          local: seats.filter((s) => s.seat_key !== PERSON).map((s) => ({ handle: s.handle, agentId: s.agent_id, seatKey: s.seat_key })),
          connection,
          keyEpoch: this.db.latestLobbyKey(lobbyId)?.epoch ?? 0,
          roster,
          people: this.people.get(lobbyId) ?? peopleFromRoster(roster),
        };
      });
    },

    "dashboard.messages": async (p) => {
      const seats = this.db.activeSeats().filter((s) => s.lobby_id === p.lobbyId);
      if (seats.length === 0) return [];
      const view = this.viewSeat(seats);
      const events = this.db.messagesForSeats(seats.map((s) => s.seat_id), Number(p.limit ?? 200));
      return events.map((e) => this.dashboardMessage(view, e));
    },

    // One waiter per seat: a newer wait (the next idle period) replaces the older one.
    "inbox.wait": async (p) => {
      // Secure mode: peer messages never wake the agent; it sees them when its user next talks to it.
      if (this.isSecure(this.session(p).seatKey)) return { unread: 0, secure: true };
      const seatId = this.seat(p).seat_id;
      const unread = this.db.unreadCount(seatId);
      if (unread > 0) return { unread };
      const older = this.inboxWaiters.get(seatId);
      if (older) older({ cancelled: true });
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
      // Hooks only report working or waiting; keep what the agent said it's working on.
      let workingOn = p.workingOn;
      if (workingOn === undefined) {
        workingOn = this.db.roster(seat.seat_id).find((a) => a.agentId === seat.agent_id)?.workingOn ?? "";
      }
      this.connections.get(seat.seat_id)?.send({ t: "presence", status, workingOn: String(workingOn) });
      return {};
    },
  };


  private async sendMessage(seat: Seat, p: Params): Promise<{ id: string; seq?: number; queued?: boolean }> {
    const body = String(p.body ?? "");
    const attachments = (p.attachments ?? undefined) as Envelope["attachments"];
    const texts = [body];
    let attachmentBytes = 0;
    for (const attachment of attachments ?? []) {
      texts.push(attachment.content);
      attachmentBytes += Buffer.byteLength(attachment.content);
    }
    const secret = findSecret(texts.join("\n"));
    if (secret && !p.allowSecret) throw new DaemonError("secret_detected", `message contains what looks like a secret (${secret})`);
    if (Buffer.byteLength(body) > LIMITS.maxBodyBytes) throw new DaemonError("too_large", "message is too long (16 KB at most)");
    if (attachmentBytes > LIMITS.maxAttachmentBytesTotal) throw new DaemonError("too_large", "attachments are too large (64 KB at most)");

    let parent: Envelope | undefined;
    if (p.inReplyTo) {
      parent = this.db.findEnvelope(seat.seat_id, String(p.inReplyTo));
      if (!parent) throw new DaemonError("bad_reply", `no message with id ${p.inReplyTo}`);
    }

    // A reply with no recipient goes back to whoever asked.
    let to: Recipient;
    if (p.to === undefined && parent) to = { kind: "direct", agentId: parent.from };
    else to = this.resolveTo(seat, String(p.to ?? "all"));

    const lobbyKey = await this.waitForLobbyKey(seat.lobby_id);
    const id = ulid();
    const type = (p.type ?? "update") as Envelope["type"];
    const content = attachments ? { body, attachments } : { body };
    const sealed = encryptContent(lobbyKey.key, { lobbyId: seat.lobby_id, id, from: seat.agent_id, type, epoch: lobbyKey.epoch }, content);

    const unsigned: Omit<Envelope, "sig"> = {
      v: 2, id, lobbyId: seat.lobby_id, from: seat.agent_id, to, type,
      threadDepth: parent ? parent.threadDepth + 1 : 0, sealed, createdAt: Date.now(),
    };
    if (parent) unsigned.inReplyTo = parent.id;
    const envelope = await signEnvelope(webCrypto, loadKey(this.opts.home, seat.seat_id), unsigned);

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
    return { id: envelope.id, seq: reply.seq };
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
      accountToken: async () => {
        if (!this.db.account()) return undefined;
        return this.accountToken();
      },
      onRejected: () => this.rejectedTokens.add(seat.seat_id),
      clientVersion: CLIENT_VERSION,
      cursor: () => this.db.cursor(seat.seat_id),
      onFrame: (frame) => this.onFrame(seat, conn, frame),
      onState: (state): void => this.onState(seat, conn, state),
    });
    this.connections.set(seat.seat_id, conn);
    void conn.start();
  }

  /** The signed-in account's token, refreshed with the machine key when it is expiring or unreadable (LLD 14.2). */
  private async accountToken(): Promise<string> {
    const account = this.db.account();
    if (!account) throw new DaemonError("login_required", "Sign in first with `agentlobbies login`.");
    if (!expiresWithinAnHour(account.token)) return account.token;
    const ts = Date.now();
    const sig = await webCrypto.sign(loadKey(this.opts.home, "machine"), refreshSigningBytes({ lobbyId: "account", agentId: account.machine_id, ts }));
    let token: string;
    try {
      ({ token } = await this.relay<{ token: string }>("/v1/auth/refresh", { machineId: account.machine_id, ts, sig: toB64u(sig) }));
    } catch {
      throw new DaemonError("login_required", "Your sign-in expired. Run `agentlobbies login` again.");
    }
    this.db.setAccountToken(token);
    return token;
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
    if (state === "closed") {
      // The lobby was deleted: keep nothing from it on this machine.
      this.forgetLobby(seat.lobby_id);
      return;
    }
    if (state === "kicked" || state === "upgrade_required") {
      this.db.setSeatState(seat.seat_id, state);
    }
    this.emit("notify", { method: "seat.state", params: { seatId: seat.seat_id, state } });
    this.emit("activity", { type: "connection", lobbyId: seat.lobby_id, state });
  }

  private async onFrame(seat: Seat, conn: Connection, frame: ServerFrame): Promise<void> {
    if (!this.running) return;
    switch (frame.t) {
      case "keys":
        return this.onKeys(seat, conn, frame);
      case "welcome": {
        const me = frame.roster.find((a) => a.agentId === seat.agent_id);
        if (me) this.noticeProfileChange(seat, me);
        this.db.replaceRoster(seat.seat_id, frame.roster);
        this.emit("activity", { type: "roster", lobbyId: seat.lobby_id });
        return;
      }
      case "roster":
        if (frame.agent.agentId === seat.agent_id) this.noticeProfileChange(seat, frame.agent);
        this.db.upsertRoster(seat.seat_id, [frame.agent]);
        this.emit("activity", { type: "roster", lobbyId: seat.lobby_id });
        return;
      case "events": {
        this.store(seat, frame.events);
        const last = frame.events.at(-1);
        if (last) conn.send({ t: "ack", seq: last.seq });
        if (frame.more) conn.send({ t: "replay.more", afterSeq: last ? last.seq : this.db.cursor(seat.seat_id) });
        return;
      }
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
  private store(seat: Seat, received: LobbyEvent[]): void {
    if (received.length === 0) return;
    const events: LobbyEvent[] = [];
    const locked = new Set<string>();
    const broken: string[] = [];
    for (const e of received) {
      if (e.kind !== "message") {
        events.push(e);
        continue;
      }
      const opened = this.openEnvelope(seat.lobby_id, e.envelope);
      if (opened === "locked") {
        locked.add(e.envelope.id);
        events.push(e);
      } else if (opened === "broken") {
        broken.push(e.envelope.id);
        events.push(e);
      } else {
        events.push({ ...e, envelope: opened });
      }
    }
    this.db.ingest(seat.seat_id, events, locked);
    // A message that fails authentication was changed or forged; it is never shown.
    for (const id of broken) this.db.markSurfaced(seat.seat_id, id);
    for (const e of events) {
      if (e.kind === "system" && e.system.type === "joined") this.db.addToRoster(seat.seat_id, e.system.agent);
      if (e.kind === "system" && e.system.type === "left") this.db.removeFromRoster(seat.seat_id, e.system.agentId);
    }
    const last = events.at(-1)!.seq;
    this.db.setCursor(seat.seat_id, last);
    for (const e of events) this.emitMessage(seat, e);
    if (events.some((e) => e.kind === "system")) this.emit("activity", { type: "roster", lobbyId: seat.lobby_id });
    if (this.db.unreadCount(seat.seat_id) > 0) this.wakeWaiter(seat.seat_id);
  }

  /**
   * The user renamed this agent or changed what it owns (from a dashboard): keep the seat's name in step
   * and tell the agent on its next turn. Call before the roster is updated, so the old profile is still there.
   */
  private noticeProfileChange(seat: Seat, updated: AgentProfile): void {
    const before = this.db.roster(seat.seat_id).find((a) => a.agentId === seat.agent_id);
    if (!before) return;
    const renamed = before.handle !== updated.handle;
    const ownsChanged = before.owns.join(",") !== updated.owns.join(",");
    if (!renamed && !ownsChanged) return;

    const changes = [];
    if (renamed) {
      this.db.setSeatHandle(seat.seat_id, updated.handle);
      changes.push(`you are now ${updated.handle}`);
    }
    if (ownsChanged) changes.push(`you now own: ${updated.owns.join(", ") || "nothing"}`);
    this.db.addNotice(seat.seat_id, `Your user updated you in lobby ${seat.lobby_name ?? seat.lobby_id.slice(0, 8)}: ${changes.join("; ")}.`);
    this.wakeWaiter(seat.seat_id);
  }

  /** Tells whoever waits on this seat's inbox (the Stop hook, an MCP server) how many messages are unread. */
  private wakeWaiter(seatId: string): void {
    const unread = this.db.unreadCount(seatId);
    const waiter = this.inboxWaiters.get(seatId);
    if (waiter) waiter({ unread });
    this.emit("notify", { method: "inbox.new", params: { seatId, unread } });
  }

  /** Acks live events every 250 ms or 20 events, whichever comes first, to save relay writes (LLD 7.5). */
  private ackSoon(seatId: string, conn: Connection, seq: number): void {
    let pending = this.pendingAcks.get(seatId);
    if (!pending) {
      pending = { seq, count: 0, conn, timer: setTimeout(() => this.flushAck(seatId), 250) };
    }
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
    if (frame.t === "err" && frame.code === "key_rotating") {
      void this.resealAndResend(seat, frame.reqId!);
      return;
    }
    this.finishReply(seat, frame);
  }

  /** The relay accepted or refused a message for good: record it and tell whoever is waiting. */
  private finishReply(seat: Seat, frame: OkOrErr): void {
    const reqId = frame.reqId!;
    this.reseals.delete(reqId);
    this.db.finishOutbox(reqId, frame.t === "ok" ? "done" : "failed");
    if (frame.t === "ok" && frame.seq) {
      const sent = this.db.outboxFrame(reqId) as { envelope: Envelope } | undefined;
      if (sent) {
        let envelope = sent.envelope;
        const opened = this.openEnvelope(seat.lobby_id, envelope);
        if (opened !== "locked" && opened !== "broken") envelope = opened;
        const own: LobbyEvent = { kind: "message", seq: frame.seq, committedAt: Date.now(), envelope };
        this.db.recordOwn(seat.seat_id, own);
        this.emitMessage(seat, own);
      }
    }
    const waiter = this.waiters.get(reqId);
    if (waiter) waiter(frame);
    this.waiters.delete(reqId);
  }


  /**
   * The lobby switched keys (someone left) before this message went out, whether it was just written or
   * queued while offline. Seal it again under the new key, keeping its id, and send it again.
   */
  private async resealAndResend(seat: Seat, reqId: string): Promise<void> {
    const attempts = (this.reseals.get(reqId) ?? 0) + 1;
    this.reseals.set(reqId, attempts);
    const sent = this.db.outboxFrame(reqId) as { envelope: Envelope } | undefined;
    const opened = sent && this.openEnvelope(seat.lobby_id, sent.envelope);
    let lobbyKey: { epoch: number; key: Uint8Array } | undefined;
    if (opened && opened !== "locked" && opened !== "broken" && attempts <= 3) {
      try {
        lobbyKey = await this.waitForLobbyKey(seat.lobby_id);
      } catch {
        lobbyKey = undefined;
      }
    }
    if (!sent || !opened || opened === "locked" || opened === "broken" || !lobbyKey) {
      this.finishReply(seat, { t: "err", reqId, code: "key_rotating", message: "the lobby switched keys and this message couldn't be sent again" });
      return;
    }

    const e = sent.envelope;
    const content = opened.attachments ? { body: opened.body ?? "", attachments: opened.attachments } : { body: opened.body ?? "" };
    const sealed = encryptContent(lobbyKey.key, { lobbyId: e.lobbyId, id: e.id, from: e.from, type: e.type, epoch: lobbyKey.epoch }, content);
    const unsigned: Omit<Envelope, "sig"> = { v: 2, id: e.id, lobbyId: e.lobbyId, from: e.from, to: e.to, type: e.type, threadDepth: e.threadDepth, sealed, createdAt: e.createdAt };
    if (e.inReplyTo) unsigned.inReplyTo = e.inReplyTo;
    const frame = { t: "send" as const, reqId, envelope: await signEnvelope(webCrypto, loadKey(this.opts.home, seat.seat_id), unsigned) };
    this.db.replaceOutboxFrame(reqId, frame);
    const conn = this.connections.get(seat.seat_id);
    if (conn?.state === "live") conn.send(frame); // otherwise it goes out with the rest of the outbox on reconnect
  }

  /** Disconnects this machine's seats in a lobby and erases what it kept about it. */
  private forgetLobby(lobbyId: string): void {
    for (const seat of this.db.activeSeats()) {
      if (seat.lobby_id !== lobbyId) continue;
      this.connections.get(seat.seat_id)?.stop();
      this.connections.delete(seat.seat_id);
    }
    this.db.forgetLobby(lobbyId);
    this.emit("activity", { type: "lobbies" });
    this.emit("activity", { type: "agents" });
  }

  /** Hosts see every message, so a local host seat gives the fullest view of a lobby. */
  private viewSeat(seats: Seat[]): Seat {
    return seats.find((s) => s.seat_key === PERSON) ?? seats[0]!;
  }

  private dashboardMessage(view: Seat, e: LobbyEvent) {
    if (e.kind !== "message") throw new Error("only messages");
    const { envelope: env } = e;
    const handleOf = (agentId: string) => this.db.roster(view.seat_id).find((a) => a.agentId === agentId)?.handle ?? agentId;
    let to: string;
    if (env.to.kind === "broadcast") to = "all";
    else if (env.to.kind === "topic") to = `#${env.to.topic}`;
    else to = handleOf(env.to.agentId);
    return {
      id: env.id, seq: e.seq, from: handleOf(env.from), to, type: env.type, body: env.body ?? null,
      inReplyTo: env.inReplyTo ?? null, committedAt: e.committedAt,
    };
  }

  private emitMessage(seat: Seat, e: LobbyEvent): void {
    if (e.kind !== "message") return;
    this.emit("activity", { type: "message", lobbyId: seat.lobby_id, message: this.dashboardMessage(seat, e) });
  }

  private surface(seat: Seat, e: LobbyEvent): SurfacedMessage {
    if (e.kind !== "message") throw new Error("only messages are surfaced");
    const env = e.envelope;
    const message: SurfacedMessage = {
      id: env.id, seq: e.seq, from: env.from, fromAgentId: env.from, type: env.type, to: env.to, body: env.body ?? "",
    };
    const sender = this.db.roster(seat.seat_id).find((a) => a.agentId === env.from);
    if (sender) {
      message.from = sender.handle;
      message.fromClient = sender.client;
      if (sender.model) message.fromModel = sender.model;
      if (sender.owner) message.fromOwner = sender.owner.login;
    }
    if (env.inReplyTo) message.inReplyTo = env.inReplyTo;
    if (env.attachments) message.attachments = env.attachments;
    return message;
  }

  private addSeat(seatKey: string, s: { lobbyId: string; lobbyName: string | null; agentId: string; handle: string; role: Seat["role"]; token: string }, secretKey: Uint8Array): Seat {
    const seatId = ulid();
    saveKey(this.opts.home, seatId, secretKey);
    this.db.insertSeat({
      seat_id: seatId, seat_key: seatKey, lobby_id: s.lobbyId, lobby_name: s.lobbyName, agent_id: s.agentId,
      handle: s.handle, role: s.role, relay_url: this.opts.relayUrl, jwt: s.token,
    }, Date.now());
    const seat = this.db.activeSeatIn(seatKey, s.lobbyId)!;
    if (seatKey === PERSON || this.isRunning(seatKey)) this.connect(seat);
    return seat;
  }

  /** True while an agent's own session (its MCP server) is open, not just one of its hooks. */
  private isRunning(seatKey: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.seatKey === seatKey && !session.passive) return true;
    }
    return false;
  }

  /** Connects every lobby seat of an agent that isn't connected yet. */
  private connectAgent(seatKey: string): void {
    for (const seat of this.db.seatsFor(seatKey)) {
      if (!this.connections.has(seat.seat_id)) this.connect(seat);
    }
  }

  private signOutLocally(): void {
    this.userLink?.stop();
    this.userLink = undefined;
    this.db.clearAccount();
    this.emit("activity", { type: "lobbies" });
  }

  /** Signed in: make sure this machine can receive lobby keys, connect to the user object, and sync lobbies. */
  private async afterSignIn(): Promise<void> {
    if (!this.db.account()) return;
    try {
      await this.ensureBoxKeys();
    } catch {
      // Retried on the next start; until then this machine just doesn't receive keys.
    }
    this.userLink?.stop();
    this.userLink = new UserLink({
      url: `${this.opts.relayUrl.replace(/^http/, "ws")}/v1/me/ws`,
      token: () => this.accountToken(),
      agents: () => this.localAgents(),
      onCall: (method, params) => {
        if (!WEB_METHODS.has(method)) throw new DaemonError("forbidden", `${method} can't be called from the web`);
        return this.call(method, params);
      },
      onRevoked: () => this.signOutLocally(),
      onLobbiesChanged: () => {
        this.syncMemberships().catch(() => {
          // The next change, or the next start, syncs again.
        });
      },
    });
    void this.userLink.start();
    try {
      await this.syncMemberships();
    } catch {
      // Offline or signed out on the relay; the next start or lobby change syncs again.
    }
  }

  /** Machines that signed in before v0.4 make their encryption key now (LLD 15.2). */
  private async ensureBoxKeys(): Promise<void> {
    if (this.boxKeys()) return;
    const box = await generateBoxKeys();
    await this.relay("/v1/auth/box-key", { boxPublicKey: toB64u(box.publicKey) }, await this.accountToken());
    this.saveBoxKeys(box);
  }

  private boxKeys(): BoxKeys | undefined {
    if (!hasKey(this.opts.home, "machine-box") || !hasKey(this.opts.home, "machine-box-public")) return undefined;
    return { privateKey: loadKey(this.opts.home, "machine-box"), publicKey: loadKey(this.opts.home, "machine-box-public") };
  }

  private saveBoxKeys(box: BoxKeys): void {
    saveKey(this.opts.home, "machine-box", box.privateKey);
    saveKey(this.opts.home, "machine-box-public", box.publicKey);
  }

  /**
   * Gives this machine a person seat in every lobby its user belongs to (LLD 15.6). Runs one at a
   * time, so two syncs never add two seats for the same lobby.
   */
  private syncMemberships(): Promise<void> {
    const previous = this.syncing;
    const run = async () => {
      try {
        await previous;
      } catch {
        // The earlier sync's caller already got its error.
      }
      await this.addMissingPersonSeats();
    };
    this.syncing = run();
    return this.syncing;
  }

  private async addMissingPersonSeats(): Promise<void> {
    const account = this.db.account();
    if (!account) return;
    const lobbies = await this.relay<{ lobbyId: string; name: string | null; people: LobbyPerson[] }[]>("/v1/lobbies", undefined, await this.accountToken(), "GET");
    this.people.clear();
    for (const lobby of lobbies) this.people.set(lobby.lobbyId, lobby.people);
    this.emit("activity", { type: "lobbies" });
    let added = false;
    for (const lobby of lobbies) {
      if (this.db.activeSeatIn(PERSON, lobby.lobbyId)) continue;
      const keys = await generateSeatKeys();
      const person = { handle: personHandle(account.login), client: "cli" as const, owns: [], workingOn: "", publicKey: toB64u(keys.publicKey) };
      const res = await this.relay<{ agentId: string; token: string; handle: string; role: Seat["role"] }>(
        `/v1/lobbies/${lobby.lobbyId}/people`, { person }, await this.accountToken(),
      );
      this.addSeat(PERSON, { lobbyId: lobby.lobbyId, lobbyName: lobby.name, agentId: res.agentId, handle: res.handle, role: res.role, token: res.token }, keys.secretKey);
      added = true;
    }
    if (added) this.emit("activity", { type: "lobbies" });
  }

  /**
   * Opens the lobby keys sealed to this machine, then does whatever the lobby needs from an online
   * member: make the first key, rotate it, or seal it for machines that lack it (LLD 15.4).
   */
  private async onKeys(seat: Seat, conn: Connection, frame: KeysFrame): Promise<void> {
    const box = this.boxKeys();
    const account = this.db.account();
    if (!box || !account) return;
    const lobbyId = seat.lobby_id;

    for (const { epoch, sealed } of frame.mine) {
      if (this.db.lobbyKey(lobbyId, epoch)) continue;
      try {
        this.db.saveLobbyKey(lobbyId, epoch, await openLobbyKey(box.privateKey, lobbyId, epoch, sealed));
      } catch {
        // Sealed to a box key this machine no longer has; another member will seal it again.
      }
    }
    this.unlockMessages(lobbyId);

    if (frame.current > 0 && frame.rotate) this.rotating.add(lobbyId);
    else this.rotating.delete(lobbyId);

    // Every seat in the lobby gets this frame; one of them does the work for this machine.
    const seatsHere = this.db.activeSeats().filter((s) => s.lobby_id === lobbyId);
    if (this.viewSeat(seatsHere).seat_id !== seat.seat_id) return;
    if (!frame.machines.some((m) => m.machineId === account.machine_id)) return;

    if (frame.current === 0 || frame.rotate) {
      const epoch = frame.current + 1;
      const key = newLobbyKey();
      const sealed = [];
      // This machine first: the batch that creates the key must include its own copy.
      const machines = [...frame.machines].sort((a, b) => Number(b.machineId === account.machine_id) - Number(a.machineId === account.machine_id));
      for (const machine of machines) {
        const one = await sealFor(machine, lobbyId, epoch, key);
        if (one) sealed.push(one);
      }
      const [first = [], ...rest] = batches(sealed);
      conn.send({ t: "keys.put", reqId: ulid(), epoch, create: true, sealed: first });
      for (const batch of rest) conn.send({ t: "keys.put", reqId: ulid(), epoch, create: false, sealed: batch });
      return;
    }

    const byEpoch = new Map<number, { machineId: string; sealed: string }[]>();
    for (const { machineId, epochs } of frame.missing) {
      const machine = frame.machines.find((m) => m.machineId === machineId);
      if (!machine) continue;
      for (const epoch of epochs) {
        const key = this.db.lobbyKey(lobbyId, epoch);
        if (!key) continue;
        const one = await sealFor(machine, lobbyId, epoch, key);
        if (!one) continue;
        if (!byEpoch.has(epoch)) byEpoch.set(epoch, []);
        byEpoch.get(epoch)!.push(one);
      }
    }
    for (const [epoch, sealed] of byEpoch) {
      for (const batch of batches(sealed)) conn.send({ t: "keys.put", reqId: ulid(), epoch, create: false, sealed: batch });
    }
  }

  /** Decrypts an envelope with this machine's key for its epoch: "locked" if the key hasn't arrived, "broken" if it fails. */
  private openEnvelope(lobbyId: string, envelope: Envelope): Envelope | "locked" | "broken" {
    if (!envelope.sealed || envelope.body !== undefined) return envelope;
    const key = this.db.lobbyKey(lobbyId, envelope.sealed.epoch);
    if (!key) return "locked";
    try {
      const binding = { lobbyId, id: envelope.id, from: envelope.from, type: envelope.type, epoch: envelope.sealed.epoch };
      return { ...envelope, ...decryptContent(key, binding, envelope.sealed) };
    } catch {
      return "broken";
    }
  }

  /** Messages that arrived before their key: decrypt them now and let waiting agents know. */
  private unlockMessages(lobbyId: string): void {
    const seatsWithNew = new Set<string>();
    for (const row of this.db.lockedMessages(lobbyId)) {
      const event = JSON.parse(row.event_json) as Extract<LobbyEvent, { kind: "message" }>;
      const opened = this.openEnvelope(lobbyId, event.envelope);
      if (opened === "locked") continue;
      if (opened === "broken") {
        this.db.unlock(row.seat_id, row.seq, row.event_json);
        this.db.markSurfaced(row.seat_id, event.envelope.id);
        continue;
      }
      this.db.unlock(row.seat_id, row.seq, JSON.stringify({ ...event, envelope: opened }));
      seatsWithNew.add(row.seat_id);
    }
    for (const seatId of seatsWithNew) this.wakeWaiter(seatId);
    if (seatsWithNew.size > 0) this.emit("activity", { type: "roster", lobbyId });
  }

  /**
   * The newest lobby key, waiting briefly for one in a lobby that was just created or joined, or that
   * is switching keys because someone left (nothing goes out under a key they had).
   */
  private async waitForLobbyKey(lobbyId: string): Promise<{ epoch: number; key: Uint8Array }> {
    const deadline = Date.now() + KEY_WAIT_MS;
    for (;;) {
      const key = this.db.latestLobbyKey(lobbyId);
      if (key && !this.rotating.has(lobbyId)) return key;
      if (Date.now() > deadline && this.rotating.has(lobbyId)) {
        throw new DaemonError("key_rotating", "This lobby is switching to a new encryption key after someone left. Try again in a moment.");
      }
      if (Date.now() > deadline) {
        throw new DaemonError("waiting_for_key",
          "This lobby's encryption key hasn't reached this machine yet. It arrives as soon as another member's machine is online.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** How many messages from this agent, in any of its lobbies, are waiting for approval. */
  private pendingCount(seatKey: string, pendingBySeat: Map<string, number>): number {
    let count = 0;
    for (const seat of this.db.seatsFor(seatKey)) count += pendingBySeat.get(seat.seat_id) ?? 0;
    return count;
  }

  private isSecure(seatKey: string): boolean {
    return this.db.localAgent(seatKey)?.secure === 1;
  }

  /** Checks a message like a real send would, then keeps it for the user to approve or discard. */
  private holdForApproval(seat: Seat, p: Params): { id: string; pendingApproval: true } {
    const body = String(p.body ?? "");
    if (!body.trim()) throw new DaemonError("bad_request", "message is empty");
    if (p.to !== undefined) this.resolveTo(seat, String(p.to)); // a wrong recipient fails now, not after approval
    const id = ulid();
    const params: Params = { to: p.to, type: p.type ?? "update", body, inReplyTo: p.inReplyTo, attachments: p.attachments };
    this.db.addPendingSend(id, seat.seat_id, params);
    this.emit("activity", { type: "agents" });
    return { id, pendingApproval: true };
  }

  private describePending(pending: { id: string; seat_id: string; params: string; created_at: number }) {
    const seat = this.db.seat(pending.seat_id);
    const params = JSON.parse(pending.params) as Params;
    let to = String(params.to ?? "");
    if (!to && params.inReplyTo) {
      const parent = this.db.findEnvelope(seat.seat_id, String(params.inReplyTo));
      to = this.db.roster(seat.seat_id).find((a) => a.agentId === parent?.from)?.handle ?? "the asker";
    }
    return {
      id: pending.id, lobbyId: seat.lobby_id, lobbyName: seat.lobby_name, agent: seat.handle, to: to || "all",
      type: String(params.type ?? "update"), body: String(params.body ?? ""), createdAt: pending.created_at,
    };
  }

  private localAgents() {
    const pendingBySeat = new Map<string, number>();
    for (const pending of this.db.pendingSends()) pendingBySeat.set(pending.seat_id, (pendingBySeat.get(pending.seat_id) ?? 0) + 1);
    return this.db.localAgents().map((a) => ({
      seatKey: a.seat_key,
      client: a.client,
      folder: basename(a.cwd),
      cwd: a.cwd,
      online: this.isRunning(a.seat_key),
      lastUsedAt: a.last_seen_at, // when its session last started
      secure: a.secure === 1,
      pendingApprovals: this.pendingCount(a.seat_key, pendingBySeat),
      lobbies: this.db.seatsFor(a.seat_key).map((s) => ({ lobbyId: s.lobby_id, name: s.lobby_name, handle: s.handle, agentId: s.agent_id })),
    }));
  }

  private requireAccount(): Account {
    const account = this.db.account();
    if (!account) throw new DaemonError("login_required", "Sign in first with `agentlobbies login`.");
    return account;
  }

  private session(p: Params): Session {
    const session = this.sessions.get(String(p.sessionId));
    if (!session) throw new DaemonError("no_session", "call session.open first");
    return session;
  }

  private seat(p: Params): Seat {
    const { seatKey } = this.session(p);
    const seat = p.lobbyId ? this.db.activeSeatIn(seatKey, String(p.lobbyId)) : this.db.activeSeat(seatKey);
    if (!seat) throw new DaemonError("no_seat", "You are not in a lobby yet. Your user can add you from the dashboard (`agentlobbies dashboard`).");
    return seat;
  }

  private async relay<T>(path: string, body: unknown, token?: string, method = "POST"): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json", "X-Agentlobbies-Client": CLIENT_VERSION };
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(this.opts.relayUrl + path, init);
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as T & { error?: { code: string; message: string } };
    if (!res.ok) throw new DaemonError(json.error?.code ?? "relay_error", json.error?.message ?? `relay returned ${res.status}`);
    return json;
  }
}

/** One person in a lobby, from the relay's membership list. */
interface LobbyPerson {
  login: string;
  avatarUrl: string;
  role: "owner" | "member" | "viewer";
}

/** Until the relay's list arrives (offline, or not synced yet), the people with a seat in the roster. */
function peopleFromRoster(roster: AgentProfile[]): LobbyPerson[] {
  const role = { host: "owner", member: "member", observer: "viewer" } as const;
  const byLogin = new Map<string, LobbyPerson>();
  for (const seat of roster) {
    if (seat.client === "cli" && seat.owner) byLogin.set(seat.owner.login, { ...seat.owner, role: role[seat.role] });
  }
  return [...byLogin.values()];
}

/** Splits sealed keys into the most one keys.put frame may carry. */
function batches<T>(items: T[]): T[][] {
  const out = [];
  for (let i = 0; i < items.length; i += LIMITS.maxMachinesPerLobby) out.push(items.slice(i, i + LIMITS.maxMachinesPerLobby));
  return out;
}

/** Seals a lobby key to one machine, or skips it if its key can't be used, so one bad key can't stop the others. */
async function sealFor(machine: { machineId: string; boxPublicKey: string }, lobbyId: string, epoch: number, key: Uint8Array) {
  try {
    return { machineId: machine.machineId, sealed: await sealLobbyKey(machine.boxPublicKey, lobbyId, epoch, key) };
  } catch {
    return undefined;
  }
}
