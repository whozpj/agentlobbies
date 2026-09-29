import { LIMITS, type Envelope, type LobbyEvent, type RejectReason, type Role } from "@agentlobbies/protocol";
import { commit } from "./events";
import { getAgent, isActive } from "./membership";
import { getSettings, isOpen } from "./meta";
import { tryTake } from "./limiter";
import { isVisible } from "./visibility";

export type SendResult =
  | { seq: number; event?: LobbyEvent }
  | { held: true }
  | { error: string; retryAfterMs?: number };

// How each validation failure is reported to a sender (decideHeld records the reason instead).
const REJECT_TO_ERROR: Record<RejectReason, string> = {
  rejected_by_host: "already_rejected",
  sender_inactive: "kicked",
  recipient_inactive: "unknown_recipient",
  parent_missing: "bad_reply",
  thread_too_deep: "thread_too_deep",
};

function subscribedTopics(sql: SqlStorage, agentId: string): Set<string> {
  return new Set(sql.exec<{ topic: string }>("SELECT topic FROM subscriptions WHERE agent_id = ?", agentId).toArray().map((r) => r.topic));
}

/** Membership, threading, depth, and recipient checks against current state (LLD 5.8). */
export function validate(storage: DurableObjectStorage, agentId: string, e: Envelope): RejectReason | undefined {
  const { sql } = storage;
  const sender = getAgent(sql, agentId);
  if (!isActive(sender)) return "sender_inactive";
  const settings = getSettings(sql);

  if (e.type === "answer" && !e.inReplyTo) return "parent_missing";
  if (e.inReplyTo) {
    const parent = sql.exec<{ thread_depth: number; from_agent: string; event_json: string }>(
      "SELECT thread_depth, from_agent, event_json FROM events WHERE id = ? AND kind = 'message'", e.inReplyTo,
    ).toArray()[0];
    if (!parent) return "parent_missing";
    // A parent is valid if the sender wrote it or can see it (G8).
    const viewer = { agentId, role: sender.role as Role, topics: subscribedTopics(sql, agentId), observersSeeDirects: settings.observersSeeDirects };
    if (parent.from_agent !== agentId && !isVisible(JSON.parse(parent.event_json), viewer)) return "parent_missing";
    if (e.threadDepth !== parent.thread_depth + 1) return "parent_missing";
  } else if (e.threadDepth !== 0) {
    return "parent_missing";
  }
  if (e.threadDepth > settings.maxThreadDepth) return "thread_too_deep";

  if (e.to.kind === "direct") {
    const target = getAgent(sql, e.to.agentId);
    if (!isActive(target) || target.agent_id === agentId) return "recipient_inactive";
  }
  return undefined;
}

function count(sql: SqlStorage, query: string, ...params: string[]): number {
  return sql.exec<{ n: number }>(query, ...params).one().n;
}

/**
 * Everything after signature verification, in one synchronous block (LLD 5.1, 5.8).
 * The caller fans out `event` after this returns.
 */
export function doSend(storage: DurableObjectStorage, agentId: string, e: Envelope, now: number): SendResult {
  const { sql } = storage;
  if (!isOpen(sql)) return { error: "lobby_closed" };

  // Idempotency: a retry returns the original result (I5, G2).
  const existing = sql.exec<{ seq: number }>("SELECT seq FROM events WHERE id = ?", e.id).toArray()[0];
  if (existing) return { seq: existing.seq };
  if (count(sql, "SELECT COUNT(*) AS n FROM held WHERE envelope_id = ?", e.id)) return { held: true };
  if (count(sql, "SELECT COUNT(*) AS n FROM rejected WHERE envelope_id = ?", e.id)) return { error: "already_rejected" };

  const problem = validate(storage, agentId, e);
  if (problem) return { error: REJECT_TO_ERROR[problem] };

  // Rate limit after validation and before the hold decision, so held messages cost the same (G10, H18).
  const settings = getSettings(sql);
  const rate = tryTake(sql, agentId, now, settings.sendPerMinute);
  if (!rate.ok) return { error: "rate_limited", retryAfterMs: rate.retryAfterMs };

  const role = getAgent(sql, agentId)!.role;
  const mustHold = role !== "host" && (settings.approvalMode === "all" || (settings.approvalMode === "flagged" && e.requiresApproval === true));
  if (mustHold) {
    const heldInLobby = count(sql, "SELECT COUNT(*) AS n FROM held");
    const heldFromSender = count(sql, "SELECT COUNT(*) AS n FROM held WHERE from_agent = ?", agentId);
    if (heldInLobby >= LIMITS.maxHeldPerLobby || heldFromSender >= LIMITS.maxHeldPerSender) return { error: "held_full" };
    sql.exec("INSERT INTO held VALUES (?, ?, ?, ?)", e.id, agentId, JSON.stringify(e), now);
    return { held: true };
  }

  const event = commit(storage, { kind: "message", envelope: e }, { id: e.id, from: agentId, to: e.to, depth: e.threadDepth }, now);
  return { seq: event.seq, event };
}
