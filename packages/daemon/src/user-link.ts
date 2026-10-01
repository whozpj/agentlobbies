import { PING, TIMINGS } from "@agentlobbies/protocol";

export interface UserLinkOptions {
  url: string;
  token: () => Promise<string>;
  /** This machine's agents, as the dashboard lists them. */
  agents: () => unknown[];
  /** A request from the hosted dashboard, e.g. adding an agent to a lobby. */
  onCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onLobbiesChanged: () => void;
}

interface Incoming {
  t: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * This machine's connection to its user's object on the relay (LLD 15.6). The hosted dashboard sees
 * this machine's agents through it, and asks this machine to add one to a lobby.
 */
export class UserLink {
  private ws: WebSocket | undefined;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly opts: UserLinkOptions) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    let token: string;
    try {
      token = await this.opts.token();
    } catch {
      return this.retryLater();
    }
    if (this.stopped) return;

    const ws = new WebSocket(this.opts.url, ["agentlobbies.v1", `account.${token}`]);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.attempt = 0;
      this.sendAgents();
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(PING);
      }, TIMINGS.heartbeatIntervalMs);
    });
    ws.addEventListener("message", (m) => void this.onMessage(String(m.data)));
    ws.addEventListener("close", () => {
      clearInterval(this.heartbeat);
      if (this.ws === ws) this.retryLater();
    });
    ws.addEventListener("error", () => {}); // a close event always follows
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.ws?.close(1000);
    this.ws = undefined;
  }

  sendAgents(): void {
    this.send({ t: "agents", agents: this.opts.agents() });
  }

  private async onMessage(data: string): Promise<void> {
    let message: Incoming;
    try {
      message = JSON.parse(data) as Incoming;
    } catch {
      return;
    }

    if (message.t === "lobbies") {
      this.opts.onLobbiesChanged();
      return;
    }
    if (message.t !== "call" || !message.id) return;

    try {
      const result = await this.opts.onCall(String(message.method), message.params ?? {});
      this.send({ t: "result", id: message.id, result });
    } catch (e) {
      const error = e as { code?: string; message?: string };
      this.send({ t: "result", id: message.id, error: { code: error.code ?? "internal", message: error.message ?? "failed" } });
    }
  }

  private send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private retryLater(): void {
    if (this.stopped) return;
    const delay = Math.random() * Math.min(TIMINGS.reconnectMaxMs, TIMINGS.reconnectMinMs * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => void this.start(), delay);
  }
}
