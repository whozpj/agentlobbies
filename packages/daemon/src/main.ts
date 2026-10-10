#!/usr/bin/env node
import { existsSync, statSync, unlinkSync } from "node:fs";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { Daemon } from "./daemon";
import { defaultHome, relayUrl, socketPath } from "./paths";
import { RpcClient, RpcServer } from "./rpc";

// Keys, database, and socket must be readable only by this user.
process.umask(0o077);

const home = defaultHome();
const path = socketPath(home);

// Another daemon already answers on the socket: leave it running.
if (existsSync(path)) {
  if (await RpcClient.isListening(path)) process.exit(0);
  unlinkSync(path); // stale socket from a crashed daemon
}

const dashboardDir = fileURLToPath(new URL("./dashboard/", import.meta.url));
const daemon = new Daemon({ home, relayUrl: relayUrl(), dashboardDir });
await daemon.start();

// Sessions belong to the connection that opened them, so a crashed MCP server frees its seat (K3).
const sessionsByConn = new Map<Socket, string[]>();
const server = new RpcServer(
  async (method, params, conn) => {
    const result = await daemon.call(method, params);
    if (method === "session.open") {
      const sessions = sessionsByConn.get(conn) ?? [];
      sessions.push(result.sessionId);
      sessionsByConn.set(conn, sessions);
    }
    return result;
  },
  (conn) => {
    for (const sessionId of sessionsByConn.get(conn) ?? []) void daemon.call("session.close", { sessionId });
    sessionsByConn.delete(conn);
  },
);
daemon.on("notify", ({ method, params }) => server.notifyAll(method, params));
await server.listen(path);

// The socket file is ours until the home folder is deleted or another daemon takes the path over.
const ownSocket = process.platform === "win32" ? undefined : statSync(path).ino;
function ownsSocket(): boolean {
  if (ownSocket === undefined) return true;
  try {
    return statSync(path).ino === ownSocket;
  } catch {
    return false;
  }
}

async function shutdown() {
  // Closing the server removes the socket file, which must stay if it's another daemon's by now.
  if (ownsSocket()) await server.close();
  await daemon.stop();
  process.exit(0);
}
daemon.on("shutdown", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// A daemon nobody can reach must not keep running, signed in, in the background: exit once the
// socket isn't ours any more, or the package was uninstalled.
const script = fileURLToPath(import.meta.url);
setInterval(() => {
  if (!ownsSocket() || !existsSync(script)) void shutdown();
}, Number(process.env.AGENTLOBBIES_ORPHAN_CHECK_MS ?? 30_000)).unref();
