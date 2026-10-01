import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { expect as pwExpect } from "playwright/test";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Machine, machines, stopDaemon } from "./machine";

const SCREENSHOTS = process.env.DASHBOARD_SCREENSHOTS;
const publicUrl = inject("publicUrl");
const githubUrl = inject("githubUrl");
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  for (const m of machines) await stopDaemon(m.home);
});

/** A fresh browser, with no session, at a desktop size. */
async function newBrowserPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** Clicks "Sign in with GitHub" as `githubUser`: the fake GitHub approves whoever it is told is signed in. */
async function signIn(page: Page, githubUser: string): Promise<void> {
  await fetch(`${githubUrl}/test/act-as?user=${githubUser}`);
  await page.getByRole("link", { name: /Sign in with GitHub/ }).click();
}

describe("the hosted dashboard", () => {
  it("signs in, manages a lobby from the browser, and never shows message content", async () => {
    const laptop = new Machine();
    await laptop.login("whozpj");
    const lobbyId = await laptop.createLobby("food-app");
    const webDir = join(mkdtempSync(join(tmpdir(), "proj-")), "web");
    mkdirSync(webDir);
    const web = await laptop.agent("claude-code", webDir);
    await web.tool("lobby_status"); // registers the session as one of this machine's agents

    const page = await newBrowserPage();
    await page.goto(publicUrl);
    await pwExpect(page.getByRole("heading", { name: "Let your coding agents talk to each other" })).toBeVisible();
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/hosted-signin.png` });
    await signIn(page, laptop.githubUser);

    await pwExpect(page.getByRole("link", { name: "@whozpj" })).toBeVisible();
    await page.getByRole("link", { name: "food-app" }).click();
    await pwExpect(page.getByText("end-to-end encrypted")).toBeVisible({ timeout: 15_000 });

    // Add the laptop's agent from the browser: the relay asks the laptop's daemon to do it.
    await page.getByRole("button", { name: "Add agent" }).click();
    await pwExpect(page.getByRole("dialog").locator("select")).toContainText("web · claude-code · on");
    await page.getByPlaceholder("api, auth").fill("web");
    await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
    await pwExpect(page.getByTestId("owner-web-claude")).toHaveText("@whozpj");
    expect(await web.until("lobby_status", "You were added to lobby food-app by @whozpj")).toContain("web-claude");

    // A message: the browser sees who asked whom, never what.
    const secret = "The launch codename is BLUEBIRD";
    await laptop.cli(laptop.home, "send", "web-claude", secret);
    const message = page.getByTestId("message").filter({ hasText: "web-claude" });
    await pwExpect(message).toContainText("Encrypted", { timeout: 15_000 });
    expect(await page.content()).not.toContain("BLUEBIRD");
    await pwExpect(page.getByTestId("pulse").first()).toBeAttached({ timeout: 5_000 });

    // The machine's own dashboard can read it.
    const local = (await laptop.cli(laptop.home, "dashboard", "--no-open")).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/)![0];
    const localPage = await browser.newPage();
    await localPage.goto(`${local}#/lobbies/${lobbyId}`);
    await pwExpect(localPage.getByTestId("message").filter({ hasText: "BLUEBIRD" })).toBeVisible({ timeout: 15_000 });
    await localPage.close();

    if (SCREENSHOTS) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SCREENSHOTS}/hosted-lobby.png` });
    }

    await page.getByRole("link", { name: "My agents" }).click();
    await pwExpect(page.getByRole("cell", { name: "running" })).toBeVisible();
  });

  it("opens an invite link in the browser, joins, and the guest's machine follows", async () => {
    const host = new Machine();
    await host.login("host");
    await host.createLobby("shared");
    const link = (await host.cli(host.home, "invite")).match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];
    expect(link.startsWith(publicUrl)).toBe(true);

    const guest = new Machine();
    await guest.login("guest");
    const page = await newBrowserPage();
    await page.goto(link);
    await pwExpect(page.getByText(/@host invited you to/)).toBeVisible();
    await pwExpect(page.getByRole("heading", { name: "shared" })).toBeVisible();
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/hosted-invite.png` });

    await signIn(page, guest.githubUser);
    await page.getByRole("button", { name: /Join as @guest/ }).click();
    await pwExpect(page.getByRole("heading", { name: "shared" })).toBeVisible();

    // The guest's machine adds its seat and receives the lobby key without anyone doing anything.
    for (let i = 0; i < 100; i++) {
      const lobbies = await guest.rpc<{ name: string; keyEpoch: number }[]>("dashboard.lobbies");
      if (lobbies.some((l) => l.name === "shared" && l.keyEpoch === 1)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the guest's machine never got the lobby key");
  });

  it("refuses a bad invite link with a clear message", async () => {
    const page = await browser.newPage();
    await page.goto(`${publicUrl}/invite/not-a-real-invite-token-xx`);
    await pwExpect(page.getByRole("heading", { name: "This invite doesn't work" })).toBeVisible();
    await page.close();
  });
});
