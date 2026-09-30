#!/usr/bin/env node
import { CLIENT_VERSION, DaemonError, openSession, relayUrl } from "@agentlobbies/daemon/client";
import { runStdioServer } from "@agentlobbies/mcp-server";
import { defineCommand, runMain } from "citty";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import pc from "picocolors";
import { CLIENTS, detectClients, hookCommand, mcpCommand } from "./install";
import { githubDeviceLogin } from "./login";

type Call = (method: string, params?: Record<string, unknown>) => Promise<any>;

// Exit codes from LLD 9.2.
const EXIT_CODES: Record<string, number> = { rate_limited: 3, invalid_code: 4, lobby_full: 5, forbidden: 6 };

const MESSAGES: Record<string, string> = {
  login_required: "Sign in first: run `agentlobbies login`.",
  no_seat: "You aren't in a lobby yet. Run `agentlobbies create`, or `agentlobbies accept <invite link>`.",
  invalid_code: "That invite is invalid or expired. Ask the lobby owner for a new one.",
  forbidden: "Only the lobby owner can do that.",
};

/** Runs `fn` with a daemon session for the CLI seat of the current folder. */
async function withLobby(fn: (call: Call) => Promise<void>): Promise<void> {
  const session = await openSession({ client: "person", cwd: process.cwd() });
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

function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

async function signIn(call: Call, openBrowser: boolean): Promise<void> {
  const githubToken = await githubDeviceLogin((userCode, url) => {
    console.log(`Open ${pc.bold(url)} and enter the code ${pc.bold(userCode)}`);
    if (openBrowser) openInBrowser(url);
  });
  const { login } = await call("account.login", { githubToken });
  console.log(`${pc.green("✓")} Signed in as @${login}`);
}


const login = defineCommand({
  meta: { description: "Sign in with GitHub so your agents show as yours" },
  args: { open: { type: "boolean", default: true, description: "Open the GitHub page in your browser" } },
  run: ({ args }) => withLobby((call) => signIn(call, args.open && process.stdout.isTTY)),
});

const logout = defineCommand({
  meta: { description: "Sign out on this machine" },
  run: () => withLobby(async (call) => {
    await call("account.logout");
    console.log("Signed out.");
  }),
});

const create = defineCommand({
  meta: { description: "Create a lobby that you own" },
  args: { name: { type: "positional", required: false, description: "Lobby name" } },
  run: ({ args }) => withLobby(async (call) => {
    const r = await call("lobby.create", { name: args.name });
    console.log(`${pc.green("✓")} Created ${pc.bold(r.name ?? r.lobbyId.slice(0, 8))}\n`);
    console.log("Next:");
    console.log(`  • Add your agents:  ${pc.bold("agentlobbies dashboard")}`);
    console.log(`  • Invite people:    ${pc.bold("agentlobbies invite")}`);
  }),
});

const invite = defineCommand({
  meta: { description: "Make an invite link for your lobby" },
  args: {
    viewer: { type: "boolean", description: "View-only: they can watch but not add agents" },
    uses: { type: "string", description: "How many people can use it" },
  },
  run: ({ args }) => withLobby(async (call) => {
    const r = await call("invite.create", { role: args.viewer ? "viewer" : "member", maxUses: args.uses ? Number(args.uses) : undefined });
    console.log(`Share this link: ${pc.bold(r.url)}`);
    console.log(pc.dim(`They run: agentlobbies accept <link>  (expires ${new Date(r.expiresAt).toLocaleDateString()})`));
  }),
});

const accept = defineCommand({
  meta: { description: "Join a lobby with an invite link" },
  args: { link: { type: "positional", description: "The invite link" } },
  run: ({ args }) => withLobby(async (call) => {
    const r = await call("invite.accept", { invite: args.link });
    console.log(`${pc.green("✓")} Joined ${pc.bold(r.name ?? r.lobbyId.slice(0, 8))}. Add your agents with ${pc.bold("agentlobbies dashboard")}.`);
  }),
});

const players = defineCommand({
  meta: { description: "List everyone in the lobby" },
  run: () => withLobby(async (call) => {
    const list: { handle: string; client: string; status: string; owns: string[]; workingOn: string; owner?: { login: string } }[] =
      await call("lobby.players");
    for (const p of list) {
      const status = p.status === "offline" ? pc.dim(p.status) : pc.green(p.status);
      const owner = p.owner ? `@${p.owner.login}` : "-";
      console.log(`${pc.bold(p.handle)}  ${owner}  ${p.client}  ${status}  owns: ${p.owns.join(", ") || "-"}  ${pc.dim(p.workingOn)}`);
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

const install = defineCommand({
  meta: { description: "Add Agent Lobbies to your coding agents (Claude Code, Codex)" },
  run: async () => {
    const found = detectClients(homedir());
    if (found.length === 0) {
      console.error(pc.red(`No supported agents found (${CLIENTS.map((c) => c.name).join(", ")}).`));
      console.error("For other MCP clients, add a stdio server that runs: agentlobbies mcp");
      process.exitCode = 1;
      return;
    }
    const hooks = hookCommand();
    for (const client of found) {
      client.install(homedir(), mcpCommand(), hooks);
      const extra = client.id === "claude-code" && hooks ? ", and instant message delivery" : "";
      console.log(`${pc.green("✓")} ${client.name}: added the agentlobbies tools and rules${extra}`);
    }
    if (!hooks) {
      console.log(pc.dim("\nFor instant message delivery in Claude Code, install globally: npm install -g agentlobbies && agentlobbies install"));
    }
    await withLobby(async (call) => {
      if (await call("account.status")) return;
      if (!process.stdin.isTTY) return console.log(`\nNext, sign in: ${pc.bold("agentlobbies login")}`);
      console.log("\nSign in with GitHub so your agents show as yours:");
      await signIn(call, true);
    });
    console.log(`\nRestart your agents to load the tools. Then run ${pc.bold("agentlobbies create")} in any folder.`);
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

    try {
      const session = await openSession({ client: "cli", cwd: process.cwd() });
      const account = await session.call("account.status");
      session.close();
      check(Boolean(account), `Signed in as @${account?.login}`, "Not signed in; run `agentlobbies login`");
    } catch {}

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

const dashboard = defineCommand({
  meta: { description: "Open the dashboard: lobbies, your agents, invites, and the live message flow" },
  args: { open: { type: "boolean", default: true, description: "Open it in your browser" } },
  run: ({ args }) => withLobby(async (call) => {
    const { url } = await call("dashboard.start");
    console.log(`Dashboard: ${pc.bold(url)}`);
    if (args.open) openInBrowser(url);
  }),
});

const mcp = defineCommand({
  meta: { description: "Run the MCP server over stdio (used by agent configs)" },
  run: () => runStdioServer(),
});

await runMain(defineCommand({
  meta: { name: "agentlobbies", version: CLIENT_VERSION, description: "Let your coding agents talk to each other" },
  subCommands: { install, login, logout, create, invite, accept, dashboard, players, send, inbox, status, doctor, uninstall, mcp },
}));
