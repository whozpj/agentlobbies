import { chromium, type Browser, type Page } from "playwright";
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

async function eventuallyVisible(page: Page, selector: string) {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 15_000 });
}

describe("dashboard in a real browser", () => {
  it("shows lobbies, approves a join, and animates messages live", async () => {
    const laptop = new Machine();
    await laptop.login("whozpj");
    const created = await laptop.cli(laptop.home, "create", "--name", "food-app", "--handle", "prithvi");
    const code = created.match(/[2-9]-[a-z]+-[a-z]+/)![0];

    const web = await laptop.agent("claude-code");
    expect(await web.tool("lobby_join", { code, handle: "web-claude", owns: ["web"] })).toContain("approve");

    const url = (await laptop.cli(laptop.home, "dashboard", "--no-open")).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/)![0];
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(url);

    await pwExpect(page.getByRole("link", { name: "food-app" }).first()).toBeVisible();
    await pwExpect(page.getByTestId("approval-count")).toHaveText("1");

    await page.getByRole("link", { name: "Pending approvals" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await pwExpect(page.getByTestId("approval-count")).toHaveCount(0);

    await page.getByRole("link", { name: "food-app" }).first().click();
    await eventuallyVisible(page, '[data-testid="node-web-claude"]');
    await pwExpect(page.getByTestId("node-prithvi")).toBeVisible();
    await pwExpect(page.getByRole("cell", { name: "web-claude" })).toBeVisible();
    await pwExpect(page.getByTestId("owner-web-claude")).toHaveText("@whozpj");

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

    await web.mcp.close();
    await page.close();
  });

  it("rejects API calls that don't carry the dashboard token", async () => {
    const laptop = new Machine();
    await laptop.login("token-checker");
    await laptop.cli(laptop.home, "create", "--handle", "prithvi");
    const url = new URL((await laptop.cli(laptop.home, "dashboard", "--no-open")).match(/http:\/\/\S+/)![0]);
    const res = await fetch(`${url.origin}/api/lobbies`);
    expect(res.status).toBe(401);
  });
});
