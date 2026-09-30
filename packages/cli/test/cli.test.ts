import { RpcClient } from "@agentlobbies/daemon/client";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    relayUrl: string;
    githubUrl: string;
  }
}

const CLI = join(import.meta.dirname, "../dist/cli.js");
const home = mkdtempSync(join("/tmp", "al-cli-"));
const folder = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));

afterAll(async () => {
  for (const h of [home, ...people.values()]) {
    const daemon = await RpcClient.connect(join(h, "daemon.sock")).catch(() => undefined);
    await daemon?.call("daemon.shutdown").catch(() => {});
    daemon?.close();
  }
});

async function cli(cwd: string, ...args: string[]): Promise<{ out: string; code: number }> {
  return cliWith({}, cwd, ...args);
}

async function cliWith(extraEnv: Record<string, string>, cwd: string, ...args: string[]): Promise<{ out: string; code: number }> {
  const env = { ...process.env, AGENTLOBBIES_HOME: home, AGENTLOBBIES_RELAY_URL: inject("relayUrl"), AGENTLOBBIES_GITHUB_URL: inject("githubUrl"), NO_COLOR: "1", ...extraEnv };
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env });
    return { out: stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { out: err.stdout + err.stderr, code: err.code };
  }
}

async function eventually(fn: () => Promise<{ out: string }>, contains: string) {
  for (const deadline = Date.now() + 10_000; ; ) {
    const r = await fn();
    if (r.out.includes(contains) || Date.now() > deadline) return r;
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** Runs the CLI as another signed-in person, with their own daemon home. */
const people = new Map<string, string>();
async function asPerson(login: string, ...args: string[]) {
  let personHome = people.get(login);
  if (!personHome) {
    personHome = mkdtempSync(join("/tmp", `al-${login}-`));
    people.set(login, personHome);
    await cliWith({ AGENTLOBBIES_HOME: personHome, AGENTLOBBIES_GITHUB_CLIENT_ID: `test-${login}` }, folder(login), "login", "--no-open");
  }
  return cliWith({ AGENTLOBBIES_HOME: personHome }, folder(login), ...args);
}

beforeAll(async () => {
  const login = await cli(folder("login"), "login");
  if (!login.out.includes("Signed in as @tester")) throw new Error(`login failed: ${login.out}`);
});

describe("agentlobbies CLI", () => {
  it("signs in with GitHub's device flow and shows who you are", async () => {
    const r = await cli(folder("x"), "login");
    expect(r.out).toContain("WDJB-MJHT");
    expect(r.out).toContain("Signed in as @tester");
    expect((await cli(folder("x"), "doctor")).out).toContain("Signed in as @tester");
  });

  it("asks you to sign in before creating a lobby", async () => {
    const freshHome = mkdtempSync(join("/tmp", "al-new-"));
    people.set("signed-out", freshHome);
    const r = await cliWith({ AGENTLOBBIES_HOME: freshHome }, folder("x"), "create");
    expect(r.code).toBe(1);
    expect(r.out).toContain("agentlobbies login");
  });

  it("creates a lobby and prints an invite link that another person accepts", async () => {
    const created = await cli(folder("x"), "create", "food-app");
    expect(created.out).toContain("food-app");
    const invite = await cli(folder("x"), "invite");
    const link = invite.out.match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];

    const bob = await asPerson("bob", "accept", link);
    expect(bob.out).toContain("Joined food-app");
    const players = await eventually(() => cli(folder("x"), "players"), "bob");
    expect(players.out).toMatch(/bob\s+@bob/);
    expect(players.out).toMatch(/tester\s+@tester/);
  });

  it("sends a message that the other person reads in their inbox", async () => {
    await cli(folder("x"), "create", "chat");
    const link = (await cli(folder("x"), "invite")).out.match(/https?:\/\/\S+\/invite\/[\w-]+/)![0];
    await asPerson("carol", "accept", link);
    await eventually(() => cli(folder("x"), "players"), "carol");

    expect((await cli(folder("x"), "send", "carol", "Is", "estimatedArrival", "ISO", "8601?")).code).toBe(0);
    const inbox = await eventually(() => asPerson("carol", "inbox"), "estimatedArrival");
    expect(inbox.out).toContain("tester (question)");
  });

  it("exits with code 4 for an invalid invite", async () => {
    const r = await cli(folder("x"), "accept", "https://relay.test/invite/not-a-real-invite-token-xx");
    expect(r.code).toBe(4);
    expect(r.out).toContain("invalid or expired");
  });

  it("installs into detected agents, reports it, and uninstalls cleanly", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "user-"));
    mkdirSync(join(userHome, ".claude"));
    const run = (...args: string[]) => cliWith({ HOME: userHome }, userHome, ...args);

    const installed = await run("install");
    expect(installed.code).toBe(0);
    expect(installed.out).toContain("Claude Code");
    expect(JSON.parse(readFileSync(join(userHome, ".claude.json"), "utf8")).mcpServers.agentlobbies.args).toEqual(["mcp"]);

    const doctor = await run("doctor");
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain("Relay reachable");
    expect(doctor.out).toContain("Claude Code configured");

    expect((await run("uninstall")).code).toBe(0);
    expect(JSON.parse(readFileSync(join(userHome, ".claude.json"), "utf8")).mcpServers.agentlobbies).toBeUndefined();
  });

  it("explains what to do when no supported agent is installed", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "user-"));
    const r = await cliWith({ HOME: userHome }, userHome, "install");
    expect(r.code).toBe(1);
    expect(r.out).toContain("agentlobbies mcp");
  });

  it("doctor fails with a clear message when the relay is unreachable", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "user-"));
    const r = await cliWith({ HOME: userHome, AGENTLOBBIES_RELAY_URL: "http://127.0.0.1:9" }, userHome, "doctor");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Relay not reachable");
  });
});
