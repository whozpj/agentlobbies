// Takes the dashboard screenshots for the website's get started guide. Skipped unless asked for:
//   GUIDE_SCREENSHOTS=1 pnpm --filter @agentlobbies/e2e test guide-screenshots
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { expect as pwExpect } from "playwright/test";
import { afterAll, inject, it } from "vitest";
import { Machine, machines } from "./machine";

const OUT = resolve(import.meta.dirname, "../packages/dashboard/public/guide");
const publicUrl = inject("publicUrl");
const githubUrl = inject("githubUrl");

afterAll(async () => {
  for (const m of machines) await m.stop();
});

/** A project folder with a plain name, so agents show up as "web" and "api". */
function project(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "guide-")), name);
  mkdirSync(dir);
  return dir;
}

/** The open dialog if there is one (big enough to read in the guide), otherwise the whole window. */
async function shot(page: Page, name: string, part?: string) {
  await page.waitForTimeout(1000); // dialogs fade in
  const dialog = page.getByRole("dialog");
  const target = part ? page.locator(part) : (await dialog.count()) > 0 ? dialog : page;
  await target.screenshot({ path: join(OUT, `${name}.png`) });
}

it.runIf(process.env.GUIDE_SCREENSHOTS)("takes the get started guide's dashboard screenshots", async () => {
  mkdirSync(OUT, { recursive: true });
  const maya = new Machine({ AGENTLOBBIES_MACHINE_NAME: "Maya's MacBook" }); // not this computer's real name
  await maya.login("maya");
  const web = await maya.agent("claude-code", project("web"));
  await web.tool("lobby_status");
  const api = await maya.agent("codex", project("api"));
  await api.tool("lobby_status");

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 })).newPage();
  await page.goto(publicUrl);
  await fetch(`${githubUrl}/test/act-as?user=${maya.githubUser}`);
  await page.getByRole("link", { name: /Sign in with GitHub/ }).click();
  await pwExpect(page.getByRole("heading", { name: "Lobbies" })).toBeVisible();

  await page.getByRole("button", { name: "Create lobby" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("food-app");
  await shot(page, "create-lobby");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await pwExpect(page.getByRole("button", { name: "Add agent" })).toBeVisible({ timeout: 20_000 });

  for (const [folder, owns] of [["web", "web"], ["api", "api"]] as const) {
    await page.getByRole("button", { name: "Add agent" }).click();
    await page.getByRole("dialog").getByRole("radio", { name: new RegExp(folder) }).click();
    await page.getByPlaceholder("api, auth").fill(owns);
    if (folder === "web") await shot(page, "add-agent");
    await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
    await pwExpect(page.getByRole("dialog")).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Invite people" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  await pwExpect(page.getByRole("dialog")).toContainText("expires in 7 days");
  // This relay runs locally, so show the link as it reads on the real site.
  await page.locator(".copy code").evaluate((code, origin) => { code.textContent = code.textContent!.replace(origin, "https://agentlobbies.com"); }, publicUrl);
  await shot(page, "invite");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

  // One question and its answer, as the agents would trade them.
  await web.until("lobby_players", "api-codex");
  await web.tool("lobby_ask", { to: "owner:api", question: "Which field of the Order type holds the delivery ETA, and in what format?" });
  const question = await api.until("lobby_status", "delivery ETA");
  const messageId = question.match(/id (\w{26}) \| question/)![1];
  await api.tool("lobby_reply", { messageId, answer: "Order.estimatedArrival in src/orders.ts: an ISO 8601 timestamp in UTC." });
  await pwExpect(page.getByTestId("message").filter({ hasText: "estimatedArrival" })).toBeVisible({ timeout: 30_000 });
  await pwExpect(page.getByText("end-to-end encrypted")).toBeVisible({ timeout: 30_000 });
  await shot(page, "lobby");

  await page.getByRole("link", { name: "My agents" }).click();
  await pwExpect(page.getByRole("cell", { name: /running/ }).first()).toBeVisible();
  await shot(page, "my-agents", ".table");
  await browser.close();
}, 180_000);
