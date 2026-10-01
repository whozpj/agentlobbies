import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { DaemonError } from "./rpc";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface DashboardSource {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  on(event: "activity", listener: (activity: unknown) => void): unknown;
  off(event: "activity", listener: (activity: unknown) => void): unknown;
}

export interface Dashboard {
  url: string;
  close(): Promise<void>;
}

/**
 * The local web dashboard: a JSON API, a server-sent event stream, and the built app.
 * Bound to 127.0.0.1 and guarded by a per-run token plus a Host check, because any website
 * the user visits can try to reach localhost ports.
 */
export async function startDashboard(source: DashboardSource, staticDir: string | undefined): Promise<Dashboard> {
  const token = randomBytes(24).toString("hex");
  let port = 0;

  const server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, staticDir, url.pathname);
    if (!tokenMatches(url.searchParams.get("token") ?? req.headers["x-dashboard-token"], token)) {
      return send(res, 401, { error: "unauthorized" });
    }
    handleApi(source, req, res, url).catch((e) => {
      const status = e instanceof DaemonError ? 400 : 500;
      send(res, status, { error: { code: e.code ?? "internal", message: e.message } });
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () => new Promise((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}

async function handleApi(source: DashboardSource, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  const lobby = url.pathname.match(/^\/api\/lobbies\/([0-9a-f]{64})(?:\/|$)/)?.[1];
  const agentId = url.pathname.match(/\/agents\/([0-9A-HJKMNP-TV-Z]{26})$/)?.[1];
  const login = url.pathname.match(/\/members\/([\w-]+)$/)?.[1];
  const body = async () => JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  const reply = async (method: string, params: Record<string, unknown> = {}) => send(res, 200, await source.call(method, params));

  if (route === "GET /api/me") return reply("account.status");
  if (route === "GET /api/lobbies") return reply("dashboard.lobbies");
  if (route === "POST /api/lobbies") return reply("lobby.create", await body());
  if (route === "GET /api/agents") return reply("agents.list");
  if (route === "POST /api/invites/accept") return reply("invite.accept", await body());
  if (route === "GET /api/events") return streamActivity(source, req, res);
  if (lobby && route === `GET /api/lobbies/${lobby}/messages`) return reply("dashboard.messages", { lobbyId: lobby });
  if (lobby && route === `POST /api/lobbies/${lobby}/invites`) return reply("invite.create", { ...(await body()), lobbyId: lobby });
  if (lobby && route === `POST /api/lobbies/${lobby}/agents`) return reply("lobby.addAgent", { ...(await body()), lobbyId: lobby });
  if (lobby && agentId && req.method === "DELETE") return reply("lobby.removeAgent", { lobbyId: lobby, agentId });
  if (lobby && agentId && req.method === "PATCH") return reply("lobby.updateAgent", { ...(await body()), lobbyId: lobby, agentId });
  if (lobby && login && req.method === "DELETE") return reply("lobby.removeMember", { lobbyId: lobby, login });
  if (route === `DELETE /api/lobbies/${lobby}`) return reply("lobby.delete", { lobbyId: lobby });
  if (route === `POST /api/lobbies/${lobby}/forget`) return reply("lobby.forget", { lobbyId: lobby });
  send(res, 404, { error: "not found" });
}

function streamActivity(source: DashboardSource, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  const listener = (activity: unknown) => res.write(`data: ${JSON.stringify(activity)}\n\n`);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  source.on("activity", listener);
  req.on("close", () => {
    clearInterval(keepAlive);
    source.off("activity", listener);
  });
}

function serveStatic(res: ServerResponse, staticDir: string | undefined, pathname: string): void {
  const root = resolve(staticDir ?? ".");
  if (!staticDir || !existsSync(join(root, "index.html"))) return send(res, 404, { error: "dashboard not built" });
  const requested = resolve(root, `.${decodeURIComponent(pathname)}`);
  const inside = requested.startsWith(root + sep);
  const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : join(root, "index.html");
  const headers: Record<string, string> = { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" };
  // index.html names this version's asset files, so browsers must re-check it after an upgrade.
  if (file.endsWith("index.html")) headers["cache-control"] = "no-cache";
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
