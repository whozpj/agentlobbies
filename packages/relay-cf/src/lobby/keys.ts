import type { ClientFrame, ServerFrame } from "@agentlobbies/protocol";
import { getMeta, setMeta } from "./meta";

export interface Machine {
  machineId: string;
  boxPublicKey: string;
}

type KeysPut = Extract<ClientFrame, { t: "keys.put" }>;

/** Every signed-in machine of every lobby member: the machines that should hold the lobby key (LLD 15.2). */
export async function memberMachines(db: D1Database, lobbyId: string): Promise<Machine[]> {
  const { results } = await db.prepare(
    `SELECT m.machine_id AS machineId, m.box_public_key AS boxPublicKey
     FROM lobby_members lm JOIN machines m ON m.user_id = lm.user_id
     WHERE lm.lobby_id = ? AND m.revoked_at IS NULL AND m.box_public_key IS NOT NULL
     ORDER BY m.machine_id`,
  ).bind(lobbyId).all<Machine>();
  return results;
}

export function currentEpoch(sql: SqlStorage): number {
  return Number(getMeta(sql, "key_epoch") ?? 0);
}

export function markRotate(sql: SqlStorage): void {
  setMeta(sql, "key_rotate", 1);
}

function rotateNeeded(sql: SqlStorage): boolean {
  return getMeta(sql, "key_rotate") === "1";
}

function epochsHeld(sql: SqlStorage, machineId: string): Set<number> {
  const rows = sql.exec<{ epoch: number }>("SELECT epoch FROM lobby_keys WHERE machine_id = ?", machineId).toArray();
  return new Set(rows.map((r) => r.epoch));
}

/** What one machine needs to know: its sealed keys, and which machines still lack which epochs. */
export function keysFrame(sql: SqlStorage, machineId: string | undefined, machines: Machine[]): Extract<ServerFrame, { t: "keys" }> {
  const current = currentEpoch(sql);
  const mine = machineId
    ? sql.exec<{ epoch: number; sealed: string }>("SELECT epoch, sealed FROM lobby_keys WHERE machine_id = ? ORDER BY epoch", machineId).toArray()
    : [];

  const missing = [];
  for (const machine of machines) {
    const held = epochsHeld(sql, machine.machineId);
    const epochs = [];
    for (let epoch = 1; epoch <= current; epoch++) {
      if (!held.has(epoch)) epochs.push(epoch);
    }
    if (epochs.length > 0) missing.push({ machineId: machine.machineId, epochs });
  }

  return { t: "keys", current, rotate: rotateNeeded(sql), mine: mine.map((r) => ({ epoch: r.epoch, sealed: r.sealed })), machines, missing };
}

/** Stores sealed keys from a member machine (LLD 15.4). */
export function putKeys(sql: SqlStorage, from: string | undefined, put: KeysPut, machines: Machine[]): { ok: true } | { error: "forbidden" | "version_conflict" } {
  const allowed = new Set(machines.map((m) => m.machineId));
  if (!from || !allowed.has(from)) return { error: "forbidden" };
  if (put.sealed.some((s) => !allowed.has(s.machineId))) return { error: "forbidden" };

  const current = currentEpoch(sql);
  if (put.create) {
    if (put.epoch !== current + 1) return { error: "version_conflict" };
    if (current > 0 && !rotateNeeded(sql)) return { error: "version_conflict" };
    if (!put.sealed.some((s) => s.machineId === from)) return { error: "forbidden" };
  } else {
    if (put.epoch > current) return { error: "version_conflict" };
    if (!epochsHeld(sql, from).has(put.epoch)) return { error: "forbidden" };
  }

  for (const s of put.sealed) {
    sql.exec("INSERT OR IGNORE INTO lobby_keys (epoch, machine_id, sealed) VALUES (?, ?, ?)", put.epoch, s.machineId, s.sealed);
  }
  if (put.create) {
    setMeta(sql, "key_epoch", put.epoch);
    setMeta(sql, "key_rotate", 0);
  }
  return { ok: true };
}
