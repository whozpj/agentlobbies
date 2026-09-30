import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    relayUrl: string;
    githubUrl: string;
  }
}

const bin = inject("bin");
const relayUrl = inject("relayUrl");
const githubUrl = inject("githubUrl");
export const machines: Machine[] = [];

/** Asks a machine's daemon to exit, like a reboot or a crash would. */
export function stopDaemon(home: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection(join(home, "daemon.sock"));
    socket.resume(); // an unread socket never emits "close"
    socket.on("connect", () => socket.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.shutdown", params: {} }) + "\n"));
    socket.on("close", () => setTimeout(resolve, 300));
    socket.on("error", () => resolve());
  });
}

/** One computer: its own daemon home, a human at the CLI, and agents over stdio MCP. */
export class Machine {
  readonly home = mkdtempSync(join("/tmp", "al-e2e-"));
  private readonly env = { ...process.env, AGENTLOBBIES_HOME: this.home, AGENTLOBBIES_RELAY_URL: relayUrl, AGENTLOBBIES_GITHUB_URL: githubUrl, NO_COLOR: "1" } as Record<string, string>;

  constructor() {
    machines.push(this);
  }

  async cli(cwd: string, ...args: string[]): Promise<string> {
    return this.cliWith({}, cwd, ...args);
  }

  async cliWith(extraEnv: Record<string, string>, cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await promisify(execFile)(bin, args, { cwd, env: { ...this.env, ...extraEnv } });
    return stdout;
  }

  /** Signs in through the real CLI device flow, as GitHub user `login` on the fake GitHub. */
  async login(login: string): Promise<string> {
    return this.cliWith({ AGENTLOBBIES_GITHUB_CLIENT_ID: `test-${login}` }, this.home, "login", "--no-open");
  }

  async agent(client: "claude-code" | "codex", cwd = mkdtempSync(join(tmpdir(), `${client}-`))): Promise<Agent> {
    const transport = new StdioClientTransport({ command: bin, args: ["mcp"], cwd, env: { ...this.env, AGENTLOBBIES_CLIENT: client } });
    const mcp = new Client({ name: client, version: "1.0.0" });
    await mcp.connect(transport);
    return new Agent(mcp, cwd);
  }

  /** The human approves every pending join, as `agentlobbies approve` would. */
  async approveAll(): Promise<void> {
    const listing = await this.cli(this.home, "approve");
    for (const [id] of listing.matchAll(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g)) await this.cli(this.home, "approve", id);
  }
}

export class Agent {
  constructor(readonly mcp: Client, readonly cwd: string) {}

  async tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.mcp.callTool({ name, arguments: args });
    return (result.content as { text: string }[]).map((c) => c.text).join("\n");
  }

  /** Calls a tool until its output contains `text`, the way an agent keeps working and checking. */
  async until(name: string, text: string, args: Record<string, unknown> = {}): Promise<string> {
    let seen = "";
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      seen += await this.tool(name, args);
      if (seen.includes(text)) return seen;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`never saw "${text}" from ${name}; got:\n${seen}`);
  }
}
