import { connectToDaemon } from "@agentlobbies/daemon/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

/** Serves the lobby tools over stdio. stdout must carry MCP frames only. */
export async function runStdioServer(): Promise<void> {
  const daemon = await connectToDaemon();
  const { sessionId } = await daemon.call("session.open", {
    client: process.env.AGENTLOBBIES_CLIENT ?? "custom",
    cwd: process.cwd(),
  });
  const server = createServer((method, params = {}) => daemon.call(method, { sessionId, ...params }));
  await server.connect(new StdioServerTransport());
  process.stdin.on("close", () => {
    daemon.close();
    process.exit(0);
  });
}
