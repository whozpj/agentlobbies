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

async function shutdown() {
  await server.close();
  await daemon.stop();
  process.exit(0);
}
daemon.on("shutdown", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// A daemon nobody can reach must not keep running, signed in, in the background. Exit if the socket
// is no longer ours (the home folder was deleted, or another daemon took over) or the package was removed.
if (process.platform !== "win32") {
  const ownSocket = statSync(path).ino;
  const script = fileURLToPath(import.meta.url);
  const stillOurs = () => {
    try {
      return statSync(path).ino === ownSocket && existsSync(script);
    } catch {
      return false;
    }
  };
  setInterval(() => {
    if (!stillOurs()) void shutdown();
  }, Number(process.env.AGENTLOBBIES_ORPHAN_CHECK_MS ?? 30_000)).unref();
}
