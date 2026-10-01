import { fromB64u, toB64u } from "@agentlobbies/protocol";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function saveKey(home: string, seatId: string, secretKey: Uint8Array): void {
  mkdirSync(join(home, "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "keys", `${seatId}.key`), toB64u(secretKey), { mode: 0o600 });
}

export function loadKey(home: string, seatId: string): Uint8Array<ArrayBuffer> {
  return fromB64u(readFileSync(join(home, "keys", `${seatId}.key`), "utf8").trim());
}

export function hasKey(home: string, seatId: string): boolean {
  return existsSync(join(home, "keys", `${seatId}.key`));
}
