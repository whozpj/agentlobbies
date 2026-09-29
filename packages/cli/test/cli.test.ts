import { RpcClient } from "@agentlobbies/daemon/client";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, inject, it } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    relayUrl: string;
  }
}

const CLI = join(import.meta.dirname, "../dist/cli.js");
const home = mkdtempSync(join("/tmp", "al-cli-"));
const folder = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));

afterAll(async () => {
  const daemon = await RpcClient.connect(join(home, "daemon.sock")).catch(() => undefined);
  await daemon?.call("daemon.shutdown").catch(() => {});
  daemon?.close();
});

async function cli(cwd: string, ...args: string[]): Promise<{ out: string; code: number }> {
  return cliWith({}, cwd, ...args);
}

async function cliWith(extraEnv: Record<string, string>, cwd: string, ...args: string[]): Promise<{ out: string; code: number }> {
  const env = { ...process.env, AGENTLOBBIES_HOME: home, AGENTLOBBIES_RELAY_URL: inject("relayUrl"), NO_COLOR: "1", ...extraEnv };
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

const codeIn = (out: string) => out.match(/[2-9]-[a-z]+-[a-z]+/)![0];

describe("agentlobbies CLI", () => {
  it("creates a lobby, lets another folder join, and shows both players", async () => {
    const hostDir = folder("host");
    const created = await cli(hostDir, "create", "--name", "food-app", "--handle", "prithvi");
    expect(created.code).toBe(0);
    expect(created.out).toContain("Share this code");

    const apiDir = folder("api");
    const joined = await cli(apiDir, "join", codeIn(created.out), "--handle", "api-human", "--owns", "api,auth");
    expect(joined.out).toContain("Joined as api-human");

    const players = await eventually(() => cli(hostDir, "players"), "api-human");
    expect(players.out).toContain("prithvi");
    expect(players.out).toContain("api, auth");
    expect((await cli(hostDir, "status")).out).toContain("food-app");
  });

  it("sends a message that the other folder reads in its inbox", async () => {
    const hostDir = folder("host");
    const apiDir = folder("api");
    const code = codeIn((await cli(hostDir, "create", "--handle", "host")).out);
    await cli(apiDir, "join", code, "--handle", "api");
    await eventually(() => cli(hostDir, "players"), "api");

    expect((await cli(hostDir, "send", "api", "Is", "estimatedArrival", "ISO", "8601?")).code).toBe(0);
    const inbox = await eventually(() => cli(apiDir, "inbox"), "estimatedArrival");
    expect(inbox.out).toContain("host (question)");
  });

  it("mints a code for the host and refuses members with exit code 6", async () => {
    const hostDir = folder("host");
    const apiDir = folder("api");
    const code = codeIn((await cli(hostDir, "create", "--handle", "host")).out);
    await cli(apiDir, "join", code, "--handle", "api");

    expect(codeIn((await cli(hostDir, "code", "--uses", "1")).out)).toMatch(/^[2-9]-/);
    const refused = await cli(apiDir, "code");
    expect(refused.code).toBe(6);
  });

  it("approves a join that an agent started (G42)", async () => {
    const hostDir = folder("host");
    const code = codeIn((await cli(hostDir, "create", "--handle", "host")).out);

    const daemon = await RpcClient.connect(join(home, "daemon.sock"));
    const { sessionId } = await daemon.call("session.open", { client: "codex", cwd: folder("agent") });
    await expect(daemon.call("lobby.join", { sessionId, code, handle: "api-codex", source: "agent" })).rejects.toMatchObject({ code: "join_pending" });

    const pending = await cli(hostDir, "approve");
    expect(pending.out).toContain("api-codex");
    const id = pending.out.match(/\b([0-9A-HJKMNP-TV-Z]{26})\b/)![1]!;
    expect((await cli(hostDir, "approve", id)).out).toContain("Approved");
    expect(await daemon.call("lobby.status", { sessionId })).toMatchObject({ handle: "api-codex" });
    daemon.close();
  });

  it("exits with code 4 for an invalid code", async () => {
    const r = await cli(folder("x"), "join", "2-abandon-ability", "--handle", "someone");
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
