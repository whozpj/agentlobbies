import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectToDaemon } from "../dist/client.js";

const opened: { close(): void; call(m: string): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) {
    await c.call("daemon.shutdown").catch(() => {});
    c.close();
  }
});

describe("connectToDaemon", () => {
  it("starts the daemon when none is running, then reuses it", async () => {
    const home = mkdtempSync(join("/tmp", "al-"));
    const first = await connectToDaemon(home);
    opened.push(first);
    const { pid } = await first.call<{ pid: number }>("daemon.info");

    const second = await connectToDaemon(home);
    opened.push(second);
    expect((await second.call<{ pid: number }>("daemon.info")).pid).toBe(pid);
  });
});
