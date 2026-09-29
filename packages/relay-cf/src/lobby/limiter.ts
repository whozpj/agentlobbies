import { RATES } from "@agentlobbies/protocol";

// Persisted so limits survive hibernation, which can happen after a few idle seconds (G9).

const LOBBY_BUCKET = "__lobby__";
const HOUR_MS = 3_600_000;

interface Bucket {
  tokens: number;
  refilled_at: number;
  hour_start: number;
  hour_count: number;
}

function load(sql: SqlStorage, id: string, capacity: number, now: number): Bucket {
  const row = sql.exec<Bucket & Record<string, SqlStorageValue>>(
    "SELECT tokens, refilled_at, hour_start, hour_count FROM rate_state WHERE agent_id = ?", id,
  ).toArray()[0];
  const bucket = row ?? { tokens: capacity, refilled_at: now, hour_start: now, hour_count: 0 };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.refilled_at) * capacity) / 60_000);
  bucket.refilled_at = now;
  if (now - bucket.hour_start >= HOUR_MS) {
    bucket.hour_start = now;
    bucket.hour_count = 0;
  }
  return bucket;
}

function save(sql: SqlStorage, id: string, b: Bucket): void {
  sql.exec(
    `INSERT INTO rate_state (agent_id, tokens, refilled_at, hour_start, hour_count) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET tokens = excluded.tokens, refilled_at = excluded.refilled_at,
       hour_start = excluded.hour_start, hour_count = excluded.hour_count`,
    id, b.tokens, b.refilled_at, b.hour_start, b.hour_count,
  );
}

function msUntilToken(b: Bucket, capacity: number): number {
  return b.tokens >= 1 ? 0 : Math.ceil(((1 - b.tokens) * 60_000) / capacity);
}

export function tryTake(
  sql: SqlStorage, agentId: string, now: number, perMinute: number,
): { ok: true } | { ok: false; retryAfterMs: number } {
  const lobbyPerMinute = RATES.lobbyEventsPerSecond * 60;
  const agent = load(sql, agentId, perMinute, now);
  const lobby = load(sql, LOBBY_BUCKET, lobbyPerMinute, now);
  const hourOk = agent.hour_count < RATES.sendPerHour;

  if (agent.tokens < 1 || lobby.tokens < 1 || !hourOk) {
    const retryAfterMs = Math.max(
      msUntilToken(agent, perMinute),
      msUntilToken(lobby, lobbyPerMinute),
      hourOk ? 0 : agent.hour_start + HOUR_MS - now,
    );
    return { ok: false, retryAfterMs };
  }

  agent.tokens -= 1;
  agent.hour_count += 1;
  lobby.tokens -= 1;
  save(sql, agentId, agent);
  save(sql, LOBBY_BUCKET, lobby);
  return { ok: true };
}
