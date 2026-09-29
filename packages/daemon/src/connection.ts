import { ServerFrame, TIMINGS, type ClientFrame } from "@agentlobbies/protocol";

export type ConnectionState =
  | "connecting" | "handshaking" | "replaying" | "live" | "backoff" | "stopped"
  | "kicked" | "closed" | "upgrade_required" | "replaced";

// Close codes that end a seat for good (LLD 3.5): no reconnect.
const TERMINAL: Record<number, ConnectionState> = { 4003: "kicked", 4009: "replaced", 4010: "closed", 4011: "upgrade_required" };

export interface ConnectionOptions {
  url: string;
  token: () => Promise<string>;
  /** Called when the relay refuses the socket before it opens, usually a bad token. */
  onRejected: () => void;
  clientVersion: string;
  /** The seat's durable cursor, read at every (re)connect. */
  cursor: () => number;
  onFrame: (frame: ServerFrame) => void | Promise<void>;
  onState: (state: ConnectionState) => void;
}

/**
 * One seat's WebSocket to the relay (LLD 7.4): connect, hello, replay, live, and reconnect with
 * exponential backoff and full jitter. Frames are handled one at a time, in order.
 */
export class Connection {
  state: ConnectionState = "stopped";
  private ws: WebSocket | undefined;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private queue = Promise.resolve();

  constructor(private readonly opts: ConnectionOptions) {}

  async start(): Promise<void> {
    if (this.state !== "stopped" && this.state !== "backoff") return;
    this.setState("connecting");
    let token: string;
    try {
      token = await this.opts.token();
    } catch {
      return this.retryLater();
    }
    if (this.state === "stopped") return;
    const ws = new WebSocket(this.opts.url, ["agentlobbies.v1", `bearer.${token}`]);
    this.ws = ws;
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
      this.setState("handshaking");
      this.send({ t: "hello", v: 1, afterSeq: this.opts.cursor(), clientVersion: this.opts.clientVersion, wantsPresence: false });
    });
    ws.addEventListener("message", (m) => {
      const parsed = ServerFrame.safeParse(JSON.parse(String(m.data)));
      if (!parsed.success) return;
      // Process frames strictly in arrival order, even though handlers are async.
      this.queue = this.queue.then(() => this.handle(parsed.data)).catch(() => {});
    });
    ws.addEventListener("close", (e) => {
      if (!opened) this.opts.onRejected();
      this.onClose(ws, e.code);
    });
    ws.addEventListener("error", () => {}); // a close event always follows
  }

  stop(): void {
    clearTimeout(this.reconnectTimer);
    this.setState("stopped");
    this.ws?.close(1000);
    this.ws = undefined;
  }

  send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private async handle(frame: ServerFrame): Promise<void> {
    if (frame.t === "welcome") this.setState("replaying");
    await this.opts.onFrame(frame);
    if (frame.t === "events" && !frame.more) {
      this.attempt = 0;
      this.setState("live");
    }
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws || this.state === "stopped") return;
    this.ws = undefined;
    const terminal = TERMINAL[code];
    if (terminal) return this.setState(terminal);
    this.retryLater();
  }

  private retryLater(): void {
    if (this.state === "stopped") return;
    const delay = Math.random() * Math.min(TIMINGS.reconnectMaxMs, TIMINGS.reconnectMinMs * 2 ** this.attempt++);
    this.setState("backoff");
    this.reconnectTimer = setTimeout(() => void this.start(), delay);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.opts.onState(state);
  }
}
