import { openSession } from "@agentlobbies/daemon/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

/** Serves the lobby tools over stdio. stdout must carry MCP frames only. */
export async function runStdioServer(): Promise<void> {
  const session = await openSession({ client: process.env.AGENTLOBBIES_CLIENT ?? "custom", cwd: process.cwd() });
  const server = createServer((method, params) => session.call(method, params));
  await server.connect(new StdioServerTransport());
  process.stdin.on("close", () => {
    session.close();
    process.exit(0);
  });
}
