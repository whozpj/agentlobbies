import type { Envelope, ErrorCode, LobbyEvent, Role } from "@agentlobbies/protocol";
import { commit } from "./events";
import { getAgent, isActive } from "./membership";
import { getSettings, isOpen } from "./meta";
import { tryTake } from "./limiter";
import { isVisible } from "./visibility";

export type SendResult =
  | { seq: number; event?: LobbyEvent }
  | { error: ErrorCode; retryAfterMs?: number };

function subscribedTopics(sql: SqlStorage, agentId: string): Set<string> {
  const rows = sql.exec<{ topic: string }>("SELECT topic FROM subscriptions WHERE agent_id = ?", agentId).toArray();
  return new Set(rows.map((r) => r.topic));
}

/** Membership, threading, depth, and recipient checks against current state (LLD 5.8). */
function validate(storage: DurableObjectStorage, agentId: string, e: Envelope): ErrorCode | undefined {
  const { sql } = storage;
  const sender = getAgent(sql, agentId);
  if (!isActive(sender)) return "kicked";
  const settings = getSettings(sql);

  if (e.type === "answer" && !e.inReplyTo) return "bad_reply";
  if (e.inReplyTo) {
    const parent = sql.exec<{ thread_depth: number; from_agent: string; event_json: string }>(
      "SELECT thread_depth, from_agent, event_json FROM events WHERE id = ? AND kind = 'message'", e.inReplyTo,
    ).toArray()[0];
    if (!parent) return "bad_reply";
    // A parent is valid if the sender wrote it or can see it (G8).
    const viewer = { agentId, role: sender.role as Role, topics: subscribedTopics(sql, agentId), observersSeeDirects: settings.observersSeeDirects };
    if (parent.from_agent !== agentId && !isVisible(JSON.parse(parent.event_json), viewer)) return "bad_reply";
    if (e.threadDepth !== parent.thread_depth + 1) return "bad_reply";
  } else if (e.threadDepth !== 0) {
    return "bad_reply";
  }
  if (e.threadDepth > settings.maxThreadDepth) return "thread_too_deep";

  if (e.to.kind === "direct") {
    const target = getAgent(sql, e.to.agentId);
    if (!isActive(target) || target.agent_id === agentId) return "unknown_recipient";
  }
  return undefined;
}

/**
 * Everything after signature verification, in one synchronous block (LLD 5.1, 5.8).
 * The caller fans out `event` after this returns.
 */
export function doSend(storage: DurableObjectStorage, agentId: string, e: Envelope, now: number): SendResult {
  const { sql } = storage;
  if (!isOpen(sql)) return { error: "lobby_closed" };

  // A resend after a reconnect gets the original seq back (I5).
  const existing = sql.exec<{ seq: number }>("SELECT seq FROM events WHERE id = ?", e.id).toArray()[0];
  if (existing) return { seq: existing.seq };

  const problem = validate(storage, agentId, e);
  if (problem) return { error: problem };

  const rate = tryTake(sql, agentId, now, getSettings(sql).sendPerMinute);
  if (!rate.ok) return { error: "rate_limited", retryAfterMs: rate.retryAfterMs };

  const event = commit(storage, { kind: "message", envelope: e }, { id: e.id, from: agentId, to: e.to, depth: e.threadDepth }, now);
  return { seq: event.seq, event };
}
