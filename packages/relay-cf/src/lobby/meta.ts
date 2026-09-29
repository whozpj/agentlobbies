import { LobbySettings } from "@agentlobbies/protocol";

export function getMeta(sql: SqlStorage, key: string): string | undefined {
  return sql.exec<{ value: string }>("SELECT value FROM lobby_meta WHERE key = ?", key).toArray()[0]?.value;
}

export function setMeta(sql: SqlStorage, key: string, value: string | number): void {
  sql.exec("INSERT OR REPLACE INTO lobby_meta VALUES (?, ?)", key, String(value));
}

export function getSettings(sql: SqlStorage): LobbySettings {
  return LobbySettings.parse(JSON.parse(getMeta(sql, "settings") ?? "{}"));
}

export function isOpen(sql: SqlStorage): boolean {
  return getMeta(sql, "status") === "open";
}
