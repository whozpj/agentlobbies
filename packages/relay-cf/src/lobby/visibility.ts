import type { LobbyEvent, Role } from "@agentlobbies/protocol";

export interface Viewer {
  agentId: string;
  role: Role;
  topics: Set<string>;
  observersSeeDirects: boolean;
}

// The same rule as VISIBLE_SQL below; a property test keeps the two in sync (I10).
export function isVisible(event: LobbyEvent, viewer: Viewer): boolean {
  if (event.kind !== "message") return true;
  const { from, to } = event.envelope;
  if (from === viewer.agentId) return false;
  if (viewer.role === "host" || to.kind === "broadcast") return true;
  if (to.kind === "direct") return to.agentId === viewer.agentId || (viewer.role === "observer" && viewer.observersSeeDirects);
  return viewer.role === "observer" || viewer.topics.has(to.topic);
}

/** WHERE clause over the events table. Bind with visibleSqlParams(). */
export const VISIBLE_SQL = `(
  kind != 'message' OR (
    from_agent != ? AND (
      ? = 'host'
      OR to_kind = 'broadcast'
      OR (to_kind = 'direct' AND (to_target = ? OR (? = 'observer' AND ? = 1)))
      OR (to_kind = 'topic' AND (? = 'observer' OR to_target IN (SELECT topic FROM subscriptions WHERE agent_id = ?)))
    )
  )
)`;

export function visibleSqlParams(viewer: Omit<Viewer, "topics">): (string | number)[] {
  const { agentId, role } = viewer;
  return [agentId, role, agentId, role, viewer.observersSeeDirects ? 1 : 0, role, agentId];
}
