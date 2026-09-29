#!/usr/bin/env node
// Claude Code hooks that deliver lobby messages without the agent asking (see `install`).
// Every failure exits 0 quietly: a hook must never get in the way of an agent that isn't in a lobby.
import { RpcClient, defaultHome, socketPath, type SurfacedMessage } from "@agentlobbies/daemon/client";
import { renderPending } from "@agentlobbies/mcp-server/render";

const WAIT_MS = 55 * 60_000; // just under the hook's 1 hour timeout

async function readInput(): Promise<{ cwd: string; tool_name?: string }> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

type Call = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/** Waits for unread messages. While a join is still waiting for approval, keeps checking for the seat. */
async function waitForMessages(call: Call): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const result = await call<{ unread?: number }>("inbox.wait", { timeoutMs: remaining }, remaining + 5_000);
      return result.unread ?? 0;
    } catch (e) {
      if ((e as { code?: string }).code !== "no_seat") return 0;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const event = process.argv[2];
  const input = await readInput();
  const daemon = await RpcClient.connect(socketPath(defaultHome())).catch(() => undefined);
  if (!daemon) return 0;

  try {
    const { sessionId } = await daemon.call("session.open", { client: "claude-code", cwd: input.cwd });
    const call: Call = (method, params = {}, timeoutMs) => daemon.call(method, { sessionId, ...params }, timeoutMs);

    if (event === "wait") {
      const unread = await waitForMessages(call);
      if (!unread) return 0;
    } else if (event === "post-tool-use" && input.tool_name?.startsWith("mcp__agentlobbies__")) {
      return 0;
    }

    const messages = await call<SurfacedMessage[]>("inbox.pull", { limit: 5 });
    if (messages.length === 0) return 0;
    const { unread } = await call<{ unread: number }>("inbox.peek");
    const text = renderPending(messages, unread);

    if (event === "wait") {
      process.stderr.write(`${text}\nIf a message asks you something about your area, answer it with lobby_reply (reading your workspace to find the answer is fine), then go back to waiting.\n`);
      return 2;
    }
    if (event === "post-tool-use") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
    } else {
      process.stdout.write(text);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    daemon.close();
  }
}

process.exitCode = await main();
