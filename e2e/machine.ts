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

  /** Calls this machine's daemon over its local socket, as the dashboard does. */
  rpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(join(this.home, "daemon.sock"));
      let buffer = "";
      socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
      socket.on("data", (d) => {
        buffer += d;
        // The daemon also pushes notifications to every connection; wait for the line answering our call.
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.id === 1) {
            socket.end();
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
            return;
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("error", reject);
    });
  }

  /** Creates a lobby from the CLI and returns its id. */
  async createLobby(name: string): Promise<string> {
    await this.cli(this.home, "create", name);
    const lobbies = await this.rpc<{ lobbyId: string; name: string }[]>("dashboard.lobbies");
    return lobbies.find((l) => l.name === name)!.lobbyId;
  }

  /** The user adds one of this machine's running agents to a lobby. */
  async addAgent(lobbyId: string, agent: Agent, handle: string, owns: string[] = []): Promise<void> {
    const agents = await this.rpc<{ seatKey: string; cwd: string }[]>("agents.list");
    const { seatKey } = agents.find((a) => a.cwd.endsWith(agent.cwd.split("/").pop()!))!;
    await this.rpc("lobby.addAgent", { lobbyId, seatKey, handle, owns });
  }

  /** The fake GitHub user this machine signed in as ("<login>.<tag>"); a browser can act as the same one. */
  githubUser = "";

  /** Signs in through the real CLI device flow as a new GitHub user named `login` on the fake GitHub. */
  async login(login: string): Promise<string> {
    this.githubUser = `${login}.${Math.random().toString(36).slice(2, 10)}`;
    return this.cliWith({ AGENTLOBBIES_GITHUB_CLIENT_ID: `test-${this.githubUser}` }, this.home, "login", "--no-open");
  }

  async agent(client: "claude-code" | "codex", cwd = mkdtempSync(join(tmpdir(), `${client}-`))): Promise<Agent> {
    const transport = new StdioClientTransport({ command: bin, args: ["mcp"], cwd, env: { ...this.env, AGENTLOBBIES_CLIENT: client } });
    const mcp = new Client({ name: client, version: "1.0.0" });
    await mcp.connect(transport);
    return new Agent(mcp, cwd);
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
