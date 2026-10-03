import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { expect as pwExpect } from "playwright/test";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Machine, machines } from "./machine";

const SCREENSHOTS = process.env.DASHBOARD_SCREENSHOTS;
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

/** A fresh browser, with no session, at a desktop size. */
/** Anything the Content-Security-Policy blocked on any page in these tests. */
const cspViolations: string[] = [];

function watchCsp(page: Page): Page {
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) cspViolations.push(message.text());
  });
  return page;
}

async function newBrowserPage(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return watchCsp(await context.newPage());
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
    const choice = page.getByRole("dialog").getByRole("radio", { name: /web/ });
    await pwExpect(choice).toContainText("claude-code · ");
    await pwExpect(choice).toHaveAttribute("aria-checked", "true");
    await page.getByPlaceholder("api, auth").fill("web");
    await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
    await pwExpect(page.getByTestId("owner-web-claude")).toHaveText("@whozpj");
    expect(await web.until("lobby_status", "You were added to lobby food-app by @whozpj")).toContain("web-claude");

    // A message: the browser decrypts it as one of the user's devices; the relay only ever hands it ciphertext.
    const secret = "The launch codename is BLUEBIRD";
    await laptop.cli(laptop.home, "send", "web-claude", secret);
    await pwExpect(page.getByTestId("message").filter({ hasText: secret })).toBeVisible({ timeout: 30_000 });
    const fromRelay = await page.evaluate(async (id) => (await fetch(`/v1/lobbies/${id}/events`)).text(), lobbyId);
    expect(fromRelay).toContain("sealed");
    expect(fromRelay).not.toContain("BLUEBIRD");
    const stored = await page.evaluate(() => new Promise<string>((resolve) => {
      const open = indexedDB.open("agentlobbies");
      open.onsuccess = () => {
        const all = open.result.transaction("device").objectStore("device").getAll();
        all.onsuccess = () => resolve(all.result.map((d: { privateKey: CryptoKey }) => String(d.privateKey.extractable)).join(","));
      };
    }));
    expect(stored).toBe("false"); // the browser's private key can't be read out

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

/** A browser signed in to the hosted dashboard as the same GitHub user as `machine`. */
async function signedIn(machine: Machine, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = watchCsp(await context.newPage());
  await page.goto(publicUrl);
  await signIn(page, machine.githubUser);
  await pwExpect(page.getByRole("heading", { name: "Lobbies" })).toBeVisible();
  return page;
}

async function keyEpoch(machine: Machine, name: string): Promise<number> {
  const lobbies = await machine.rpc<{ name: string; keyEpoch: number }[]>("dashboard.lobbies");
  return lobbies.find((l) => l.name === name)?.keyEpoch ?? 0;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("people, from the browser", () => {
  it("joins with a pasted link, then the owner removes the member and the key changes", async () => {
    const owner = new Machine();
    await owner.login("boss");
    await owner.createLobby("team");
    await until(async () => (await keyEpoch(owner, "team")) === 1, "the first key");
    const link = (await owner.cli(owner.home, "invite")).match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];

    const helper = new Machine();
    await helper.login("helper");
    const helperPage = await signedIn(helper);
    await helperPage.getByRole("button", { name: "Join with invite" }).click();
    await helperPage.getByPlaceholder("https://…/invite/…").fill(link);
    await helperPage.getByRole("dialog").getByRole("button", { name: "Join" }).click();
    await pwExpect(helperPage.getByRole("heading", { name: "team" })).toBeVisible();
    await until(async () => (await keyEpoch(helper, "team")) === 1, "the helper's machine to get the key");

    const ownerPage = await signedIn(owner);
    await ownerPage.getByRole("link", { name: "team" }).click();
    await ownerPage.getByRole("button", { name: /People/ }).click();
    const helperRow = ownerPage.getByRole("dialog").getByRole("listitem").filter({ hasText: "@helper" });
    await pwExpect(helperRow).toBeVisible();
    await helperRow.getByRole("button", { name: "Remove" }).click();

    await until(async () => (await keyEpoch(owner, "team")) === 2, "a new key after the removal");
    await until(async () => (await helper.rpc<unknown[]>("dashboard.lobbies")).length === 0, "the helper's machine to leave");
    await helperPage.reload();
    await pwExpect(helperPage.getByText("No lobbies yet")).toBeVisible();
  });

  it("lists someone who joined only in the browser, lets the owner remove them, and keeps keyboard focus in the dialog", async () => {
    const owner = new Machine();
    await owner.login("webowner");
    await owner.createLobby("web-team");
    const link = (await owner.cli(owner.home, "invite")).match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];

    const guestLogin = `webonly${Date.now() % 1_000_000}`; // no machine, only a browser
    const guestPage = await newBrowserPage();
    await guestPage.goto(link);
    await signIn(guestPage, guestLogin);
    await guestPage.getByRole("button", { name: new RegExp(`Join as @${guestLogin}`) }).click();
    await pwExpect(guestPage.getByRole("heading", { name: "web-team" })).toBeVisible();

    const ownerPage = await signedIn(owner);
    await ownerPage.getByRole("link", { name: "web-team" }).click();
    const peopleButton = ownerPage.getByRole("button", { name: /People/ });
    await peopleButton.click();
    const dialog = ownerPage.getByRole("dialog");
    const guestRow = dialog.getByRole("listitem").filter({ hasText: `@${guestLogin}` });
    await pwExpect(guestRow).toBeVisible();

    // Tab and Shift+Tab stay inside the open dialog; Escape closes it and focus returns to the button.
    for (let i = 0; i < 6; i++) {
      await ownerPage.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await ownerPage.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await ownerPage.keyboard.press("Escape");
    await pwExpect(dialog).toHaveCount(0);
    await pwExpect(peopleButton).toBeFocused();

    await peopleButton.click();
    await guestRow.getByRole("button", { name: "Remove" }).click();
    await guestPage.reload();
    await pwExpect(guestPage.getByText("No lobbies yet")).toBeVisible();
  });

  it("lets a member leave from the browser", async () => {
    const owner = new Machine();
    await owner.login("host2");
    await owner.createLobby("leavable");
    const link = (await owner.cli(owner.home, "invite")).match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];
    const member = new Machine();
    await member.login("leaver");
    await member.cli(member.home, "accept", link);

    const page = await signedIn(member);
    await page.getByRole("link", { name: "leavable" }).click();
    await page.getByRole("button", { name: /People/ }).click();
    await page.getByRole("button", { name: "Leave lobby" }).click();
    await pwExpect(page.getByText("No lobbies yet")).toBeVisible();
  });

  it("shows a view-only member no way to add agents or invite", async () => {
    const owner = new Machine();
    await owner.login("host3");
    await owner.createLobby("view-only");
    const link = (await owner.cli(owner.home, "invite", "--viewer")).match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];
    const viewer = new Machine();
    await viewer.login("watcher");

    const page = await signedIn(viewer);
    await page.goto(link);
    await pwExpect(page.getByText("You'll join as a viewer.")).toBeVisible();
    await page.getByRole("button", { name: /Join as @watcher/ }).click();
    await pwExpect(page.getByRole("heading", { name: "view-only" })).toBeVisible();
    await pwExpect(page.getByRole("button", { name: "Add agent" })).toHaveCount(0);
    await pwExpect(page.getByRole("button", { name: "Invite people" })).toHaveCount(0);
  });

  it("signs out", async () => {
    const someone = new Machine();
    await someone.login("signer");
    const page = await signedIn(someone);
    await page.getByRole("button", { name: "Sign out" }).click();
    await pwExpect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
    await page.reload();
    await pwExpect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  });
});

describe("layout", () => {
  it("fits a phone screen without sideways scrolling, in both themes", async () => {
    const someone = new Machine();
    await someone.login("phone");
    await someone.createLobby("pocket");
    const page = await signedIn(someone, { width: 390, height: 844 });
    await page.getByRole("link", { name: "pocket" }).click();
    await pwExpect(page.getByRole("heading", { name: "pocket" })).toBeVisible();

    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/hosted-phone-dark.png`, fullPage: true });

    await page.getByRole("button", { name: "Light mode" }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(await overflow()).toBeLessThanOrEqual(0);
    await pwExpect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    if (SCREENSHOTS) {
      await page.waitForTimeout(400); // let the colour transition finish
      await page.screenshot({ path: `${SCREENSHOTS}/hosted-phone-light.png`, fullPage: true });
    }
  });
});

describe("editing an agent", () => {
  it("renames an agent and changes its areas from the browser, and the agent is told", async () => {
    const laptop = new Machine();
    await laptop.login("editor");
    const lobbyId = await laptop.createLobby("renames");
    const webDir = join(mkdtempSync(join(tmpdir(), "proj-")), "web");
    mkdirSync(webDir);
    const web = await laptop.agent("claude-code", webDir);
    await web.tool("lobby_status");
    await laptop.addAgent(lobbyId, web, "web-claude", ["Frontend"]);
    await web.until("lobby_status", "You were added");

    const page = await signedIn(laptop);
    await page.getByRole("link", { name: "renames" }).click();
    await pwExpect(page.locator(".agent-card").filter({ hasText: "web-claude" }).getByText("frontend")).toBeVisible();

    await page.getByRole("button", { name: "Edit web-claude" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Web UI");
    await page.getByRole("dialog").getByLabel("Owns").fill("frontend, Design System");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();

    const card = page.locator(".agent-card").filter({ hasText: "web-ui" });
    await pwExpect(card).toBeVisible();
    await pwExpect(card.getByText("design-system")).toBeVisible();
    await pwExpect(page.getByTestId("node-web-ui")).toBeVisible();
    expect(await web.until("lobby_status", "you are now web-ui")).toContain("you now own: frontend, design-system");
  });
});

describe("deleting a lobby", () => {
  it("lets the owner delete a lobby from the browser after confirming, and members' machines drop it", async () => {
    const owner = new Machine();
    await owner.login("deleter");
    await owner.createLobby("temporary");
    const link = (await owner.cli(owner.home, "invite")).match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];
    const guest = new Machine();
    await guest.login("guest2");
    await guest.cli(guest.home, "accept", link);
    await until(async () => (await keyEpoch(guest, "temporary")) === 1, "the guest to get the key");

    const page = await signedIn(owner);
    await page.getByRole("link", { name: "temporary" }).click();
    await page.getByRole("button", { name: "Delete lobby" }).click();
    await pwExpect(page.getByRole("dialog")).toContainText("can't be undone");
    await page.getByRole("dialog").getByRole("button", { name: "Delete lobby" }).click();

    await pwExpect(page.getByText("No lobbies yet")).toBeVisible();
    await until(async () => (await guest.rpc<unknown[]>("dashboard.lobbies")).length === 0, "the guest's machine to drop the lobby");
    await until(async () => (await owner.rpc<unknown[]>("dashboard.lobbies")).length === 0, "the owner's machine to drop the lobby");
  });
});

describe("account", () => {
  it("lists devices, revokes a machine, downloads your data, and deletes the account", async () => {
    const laptop = new Machine();
    await laptop.login("accounty");
    await laptop.createLobby("mine");
    const page = await signedIn(laptop);
    await page.getByRole("link", { name: "Account", exact: true }).click();

    // This browser and the laptop are both devices.
    await pwExpect(page.getByRole("row").filter({ hasText: "this device" })).toContainText("browser");
    const laptopRow = page.getByRole("row").filter({ hasText: "machine" });
    await pwExpect(laptopRow).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download your data" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("agentlobbies-account.json");

    await laptopRow.getByRole("button", { name: /Revoke/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
    await pwExpect(page.getByRole("row").filter({ hasText: "machine" })).toHaveCount(0);
    await until(async () => (await laptop.rpc("account.status")) === null, "the laptop to sign itself out");

    await page.getByRole("button", { name: "Delete account…" }).click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Delete account" });
    await pwExpect(confirm).toBeDisabled();
    await page.getByRole("dialog").locator("input").fill("accounty");
    await confirm.click();
    await pwExpect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  });

  it("shows the privacy policy and terms without signing in", async () => {
    const page = await newBrowserPage();
    await page.goto(`${publicUrl}/privacy`);
    await pwExpect(page.getByRole("heading", { name: "Privacy" })).toBeVisible();
    await pwExpect(page.getByText("We can't read your messages")).toBeVisible();
    await page.goto(`${publicUrl}/terms`);
    await pwExpect(page.getByRole("heading", { name: "Acceptable use" })).toBeVisible();
  });
});

describe("security headers", () => {
  it("serves the site with a strict Content-Security-Policy that nothing in these tests tripped", async () => {
    const res = await fetch(publicUrl);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(cspViolations).toEqual([]);
  });
});
