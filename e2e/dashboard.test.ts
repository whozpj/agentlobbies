import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { expect as pwExpect } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Machine, machines, stopDaemon } from "./machine";

const SCREENSHOTS = process.env.DASHBOARD_SCREENSHOTS;
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  for (const m of machines) await stopDaemon(m.home);
});

describe("dashboard in a real browser", () => {
  it("creates an invite, adds your agent, shows the live message flow, and removes the agent", async () => {
    const laptop = new Machine();
    await laptop.login("whozpj");
    await laptop.createLobby("food-app");
    const webDir = join(mkdtempSync(join(tmpdir(), "proj-")), "web");
    mkdirSync(webDir);
    const web = await laptop.agent("claude-code", webDir);

    const url = (await laptop.cli(laptop.home, "dashboard", "--no-open")).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/)![0];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.goto(url);

    await pwExpect(page.getByRole("button", { name: "@whozpj" })).toBeVisible();
    await page.getByRole("link", { name: "My agents" }).click();
    await pwExpect(page.getByRole("cell", { name: "running" })).toBeVisible();

    await page.getByRole("link", { name: "food-app" }).first().click();
    await page.getByRole("button", { name: "Invite people" }).click();
    await page.getByRole("button", { name: "Create invite link" }).click();
    await pwExpect(page.getByText(/\/invite\/[\w-]{20,}/)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Add agent" }).click();
    await page.getByPlaceholder("api, auth").fill("web");
    await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
    await pwExpect(page.getByTestId("owner-web-claude")).toHaveText("@whozpj");
    await pwExpect(page.getByTestId("node-web-claude")).toBeVisible();
    expect(await web.until("lobby_status", "You were added to lobby food-app by @whozpj")).toContain("web-claude");

    await laptop.cli(laptop.home, "send", "web-claude", "Is estimatedArrival an ISO 8601 string?");
    await pwExpect(page.getByTestId("message").filter({ hasText: "Is estimatedArrival an ISO 8601 string?" })).toBeVisible({ timeout: 15_000 });
    await pwExpect(page.getByTestId("pulse").first()).toBeAttached({ timeout: 5_000 });

    if (SCREENSHOTS) {
      await web.tool("lobby_reply", { messageId: (await web.until("lobby_inbox", "ISO 8601")).match(/id (\w{26})/)![1], answer: "Yes, estimatedArrival is ISO 8601 in UTC." });
      await pwExpect(page.getByTestId("message").filter({ hasText: "ISO 8601 in UTC" })).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SCREENSHOTS}/dashboard-light.png`, fullPage: true });
      await page.getByRole("button", { name: "Dark mode" }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SCREENSHOTS}/dashboard-dark.png`, fullPage: true });
    }

    await page.getByRole("button", { name: "Remove web-claude" }).click();
    await pwExpect(page.getByTestId("owner-web-claude")).toHaveCount(0);
    expect(await web.tool("lobby_status")).toContain("not in a lobby");

    await web.mcp.close();
    await page.close();
  });

  it("rejects API calls that don't carry the dashboard token", async () => {
    const laptop = new Machine();
    await laptop.login("token-checker");
    const url = new URL((await laptop.cli(laptop.home, "dashboard", "--no-open")).match(/http:\/\/\S+/)![0]);
    expect((await fetch(`${url.origin}/api/lobbies`)).status).toBe(401);
  });
});
