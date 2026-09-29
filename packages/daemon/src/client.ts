// Importable by MCP servers and the CLI without loading node:sqlite (G40).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultHome, socketPath } from "./paths";
import { RpcClient } from "./rpc";

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
