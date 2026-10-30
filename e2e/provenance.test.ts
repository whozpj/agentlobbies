import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { expect as pwExpect } from "playwright/test";
import { afterAll, beforeAll, describe, inject, it } from "vitest";
import { Machine, machines } from "./machine";

const publicUrl = inject("publicUrl");
const githubUrl = inject("githubUrl");
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  for (const m of machines) await m.stop();
});

describe("where a message came from, on the lobby page", () => {
  it("shows the sending agent's branch, commit, and uncommitted changes, read in the browser from the encrypted message", async () => {
    const repo = join(mkdtempSync(join(tmpdir(), "proj-")), "api");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo }).toString().trim();
    git("init", "-q", "-b", "feat/eta");
    writeFileSync(join(repo, "orders.ts"), "export const v = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "orders.ts"), "export const v = 2;\n"); // not committed yet

    const laptop = new Machine();
    await laptop.login("maya");
    const lobbyId = await laptop.createLobby("provenance");
    const api = await laptop.agent("codex", repo);
    await api.tool("lobby_status");
    await laptop.addAgent(lobbyId, api, "api-codex", ["api"]);
    await api.tool("lobby_post", { body: "Renamed totalCents to totalAmountCents" });

    const page = await (await browser.newContext()).newPage();
    await page.goto(publicUrl);
    await fetch(`${githubUrl}/test/act-as?user=${laptop.githubUser}`);
    await page.getByRole("link", { name: /Sign in with GitHub/ }).click();
    await page.getByRole("link", { name: "provenance" }).click();

    const message = page.getByTestId("message").filter({ hasText: "Renamed totalCents" });
    await pwExpect(message).toBeVisible({ timeout: 30_000 });
    await pwExpect(message.locator(".msg-source")).toHaveText(`feat/eta @ ${git("rev-parse", "--short=7", "HEAD")} · uncommitted changes`);
  });
});
