#!/usr/bin/env node
import { DaemonError, openSession, relayUrl } from "@agentlobbies/daemon/client";
import { runStdioServer } from "@agentlobbies/mcp-server";
import { defineCommand, runMain } from "citty";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { CLIENTS, detectClients, mcpCommand } from "./install";

type Call = (method: string, params?: Record<string, unknown>) => Promise<any>;

// Exit codes from LLD 9.2.
const EXIT_CODES: Record<string, number> = { rate_limited: 3, invalid_code: 4, lobby_full: 5, forbidden: 6 };

const MESSAGES: Record<string, string> = {
  no_seat: "You are not in a lobby in this folder. Run `agentlobbies create` or `agentlobbies join <code>`.",
  invalid_code: "That code is invalid or expired. Ask the host for a new one.",
  forbidden: "Only the lobby host can do that.",
};

/** Runs `fn` with a daemon session for the CLI seat of the current folder. */
async function withLobby(fn: (call: Call) => Promise<void>): Promise<void> {
  const session = await openSession({ client: "cli", cwd: process.cwd() });
  try {
    await fn((method, params) => session.call(method, params));
  } catch (e) {
    const code = e instanceof DaemonError ? e.code : "internal";
    console.error(pc.red(MESSAGES[code] ?? (e as Error).message));
    process.exitCode = EXIT_CODES[code] ?? 1;
  } finally {
    session.close();
  }
}

function parseTtl(ttl: string | undefined): number | undefined {
  const match = ttl?.match(/^(\d+)(m|h)$/);
  if (!match) return undefined;
  return Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000);
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const create = defineCommand({
  meta: { description: "Create a lobby and become its host" },
  args: {
    name: { type: "string", description: "Lobby name" },
    handle: { type: "string", description: "Your handle in the lobby", default: "host" },
  },
  run: ({ args }) => withLobby(async (call) => {
    const r = await call("lobby.create", { name: args.name, handle: args.handle });
    console.log(`Lobby created. Share this code: ${pc.bold(r.code)} (expires ${time(r.codeExpiresAt)})\n`);
    console.log("Next:");
    console.log(`  1. Tell each agent: ${pc.bold(`join lobby ${r.code}`)}`);
    console.log(`  2. Run ${pc.bold("agentlobbies approve")} on each machine to let them in`);
    console.log(`  3. Run ${pc.bold("agentlobbies players")} to see who is here`);
  }),
});

const join = defineCommand({
  meta: { description: "Join a lobby from this folder" },
  args: {
    code: { type: "positional", description: "Lobby code, like 4-maple-orbit" },
    handle: { type: "string", description: "Your handle in the lobby", default: "human" },
    owns: { type: "string", description: "Comma-separated areas you own, like api,auth" },
  },
  run: ({ args }) => withLobby(async (call) => {
    const owns = args.owns ? args.owns.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const r = await call("lobby.join", { code: args.code, handle: args.handle, owns });
    console.log(`Joined as ${pc.bold(r.handle)} (${r.role}).`);
  }),
});

const code = defineCommand({
  meta: { description: "Host: mint a new join code" },
  args: {
    observer: { type: "boolean", description: "Code joins as an observer" },
    ttl: { type: "string", description: "How long it lasts, like 30m or 2h" },
    uses: { type: "string", description: "How many joins it allows" },
  },
  run: ({ args }) => withLobby(async (call) => {
    const r = await call("lobby.code", {
      role: args.observer ? "observer" : "member",
      ttlMs: parseTtl(args.ttl),
      maxUses: args.uses ? Number(args.uses) : undefined,
    });
    console.log(`Share this code: ${pc.bold(r.code)} (expires ${time(r.expiresAt)})`);
  }),
});

const players = defineCommand({
  meta: { description: "List everyone in the lobby" },
  run: () => withLobby(async (call) => {
    const list: { handle: string; client: string; status: string; owns: string[]; workingOn: string }[] = await call("lobby.players");
    for (const p of list) {
      const status = p.status === "offline" ? pc.dim(p.status) : pc.green(p.status);
      console.log(`${pc.bold(p.handle)}  ${p.client}  ${status}  owns: ${p.owns.join(", ") || "-"}  ${pc.dim(p.workingOn)}`);
    }
  }),
});

const send = defineCommand({
  meta: { description: "Send a message: to a handle, 'all', '#topic', or 'owner:<area>'" },
  args: {
    to: { type: "positional", description: "Recipient" },
    allowSecret: { type: "boolean", description: "Send even if it looks like it contains a secret" },
  },
  run: ({ args }) => withLobby(async (call) => {
    const body = args._.slice(1).join(" ");
    const type = body.trim().endsWith("?") ? "question" : "update";
    const r = await call("message.send", { to: args.to, type, body, allowSecret: args.allowSecret });
    console.log(r.queued ? `Queued ${r.id}; it will send when the lobby reconnects.` : `Sent ${r.id}.`);
  }),
});

const inbox = defineCommand({
  meta: { description: "Show unread messages" },
  run: () => withLobby(async (call) => {
    const messages: { from: string; type: string; body: string; id: string }[] = await call("inbox.pull", { limit: 25 });
    if (messages.length === 0) console.log(pc.dim("No new messages."));
    for (const m of messages) console.log(`${pc.bold(m.from)} (${m.type}) ${pc.dim(m.id)}\n${m.body}\n`);
  }),
});

const approve = defineCommand({
  meta: { description: "Approve agents that asked to join a lobby" },
  args: {
    id: { type: "positional", required: false, description: "Request id to approve (default: ask about each one)" },
    reject: { type: "boolean", description: "Reject instead of approving" },
  },
  run: ({ args }) => withLobby(async (call) => {
    if (args.id) {
      await call("approval.decide", { scope: "join", id: args.id, approve: !args.reject });
      console.log(args.reject ? "Rejected." : "Approved.");
      return;
    }
    const pending: { id: string; client: string; handle: string; code: string }[] = await call("approval.list", { scope: "join" });
    if (pending.length === 0) return console.log(pc.dim("Nothing waiting for approval."));
    if (!process.stdin.isTTY) {
      for (const r of pending) console.log(`${r.id}  ${r.client} wants to join as ${pc.bold(r.handle)} with code ${r.code}`);
      return console.log(pc.dim("Run `agentlobbies approve <id>` to approve one."));
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    for (const r of pending) {
      const answer = await prompt.question(`Let ${r.client} join lobby ${r.code} as ${pc.bold(r.handle)}? [Y/n] `);
      const yes = !answer.trim().toLowerCase().startsWith("n");
      await call("approval.decide", { scope: "join", id: r.id, approve: yes });
      console.log(yes ? pc.green("Approved.") : "Rejected.");
    }
    prompt.close();
  }),
});

const install = defineCommand({
  meta: { description: "Add Agent Lobbies to your coding agents (Claude Code, Codex)" },
  run: () => {
    const found = detectClients(homedir());
    if (found.length === 0) {
      console.error(pc.red(`No supported agents found (${CLIENTS.map((c) => c.name).join(", ")}).`));
      console.error("For other MCP clients, add a stdio server that runs: agentlobbies mcp");
      process.exitCode = 1;
      return;
    }
    for (const client of found) {
      client.install(homedir(), mcpCommand());
      console.log(`${pc.green("✓")} ${client.name}: added the agentlobbies tools and rules`);
    }
    console.log(`
Restart your agents to load the tools. Then run ${pc.bold("agentlobbies create")} in any folder.`);
  },
});

const uninstall = defineCommand({
  meta: { description: "Remove Agent Lobbies from your coding agents" },
  run: () => {
    for (const client of CLIENTS.filter((c) => c.isInstalled(homedir()))) {
      client.uninstall(homedir());
      console.log(`${pc.green("✓")} ${client.name}: removed`);
    }
  },
});

const doctor = defineCommand({
  meta: { description: "Check that everything is set up and reachable" },
  run: async () => {
    let failed = false;
    const check = (ok: boolean, pass: string, fail: string) => {
      console.log(ok ? `${pc.green("✓")} ${pass}` : `${pc.red("✗")} ${fail}`);
      failed ||= !ok;
    };

    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    check(major > 22 || (major === 22 && minor >= 13), `Node ${process.versions.node}`, `Node ${process.versions.node} is too old; install Node 22.13 or later`);

    try {
      const session = await openSession({ client: "cli", cwd: process.cwd() });
      const info = await session.call("daemon.info");
      session.close();
      check(true, `Daemon running (pid ${info.pid})`, "");
    } catch (e) {
      check(false, "", `Daemon not running: ${(e as Error).message}`);
    }

    const url = relayUrl();
    const healthy = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    check(healthy, `Relay reachable at ${url}`, `Relay not reachable at ${url}; check your network or AGENTLOBBIES_RELAY_URL`);

    for (const client of detectClients(homedir())) {
      check(client.isInstalled(homedir()), `${client.name} configured`, `${client.name} not configured; run \`agentlobbies install\``);
    }
    process.exitCode = failed ? 1 : 0;
  },
});

const status = defineCommand({
  meta: { description: "Show this folder's lobby and connection" },
  run: () => withLobby(async (call) => {
    const s = await call("lobby.status");
    console.log(`${pc.bold(s.lobbyName ?? s.lobbyId.slice(0, 8))}: you are ${s.handle} (${s.role}), ${s.connection}, ${s.unread} unread`);
  }),
});

const mcp = defineCommand({
  meta: { description: "Run the MCP server over stdio (used by agent configs)" },
  run: () => runStdioServer(),
});

await runMain(defineCommand({
  meta: { name: "agentlobbies", version: "0.1.0", description: "Let your coding agents talk to each other" },
  subCommands: { install, create, join, code, players, send, inbox, approve, status, doctor, uninstall, mcp },
}));
