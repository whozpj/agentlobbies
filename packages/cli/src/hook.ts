#!/usr/bin/env node
// Claude Code and Codex hooks that deliver lobby messages without the agent asking (see `install`).
// Every failure exits 0 quietly: a hook must never get in the way of an agent that isn't in a lobby.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RpcClient, defaultHome, socketPath, type SurfacedMessage } from "@agentlobbies/daemon/client";
import { renderPending } from "@agentlobbies/mcp-server/render";

const WAIT_MS = 55 * 60_000; // just under the hook's 1 hour timeout

interface HookInput {
  cwd: string;
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  transcript_path?: string | null;
}

async function readInput(): Promise<HookInput> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

type Call = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `codex exec` run has to finish, so it must not wait for messages. Its transcript starts with how it was started. */
function isCodexExec(transcriptPath: string | null | undefined): boolean {
  if (!transcriptPath) return false;
  try {
    const firstLine = readFileSync(transcriptPath, "utf8").split("\n", 1)[0]!;
    return JSON.parse(firstLine).payload?.source === "exec";
  } catch {
    return false;
  }
}

/** Opens a daemon session for this agent's folder, or returns undefined if no daemon is running. */
async function connect(client: string, cwd: string): Promise<{ call: Call; close: () => void } | undefined> {
  let daemon: RpcClient;
  try {
    daemon = await RpcClient.connect(socketPath(defaultHome()));
  } catch {
    return undefined;
  }
  try {
    // A hook can outlive its agent, so its session doesn't count as the agent running.
    const { sessionId } = await daemon.call<{ sessionId: string }>("session.open", { client, cwd, passive: true });
    const call: Call = (method, params = {}, timeoutMs) => daemon.call(method, { sessionId, ...params }, timeoutMs);
    return { call, close: () => daemon.close() };
  } catch {
    daemon.close();
    return undefined;
  }
}

/**
 * Waits for unread messages. Keeps waiting until the user adds this agent to a lobby, and through
 * daemon restarts (an upgrade replaces the daemon): reconnects instead of giving up.
 */
async function waitForMessages(client: string, cwd: string): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const daemon = await connect(client, cwd);
    if (!daemon) {
      await sleep(2_000); // the daemon is restarting
      continue;
    }
    try {
      await daemon.call("presence.set", { status: "idle" }).catch(() => {}); // shown as "waiting"
      const remaining = deadline - Date.now();
      const result = await daemon.call<{ unread?: number; cancelled?: boolean }>("inbox.wait", { timeoutMs: remaining }, remaining + 5_000);
      if (result.cancelled) return 0; // a newer wait for this agent took over
      return result.unread ?? 0;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "no_seat" && code !== "daemon_unavailable") return 0;
      await sleep(2_000);
    } finally {
      daemon.close();
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const event = process.argv[2];
  const client = process.argv[3] ?? "claude-code";
  const input = await readInput();

  if (client === "codex") {
    const daemon = await connect(client, input.cwd);
    if (daemon) {
      try {
        if (input.session_id && !isCodexExec(input.transcript_path)) {
          const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
          await daemon.call("codex.attach", {
            threadId: input.session_id,
            socketPath: join(codexHome, "app-server-control", "app-server-control.sock"),
          }).catch(() => {});
        }
        // Codex finishes normally; the daemon wakes its existing chat when new messages arrive.
        if (event === "wait") {
          await daemon.call("presence.set", { status: "idle" }).catch(() => {});
          return 0;
        }
      } finally { daemon.close(); }
    }
    if (event === "wait") return 0;
  }

  if (event === "wait") {
    // Claude Code can hold a new session until its SessionStart hooks finish, so a wait there would
    // block the user's first message. Installs from before 0.6.4 still have one; it ends at once.
    if (input.hook_event_name === "SessionStart") return 0;
    const unread = await waitForMessages(client, input.cwd);
    if (!unread) return 0;
  } else if (event === "post-tool-use" && input.tool_name?.startsWith("mcp__agentlobbies__")) {
    return 0;
  }

  const daemon = await connect(client, input.cwd);
  if (!daemon) return 0; // no daemon running, so this agent isn't in a lobby
  try {
    if (event !== "wait") await daemon.call("presence.set", { status: "active" }).catch(() => {}); // shown as "working"
    const messages = await daemon.call<SurfacedMessage[]>("inbox.pull", { limit: 5 });
    if (messages.length === 0) return 0;
    const { unread } = await daemon.call<{ unread: number }>("inbox.peek");
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
