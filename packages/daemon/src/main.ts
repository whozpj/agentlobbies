#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import type { Socket } from "node:net";
import { Daemon } from "./daemon";
import { defaultHome, relayUrl, socketPath } from "./paths";
import { RpcClient, RpcServer } from "./rpc";

// Keys, database, and socket must be readable only by this user.
process.umask(0o077);

const home = defaultHome();
const path = socketPath(home);

// Another daemon already answers on the socket: leave it running.
if (existsSync(path)) {
  const alreadyRunning = await RpcClient.connect(path).then((c) => (c.close(), true), () => false);
  if (alreadyRunning) process.exit(0);
  unlinkSync(path); // stale socket from a crashed daemon
}

const daemon = new Daemon({ home, relayUrl: relayUrl() });
await daemon.start();

// Sessions belong to the connection that opened them, so a crashed MCP server frees its seat (K3).
const sessionsByConn = new Map<Socket, string[]>();
const server = new RpcServer(
  async (method, params, conn) => {
    const result = await daemon.call(method, params);
    if (method === "session.open") sessionsByConn.set(conn, [...(sessionsByConn.get(conn) ?? []), result.sessionId]);
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
