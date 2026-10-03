import { PING, PONG } from "@agentlobbies/protocol";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const CALL_TIMEOUT_MS = 10_000;

const LocalAgent = z.object({
  seatKey: z.string(),
  client: z.string(),
  folder: z.string(),
  online: z.boolean(),
  secure: z.boolean().default(false),
  pendingApprovals: z.number().int().min(0).default(0),
  lobbies: z.array(z.object({ lobbyId: z.string(), name: z.string().nullable(), handle: z.string(), agentId: z.string() })),
});

const MachineMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("agents"), agents: z.array(LocalAgent).max(200) }),
  z.object({ t: z.literal("result"), id: z.string(), result: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() }),
]);

type Attachment = { kind: "machine"; machineId: string } | { kind: "web"; sessionId: string };

/** A daemon's answer: `error` if it failed. */
export interface CallResult {
  result?: Record<string, string | number | boolean | null>;
  error?: { code: string; message: string };
}

export interface MachineView {
  machineId: string;
  name: string;
  online: boolean;
  agents: z.infer<typeof LocalAgent>[];
}

/**
 * One per user (LLD 15.6). Holds a socket from each of the user's daemons and each open browser tab,
 * so the hosted dashboard can list the user's agents and ask a machine to add one to a lobby.
 */
export class UserDurableObject extends DurableObject<Env> {
  private readonly pending = new Map<string, (result: CallResult) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS machine_agents (
      machine_id TEXT PRIMARY KEY, name TEXT NOT NULL, agents_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** Only the Worker reaches this object; it builds these requests itself after checking who is connecting. */
  async fetch(req: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    const machineId = req.headers.get("X-Machine-Id");
    if (new URL(req.url).pathname === "/machine" && machineId) {
      for (const old of this.ctx.getWebSockets(machineId)) old.close(4009, "replaced");
      this.ctx.storage.sql.exec(
        `INSERT INTO machine_agents (machine_id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (machine_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
        machineId, req.headers.get("X-Machine-Name") ?? "unknown", Date.now(),
      );
      this.ctx.acceptWebSocket(server, [machineId]);
      server.serializeAttachment({ kind: "machine", machineId } satisfies Attachment);
    } else {
      const sessionId = req.headers.get("X-Session-Id") ?? "";
      this.ctx.acceptWebSocket(server, ["web", `session:${sessionId}`]);
      server.serializeAttachment({ kind: "web", sessionId } satisfies Attachment);
      server.send(JSON.stringify({ t: "machines", machines: this.machines() }));
    }
    this.pushMachines();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    if (att.kind !== "machine" || typeof raw !== "string" || raw.length > 64 * 1024) return;
    let parsed;
    try {
      parsed = MachineMessage.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success) return;

    const message = parsed.data;
    if (message.t === "agents") {
      this.ctx.storage.sql.exec("UPDATE machine_agents SET agents_json = ?, updated_at = ? WHERE machine_id = ?",
        JSON.stringify(message.agents), Date.now(), att.machineId);
      this.pushMachines();
    } else {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      if (message.error) waiting({ error: message.error });
      else waiting({ result: message.result });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if ((ws.deserializeAttachment() as Attachment).kind === "machine") this.pushMachines(ws);
  }

  /** Every machine the user has signed in on, and whether its daemon is connected now. */
  machines(closing?: WebSocket): MachineView[] {
    const online = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const att = ws.deserializeAttachment() as Attachment;
      if (att.kind === "machine") online.add(att.machineId);
    }
    const rows = this.ctx.storage.sql.exec<{ machine_id: string; name: string; agents_json: string }>(
      "SELECT machine_id, name, agents_json FROM machine_agents ORDER BY updated_at DESC",
    ).toArray();
    return rows.map((r) => ({ machineId: r.machine_id, name: r.name, online: online.has(r.machine_id), agents: JSON.parse(r.agents_json) }));
  }

  /** Runs `method` on one of the user's daemons and waits for its answer. */
  async call(machineId: string, method: string, params: Record<string, unknown>): Promise<CallResult> {
    const socket = this.ctx.getWebSockets(machineId)[0];
    if (!socket) return { error: { code: "machine_offline", message: "That machine is offline. Start an agent on it, or run `agentlobbies status` there." } };

    const id = crypto.randomUUID();
    return new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => finish({ error: { code: "machine_offline", message: "That machine didn't answer in time." } }), CALL_TIMEOUT_MS);
      const finish = (result: CallResult) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(result);
      };
      this.pending.set(id, finish);
      socket.send(JSON.stringify({ t: "call", id, method, params }));
    });
  }

  /** A device was revoked: tell that machine, so it signs itself out, and disconnect it. */
  async revokeMachine(machineId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(machineId)) {
      try {
        ws.send(JSON.stringify({ t: "revoked" }));
      } catch {
        // Already closing.
      }
      ws.close(4003, "device revoked");
    }
    this.ctx.storage.sql.exec("DELETE FROM machine_agents WHERE machine_id = ?", machineId);
    this.pushMachines();
  }

  /** A browser signed out or was revoked: its open tabs disconnect. */
  async closeSession(sessionId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`session:${sessionId}`)) ws.close(4003, "signed out");
  }

  /** The account was deleted: disconnect everyone and erase what this object kept. */
  async forget(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4003, "account deleted");
    // Emptied rather than dropped: the close handlers that follow still read the table.
    this.ctx.storage.sql.exec("DELETE FROM machine_agents");
  }

  /** Tells every daemon and browser tab of this user that something changed, e.g. `{ t: "lobbies" }`. */
  async notify(message: { t: string }): Promise<void> {
    const frame = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // The socket is closing.
      }
    }
  }

  private pushMachines(closing?: WebSocket): void {
    const frame = JSON.stringify({ t: "machines", machines: this.machines(closing) });
    for (const ws of this.ctx.getWebSockets("web")) {
      try {
        ws.send(frame);
      } catch {
        // The tab is closing.
      }
    }
  }
}
