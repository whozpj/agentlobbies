import { openSession } from "@agentlobbies/daemon/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

/** Serves the lobby tools over stdio. stdout must carry MCP frames only. */
export async function runStdioServer(): Promise<void> {
  const client = process.env.AGENTLOBBIES_CLIENT ?? "custom";
  const session = await openSession({ client, cwd: process.cwd() });
  const { codexHooksAllowed } = await session.call<{ codexHooksAllowed?: boolean }>("daemon.info");
  const server = createServer((method, params) => session.call(method, params), { askToAllowHooks: client === "codex" && !codexHooksAllowed });
  await server.connect(new StdioServerTransport());
  process.stdin.on("close", () => {
    session.close();
    process.exit(0);
  });
}
