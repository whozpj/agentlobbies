import { createConnection, createServer, type Server, type Socket } from "node:net";
import { TIMINGS } from "@agentlobbies/protocol";

// Newline-delimited JSON-RPC 2.0 over a Unix socket (LLD 7.8). Errors carry our string code in
// `error.data.code`.

export class DaemonError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(message);
    this.name = "DaemonError";
  }
}

type Handler = (method: string, params: Record<string, unknown>, conn: Socket) => Promise<unknown>;

/** Calls `onLine` for each complete line received on a socket. */
function readLines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export class RpcServer {
  private readonly server: Server;
  private readonly clients = new Set<Socket>();

  constructor(handler: Handler, onDisconnect: (conn: Socket) => void = () => {}) {
    this.server = createServer((socket) => {
      this.clients.add(socket);
      socket.on("close", () => {
        this.clients.delete(socket);
        onDisconnect(socket);
      });
      socket.on("error", () => socket.destroy());
      readLines(socket, async (line) => {
        let request: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          request = JSON.parse(line);
        } catch {
          return this.write(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        }
        try {
          const result = await handler(request.method ?? "", request.params ?? {}, socket);
          this.write(socket, { jsonrpc: "2.0", id: request.id, result: result ?? null });
        } catch (e) {
          const code = e instanceof DaemonError ? e.code : "internal";
          const message = e instanceof Error ? e.message : String(e);
          this.write(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message, data: { code } } });
        }
      });
    });
  }

  listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => resolve());
    });
  }

  notify(socket: Socket, method: string, params: unknown): void {
    this.write(socket, { jsonrpc: "2.0", method, params });
  }

  notifyAll(method: string, params: unknown): void {
    for (const socket of this.clients) this.notify(socket, method, params);
  }

  close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private write(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private notificationHandlers: ((n: { method: string; params: unknown }) => void)[] = [];

  private constructor(private readonly socket: Socket) {
    readLines(socket, (line) => {
      const msg = JSON.parse(line);
      if (msg.id === undefined || msg.id === null) {
        if (msg.method) this.notificationHandlers.forEach((h) => h({ method: msg.method, params: msg.params }));
        return;
      }
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) call.reject(new DaemonError(msg.error.data?.code ?? "internal", msg.error.message));
      else call.resolve(msg.result);
    });
    socket.on("close", () => {
      for (const call of this.pending.values()) call.reject(new DaemonError("daemon_unavailable", "daemon connection closed"));
      this.pending.clear();
    });
  }

  static connect(path: string): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new RpcClient(socket)));
      socket.once("error", reject);
    });
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs: number = TIMINGS.rpcTimeoutMs): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonError("timeout", `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  onNotification(handler: (n: { method: string; params: unknown }) => void): void {
    this.notificationHandlers.push(handler);
  }

  close(): void {
    this.socket.end();
  }
}
