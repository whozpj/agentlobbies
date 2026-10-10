import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { expect as pwExpect } from "playwright/test";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import { Machine, machines } from "./machine";

const publicUrl = inject("publicUrl");
const githubUrl = inject("githubUrl");
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  for (const m of machines) await m.stop();
});

function project(folder: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "proj-")), folder);
  mkdirSync(dir);
  return dir;
}

/** What the lobby page shows for one agent: its dot and node (working, waiting, offline) and the line under its name. */
async function shows(handle: string, status: "active" | "idle" | "offline", line: string, timeout = 15_000) {
  const card = page.locator(".agent-card").filter({ has: page.locator(".handle", { hasText: new RegExp(`^${handle}$`) }) });
  await pwExpect(card.locator(".dot")).toHaveClass(new RegExp(`\\b${status}\\b`), { timeout });
  await pwExpect(card.locator(".working")).toHaveText(line);
  await pwExpect(page.getByTestId(`node-${handle}`)).toHaveClass(new RegExp(`\\b${status}\\b`));
}

const gone = (handle: string) => pwExpect(page.getByTestId(`node-${handle}`)).toHaveCount(0, { timeout: 15_000 });
const online = (count: string) => pwExpect(page.locator(".stats")).toContainText(`${count} agents online`, { timeout: 15_000 });

describe("who is online, on the lobby page", () => {
  it("follows agents as they join, work, wait, close, sleep, crash, come back, sign out, and are removed", async () => {
    const alice = new Machine();
    await alice.login("alice");
    const lobbyId = await alice.createLobby("presence");

    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(publicUrl);
    await fetch(`${githubUrl}/test/act-as?user=${alice.githubUser}`);
    await page.getByRole("link", { name: /Sign in with GitHub/ }).click();
    await page.getByRole("link", { name: "presence" }).click();
    await online("0/0");
    await pwExpect(page.getByTestId("node-alice")).toHaveClass(/\bidle\b/);

    // Joining: an agent appears online and waiting as soon as it's added.
    const webDir = project("web");
    let web = await alice.agent("claude-code", webDir);
    await web.tool("lobby_status");
    await alice.addAgent(lobbyId, web, "web-claude", ["web"]);
    await shows("web-claude", "idle", "waiting for messages");
    await online("1/1");

    // Working, then waiting again, as its hooks report each turn.
    await web.tool("lobby_set_status", { workingOn: "the tracking page", status: "active" });
    await shows("web-claude", "active", "the tracking page");
    await web.tool("lobby_set_status", { workingOn: "", status: "idle" });
    await shows("web-claude", "idle", "waiting for messages");

    // Closed: offline, still in the lobby. Reopened: back online.
    await web.mcp.close();
    await shows("web-claude", "offline", "offline");
    await online("0/1");
    web = await alice.agent("claude-code", webDir);
    await web.tool("lobby_status");
    await shows("web-claude", "idle", "waiting for messages");
    await online("1/1");

    // A second person joins with their own agent.
    const bob = new Machine();
    await bob.login("bob");
    await bob.cli(bob.home, "accept", (await alice.cli(alice.home, "invite")).match(/https?:\/\/\S+\/invite\/[\w-]+/)![0]);
    const apiDir = project("api");
    let api = await bob.agent("codex", apiDir);
    await api.tool("lobby_status");
    await bob.addAgent(lobbyId, api, "api-codex", ["api"]);
    await shows("api-codex", "idle", "waiting for messages");
    await online("2/2");
    await pwExpect(page.getByRole("button", { name: "People (2)" })).toBeVisible();
    await pwExpect(page.getByTestId("node-bob")).toHaveClass(/\bidle\b/);

    // Bob's laptop goes to sleep: nothing closes, its heartbeats just stop. With nobody else doing
    // anything in the lobby, the open page still has to show him and his agent offline.
    const { pid } = await bob.rpc<{ pid: number }>("daemon.info");
    process.kill(pid, "SIGSTOP");
    try {
      await shows("api-codex", "offline", "offline", 120_000);
      await pwExpect(page.getByTestId("node-bob")).toHaveClass(/\boffline\b/);
      await online("1/2");
      await shows("web-claude", "idle", "waiting for messages"); // alice's agent is unaffected
    } finally {
      process.kill(pid, "SIGCONT");
    }

    // The laptop wakes: back online by itself.
    await shows("api-codex", "idle", "waiting for messages", 60_000);
    await pwExpect(page.getByTestId("node-bob")).toHaveClass(/\bidle\b/);
    await online("2/2");

    // The laptop crashes outright (agent and daemon killed): offline at once. Started again: back online.
    process.kill((api.mcp.transport as StdioClientTransport).pid!, "SIGKILL");
    process.kill((await bob.rpc<{ pid: number }>("daemon.info")).pid, "SIGKILL");
    await shows("api-codex", "offline", "offline");
    await pwExpect(page.getByTestId("node-bob")).toHaveClass(/\boffline\b/);
    await online("1/2");
    api = await bob.agent("codex", apiDir);
    await api.tool("lobby_status");
    await shows("api-codex", "idle", "waiting for messages");
    await online("2/2");

    // The lobby list shows the same counts.
    await page.goto(`${publicUrl}/#/`);
    await pwExpect(page.locator(".lobby-card").filter({ hasText: "presence" })).toContainText("2/2 agents online · 2 people");
    await page.getByRole("link", { name: "presence" }).click();

    // Bob signs out on his laptop: his agent leaves the lobby; he is still a member.
    await bob.cli(bob.home, "logout");
    await gone("api-codex");
    await gone("bob");
    await online("1/1");
    await pwExpect(page.getByRole("button", { name: "People (2)" })).toBeVisible();

    // Alice removes her own agent from the page.
    await page.getByRole("button", { name: "Remove web-claude" }).click();
    await gone("web-claude");
    await online("0/0");
  }, 400_000);
});
