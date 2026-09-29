import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.agentlobbies, or AGENTLOBBIES_HOME if set (LLD 2.4). */
export function defaultHome(): string {
  return process.env.AGENTLOBBIES_HOME ?? join(homedir(), ".agentlobbies");
}

export function socketPath(home: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\agentlobbies-${process.env.USERNAME ?? "user"}` : join(home, "daemon.sock");
}

export function relayUrl(): string {
  return process.env.AGENTLOBBIES_RELAY_URL ?? "https://agentlobbies.agentlobbies-relay-cf.workers.dev";
}
