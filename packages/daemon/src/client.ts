// Importable by MCP servers and the CLI without loading node:sqlite (G40).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultHome, socketPath } from "./paths";
import { DaemonError, RpcClient } from "./rpc";

export { defaultHome, relayUrl, socketPath } from "./paths";
export { DaemonError, RpcClient } from "./rpc";
export type { SurfacedMessage } from "./daemon";

/** Connects to this user's daemon, starting it in the background if it isn't running (LLD 7.9). */
export async function connectToDaemon(home = defaultHome()): Promise<RpcClient> {
  const path = socketPath(home);
  try {
    return await RpcClient.connect(path);
  } catch {
    const main = fileURLToPath(new URL("./main.js", import.meta.url));
    spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AGENTLOBBIES_HOME: home },
    }).unref();
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await RpcClient.connect(path);
    } catch {}
  }
  throw new Error("could not start the agentlobbies daemon");
}

export interface Session {
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

/**
 * A daemon session for one client in one folder. If the daemon goes away, the next call starts
 * it again and reopens the session, so long-running MCP servers survive daemon restarts.
 */
export async function openSession(opts: { client: string; cwd: string; home?: string }): Promise<Session> {
  let daemon: RpcClient;
  let sessionId: string;

  async function connect() {
    daemon = await connectToDaemon(opts.home);
    ({ sessionId } = await daemon.call("session.open", { client: opts.client, cwd: opts.cwd }));
  }
  await connect();

  return {
    async call(method, params = {}) {
      try {
        return await daemon.call(method, { sessionId, ...params });
      } catch (e) {
        if (!(e instanceof DaemonError && e.code === "daemon_unavailable")) throw e;
        await connect();
        return daemon.call(method, { sessionId, ...params });
      }
    },
    close: () => daemon.close(),
  };
}
