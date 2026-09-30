import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectToDaemon, openSession } from "../dist/client.js";
import { RpcServer } from "../src/rpc";
import { CLIENT_VERSION } from "../src/version";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    const daemon = await connectToDaemon(home);
    await daemon.call("daemon.shutdown").catch(() => {});
    daemon.close();
  }
});

function newHome() {
  const home = mkdtempSync(join("/tmp", "al-"));
  homes.push(home);
  return home;
}

describe("connectToDaemon", () => {
  it("starts the daemon when none is running, then reuses it", async () => {
    const home = newHome();
    const first = await connectToDaemon(home);
    const { pid } = await first.call<{ pid: number }>("daemon.info");
    const second = await connectToDaemon(home);
    expect((await second.call<{ pid: number }>("daemon.info")).pid).toBe(pid);
    first.close();
    second.close();
  });
});

describe("version skew", () => {
  it("replaces a daemon older than the client with a current one", async () => {
    const home = newHome();
    let shutdownAsked = false;
    const old = new RpcServer(async (method) => {
      if (method === "daemon.info") return { version: "0.0.1", pid: 1 };
      if (method === "daemon.shutdown") {
        shutdownAsked = true;
        setImmediate(() => old.close());
        return {};
      }
      return {};
    });
    await old.listen(join(home, "daemon.sock"));

    const client = await connectToDaemon(home);
    const info = await client.call<{ version: string }>("daemon.info");
    expect(shutdownAsked).toBe(true);
    expect(info.version).toBe(CLIENT_VERSION);
    client.close();
  });
});

describe("openSession", () => {
  it("restarts the daemon and reopens the session if the daemon goes away", async () => {
    const home = newHome();
    const session = await openSession({ client: "claude-code", cwd: home, home });
    const before = await session.call<{ pid: number }>("daemon.info");

    await session.call("daemon.shutdown");
    await new Promise((r) => setTimeout(r, 300));

    const after = await session.call<{ pid: number }>("daemon.info");
    expect(after.pid).not.toBe(before.pid);
    await expect(session.call("lobby.status")).rejects.toMatchObject({ code: "no_seat" });
    session.close();
  });
});
