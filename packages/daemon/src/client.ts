// Importable by MCP servers and the CLI without loading node:sqlite (G40).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultHome, socketPath } from "./paths";
import { DaemonError, RpcClient } from "./rpc";
import { CLIENT_VERSION } from "./version";

export { defaultHome, relayUrl, socketPath } from "./paths";
export { DaemonError, RpcClient } from "./rpc";
export type { SurfacedMessage } from "./daemon";
export { CLIENT_VERSION } from "./version";

function isOlder(version: string, than: string): boolean {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects to this user's daemon, starting it in the background if it isn't running. A daemon
 * older than this client (left over from before an upgrade) is shut down and replaced (LLD 7.9).
 */
export async function connectToDaemon(home = defaultHome()): Promise<RpcClient> {
  const path = socketPath(home);
  let existing: RpcClient | undefined;
  try {
    existing = await RpcClient.connect(path);
  } catch {
    existing = undefined; // not running yet
  }

  if (existing) {
    let version: string | undefined;
    try {
      version = (await existing.call<{ version: string }>("daemon.info")).version;
    } catch {
      version = undefined;
    }
    if (!version || !isOlder(version, CLIENT_VERSION)) return existing;

    // An older daemon from before an upgrade: ask it to exit, and wait until it has.
    try {
      await existing.call("daemon.shutdown");
    } catch {
      // It may exit before it answers.
    }
    existing.close();
    for (let i = 0; i < 30; i++) {
      if (!(await RpcClient.isListening(path))) break;
      await sleep(100);
    }
  }

  const main = fileURLToPath(new URL("./main.js", import.meta.url));
  spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AGENTLOBBIES_HOME: home },
  }).unref();
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    try {
      return await RpcClient.connect(path);
    } catch {
      // Still starting.
    }
  }
  throw new Error("could not start the agentlobbies daemon");
}

export interface Session {
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

/**
 * A daemon session for one client in one folder. If the daemon goes away (an upgrade restarts it),
 * the session reopens at once, starting the daemon again, so a running agent stays online.
 * `passive` marks a hook's session, which doesn't count as the agent running.
 */
export async function openSession(opts: { client: string; cwd: string; home?: string; passive?: boolean }): Promise<Session> {
  let daemon: RpcClient;
  let sessionId: string;
  let closed = false;
  let reconnecting: Promise<void> | undefined;

  async function connect() {
    daemon = await connectToDaemon(opts.home);
    ({ sessionId } = await daemon.call("session.open", { client: opts.client, cwd: opts.cwd, passive: opts.passive ?? false }));
    daemon.onClose(() => {
      if (!closed) void reconnect();
    });
  }

  /** Keeps trying until the daemon is back. Concurrent callers share one attempt. */
  function reconnect(): Promise<void> {
    if (!reconnecting) {
      reconnecting = (async () => {
        while (!closed) {
          try {
            await connect();
            return;
          } catch {
            await sleep(1_000);
          }
        }
      })();
      reconnecting.finally(() => {
        reconnecting = undefined;
      });
    }
    return reconnecting;
  }

  await connect();

  return {
    async call(method, params = {}) {
      try {
        return await daemon.call(method, { sessionId, ...params });
      } catch (e) {
        if (!(e instanceof DaemonError && e.code === "daemon_unavailable")) throw e;
        await reconnect();
        return daemon.call(method, { sessionId, ...params });
      }
    },
    close: () => {
      closed = true;
      daemon.close();
    },
  };
}
