import { LIMITS, LobbySettings, type AgentProfile, type JoinProfile, type LobbyEvent, type Role, type SystemEvent } from "@agentlobbies/protocol";
import { commit } from "./events";
import { isOpen, setMeta } from "./meta";
import { migrate } from "./schema";

interface AgentRow {
  agent_id: string;
  handle: string;
  client: string;
  model: string | null;
  owns: string;
  working_on: string;
  status: string;
  role: string;
  public_key: string;
  joined_at: number;
  last_seen_at: number;
  left_at: number | null;
  kicked_at: number | null;
  owner_id: string | null;
  owner_login: string | null;
  owner_avatar: string | null;
  [key: string]: SqlStorageValue;
}

export type NewAgent = JoinProfile & { agentId: string; owner?: { userId: string; login: string; avatarUrl: string } };

export function getAgent(sql: SqlStorage, agentId: string): AgentRow | undefined {
  return sql.exec<AgentRow>("SELECT * FROM agents WHERE agent_id = ?", agentId).toArray()[0];
}

export function isActive(agent: AgentRow | undefined): agent is AgentRow {
  return agent !== undefined && agent.left_at === null && agent.kicked_at === null;
}

/** An agent's current role. Roles are only ever read from this table (H9). */
export function roleOf(sql: SqlStorage, agentId: string): Role | undefined {
  const agent = getAgent(sql, agentId);
  return isActive(agent) ? (agent.role as Role) : undefined;
}

function toProfile(row: AgentRow): AgentProfile {
  const profile: AgentProfile = {
    agentId: row.agent_id, handle: row.handle, client: row.client as AgentProfile["client"],
    owns: JSON.parse(row.owns), workingOn: row.working_on, status: row.status as AgentProfile["status"],
    role: row.role as Role, publicKey: row.public_key, joinedAt: row.joined_at, lastSeenAt: row.last_seen_at,
  };
  if (row.model) profile.model = row.model;
  if (row.owner_login) profile.owner = { login: row.owner_login, avatarUrl: row.owner_avatar ?? "" };
  return profile;
}

export function roster(storage: DurableObjectStorage): AgentProfile[] {
  return storage.sql
    .exec<AgentRow>("SELECT * FROM agents WHERE left_at IS NULL AND kicked_at IS NULL ORDER BY joined_at, agent_id")
    .toArray()
    .map(toProfile);
}

function insertAgent(storage: DurableObjectStorage, agent: NewAgent, handle: string, role: Role, now: number): { profile: AgentProfile; joined: LobbyEvent } {
  storage.sql.exec(
    `INSERT INTO agents (agent_id, handle, client, model, owns, working_on, role, public_key, joined_at, last_seen_at,
                         owner_id, owner_login, owner_avatar)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent.agentId, handle, agent.client, agent.model ?? null, JSON.stringify(agent.owns), agent.workingOn, role,
    agent.publicKey, now, now, agent.owner?.userId ?? null, agent.owner?.login ?? null, agent.owner?.avatarUrl ?? null,
  );
  const profile = toProfile(getAgent(storage.sql, agent.agentId)!);
  const joined = commit(storage, { kind: "system", system: { type: "joined", agent: profile } }, {}, now);
  storage.sql.exec("UPDATE agents SET joined_seq = ? WHERE agent_id = ?", joined.seq, agent.agentId);
  return { profile, joined };
}

/** Creates the lobby: schema, metadata, and the host if there is one. */
export function initLobby(
  storage: DurableObjectStorage,
  args: { lobbyId: string; host?: NewAgent; settings: Partial<LobbySettings>; now: number },
): void {
  storage.transactionSync(() => {
    migrate(storage.sql);
    setMeta(storage.sql, "lobby_id", args.lobbyId);
    setMeta(storage.sql, "status", "open");
    setMeta(storage.sql, "created_at", args.now);
    setMeta(storage.sql, "min_retained_seq", 1);
    setMeta(storage.sql, "settings", JSON.stringify(LobbySettings.parse(args.settings)));
    const created: Extract<SystemEvent, { type: "lobby_created" }> = { type: "lobby_created" };
    if (args.host) created.hostId = args.host.agentId;
    commit(storage, { kind: "system", system: created }, {}, args.now);
    if (args.host) insertAgent(storage, args.host, args.host.handle, "host", args.now);
  });
}

function activeCount(sql: SqlStorage): number {
  return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE left_at IS NULL AND kicked_at IS NULL").one().n;
}

function handleTaken(sql: SqlStorage, handle: string): boolean {
  return sql.exec("SELECT 1 FROM agents WHERE handle = ? AND left_at IS NULL AND kicked_at IS NULL", handle).toArray().length > 0;
}

/** Picks the handle, or a suffixed one (-2 to -9) that still fits in 32 characters (G4). */
function freeHandle(sql: SqlStorage, wanted: string): string | undefined {
  if (!handleTaken(sql, wanted)) return wanted;
  for (let n = 2; n <= 9; n++) {
    const candidate = `${wanted.slice(0, 29)}-${n}`;
    if (!handleTaken(sql, candidate)) return candidate;
  }
  return undefined;
}

/** Marks an agent as removed, drops its subscriptions, and records a `left` event. */
export function removeFromLobby(storage: DurableObjectStorage, agentId: string, now: number): LobbyEvent {
  return storage.transactionSync(() => {
    storage.sql.exec("UPDATE agents SET kicked_at = ?, status = 'offline' WHERE agent_id = ?", now, agentId);
    storage.sql.exec("DELETE FROM subscriptions WHERE agent_id = ?", agentId);
    return commit(storage, { kind: "system", system: { type: "left", agentId, reason: "kicked" } }, {}, now);
  });
}

export type AdmitResult =
  | { handle: string; profile: AgentProfile; joined: LobbyEvent }
  | { error: "lobby_closed" | "lobby_full" | "handle_taken" };

export function admit(storage: DurableObjectStorage, agent: NewAgent, role: Role, now: number): AdmitResult {
  return storage.transactionSync(() => {
    if (!isOpen(storage.sql)) return { error: "lobby_closed" as const };
    if (activeCount(storage.sql) >= LIMITS.maxAgentsPerLobby) return { error: "lobby_full" as const };
    const handle = freeHandle(storage.sql, agent.handle);
    if (!handle) return { error: "handle_taken" as const };
    return { handle, ...insertAgent(storage, agent, handle, role, now) };
  });
}
