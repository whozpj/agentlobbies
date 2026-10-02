import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { Daemon } from "../src/daemon";

const relayUrl = inject("relayUrl");
const running: Daemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function startDaemon(home = mkdtempSync(join(tmpdir(), "al-home-"))) {
  const daemon = new Daemon({ home, relayUrl });
  await daemon.start();
  running.push(daemon);
  return daemon;
}

describe("accounts", () => {
  it("signs in with a GitHub token and remembers it across restarts", async () => {
    const home = mkdtempSync(join(tmpdir(), "al-home-"));
    let daemon = await startDaemon(home);
    expect(await daemon.call("account.status", {})).toBeNull();
    expect(await daemon.call("account.login", { githubToken: "gho_fake_whozpj" })).toMatchObject({ login: "whozpj" });
    await daemon.stop();
    daemon = await startDaemon(home);
    expect(await daemon.call("account.status", {})).toMatchObject({ login: "whozpj" });
  });

  it("asks you to sign in before creating a lobby or accepting an invite", async () => {
    const daemon = await startDaemon();
    await expect(daemon.call("lobby.create", { name: "x" })).rejects.toMatchObject({ code: "login_required" });
    await expect(daemon.call("invite.accept", { invite: "https://relay/invite/abcdefghijklmnopqrstuvwxyz" })).rejects.toMatchObject({ code: "login_required" });
  });

  it("refreshes an unreadable account token with the machine key", async () => {
    const home = mkdtempSync(join(tmpdir(), "al-home-"));
    let daemon = await startDaemon(home);
    await daemon.call("account.login", { githubToken: "gho_fake_refresher" });
    await daemon.stop();
    const db = new DatabaseSync(join(home, "daemon.db"));
    db.prepare("UPDATE account SET token = 'garbage'").run();
    db.close();

    daemon = await startDaemon(home);
    expect(await daemon.call("lobby.create", { name: "after-refresh" })).toHaveProperty("lobbyId");
  });

  it("signs out", async () => {
    const daemon = await startDaemon();
    await daemon.call("account.login", { githubToken: "gho_fake_leaver" });
    await daemon.call("account.logout", {});
    expect(await daemon.call("account.status", {})).toBeNull();
    await expect(daemon.call("lobby.create", { name: "x" })).rejects.toMatchObject({ code: "login_required" });
  });
});

describe("devices and your data", () => {
  const user = () => `gho_fake_devices.${Math.random().toString(36).slice(2, 10)}`;

  it("lists this machine among your devices, and revoking another one signs only that one out", async () => {
    const githubToken = user();
    const laptop = await startDaemon();
    await laptop.call("account.login", { githubToken });
    const desktop = await startDaemon();
    await desktop.call("account.login", { githubToken });

    const devices: { deviceId: string; current: boolean; kind: string }[] = await laptop.call("devices.list", {});
    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.current)).toHaveLength(1);
    const desktopId = devices.find((d) => !d.current)!.deviceId;

    await laptop.call("devices.revoke", { deviceId: desktopId });
    expect(await laptop.call("account.status", {})).not.toBeNull();
    await expect(desktop.call("devices.list", {})).rejects.toMatchObject({ code: "login_required" });
  });

  it("revoking this machine signs it out", async () => {
    const laptop = await startDaemon();
    await laptop.call("account.login", { githubToken: user() });
    const [me] = await laptop.call("devices.list", {});
    await laptop.call("devices.revoke", { deviceId: me.deviceId });
    expect(await laptop.call("account.status", {})).toBeNull();
  });

  it("exports your account data, and deleting the account removes your lobbies here too", async () => {
    const laptop = await startDaemon();
    await laptop.call("account.login", { githubToken: user() });
    await laptop.call("lobby.create", { name: "mine" });
    const exported = await laptop.call("account.export", {});
    expect(exported.lobbies).toHaveLength(1);

    await laptop.call("account.delete", {});
    expect(await laptop.call("account.status", {})).toBeNull();
    expect(await laptop.call("dashboard.lobbies", {})).toEqual([]);
  });
});
