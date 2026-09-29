import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonError, RpcClient, RpcServer } from "../src/rpc";

const socketPath = () => join(mkdtempSync(join(tmpdir(), "al-rpc-")), "test.sock");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function pair(handler: ConstructorParameters<typeof RpcServer>[0]) {
  const path = socketPath();
  const server = new RpcServer(handler);
  await server.listen(path);
  const client = await RpcClient.connect(path);
  cleanups.push(() => client.close(), () => server.close());
  return { server, client };
}

describe("JSON-RPC over a Unix socket", () => {
  it("returns a method's result", async () => {
    const { client } = await pair(async (method, params) => ({ method, params }));
    expect(await client.call("echo", { a: 1 })).toEqual({ method: "echo", params: { a: 1 } });
  });

  it("passes a DaemonError's code and message to the caller", async () => {
    const { client } = await pair(async () => { throw new DaemonError("no_seat", "join a lobby first"); });
    await expect(client.call("lobby.status", {})).rejects.toMatchObject({ code: "no_seat", message: "join a lobby first" });
  });

  it("pushes notifications to connected clients", async () => {
    const { server, client } = await pair(async () => ({}));
    const received = new Promise((resolve) => client.onNotification(resolve));
    await client.call("ping", {});
    server.notifyAll("inbox.new", { unread: 2 });
    expect(await received).toEqual({ method: "inbox.new", params: { unread: 2 } });
  });
});
