import {
  JoinProfile, LobbyCode, LobbySettings, ProtocolError, RATES, TIMINGS, fromB64u, httpStatusOf, refreshSigningBytes, verifyBytes, webCrypto,
  type ErrorCode, type Owner,
} from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { z } from "zod";
import { issueAccountJwt, issueJwt, tokenFromSubprotocol, verifyAccountJwt, verifyJwt, type Claims } from "./auth";
import { insertCode } from "./codes";

export { LobbyDurableObject } from "./lobby-do";

const MAX_BODY_BYTES = 160 * 1024;

const CreateLobbyBody = z.object({ host: JoinProfile, settings: LobbySettings.partial().optional() });
const JoinBody = z.object({ code: LobbyCode, agent: JoinProfile });
const RefreshBody = z.object({ agentId: z.string(), ts: z.number().int(), sig: z.string() });
const GitHubSignInBody = z.object({ githubToken: z.string().min(1), machinePublicKey: z.string(), machineName: z.string().max(100) });
const AccountRefreshBody = z.object({ machineId: z.string(), ts: z.number().int(), sig: z.string() });
const MintCodeBody = z.object({
  role: z.enum(["member", "observer"]).default("member"),
  ttlMs: z.number().int().positive().max(TIMINGS.codeTtlMsMax).default(TIMINGS.codeTtlMsDefault),
  maxUses: z.number().int().positive().optional(),
});

type Handler = (req: Request, env: Env, params: Record<string, string | undefined>) => Promise<Response>;

const routes: [method: string, pattern: URLPattern, handler: Handler][] = [
  ["GET", new URLPattern({ pathname: "/v1/health" }), health],
  ["POST", new URLPattern({ pathname: "/v1/auth/github" }), signInWithGitHub],
  ["POST", new URLPattern({ pathname: "/v1/auth/refresh" }), refreshAccount],
  ["POST", new URLPattern({ pathname: "/v1/auth/logout" }), logout],
  ["POST", new URLPattern({ pathname: "/v1/lobbies" }), createLobby],
  ["POST", new URLPattern({ pathname: "/v1/join" }), joinLobby],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/ws" }), upgrade],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/codes" }), mintCode],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/token" }), refreshToken],
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new ProtocolError("too_large");
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(req.url);
        if (match && req.method === method) return await handler(req, env, match.pathname.groups);
      }
      throw new ProtocolError("not_found");
    } catch (e) {
      return errorResponse(e);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Keep a one-minute grace period so a code never disappears mid-join (LLD 4.6).
    await env.DB.prepare("DELETE FROM lobby_codes WHERE expires_at < ?").bind(Date.now() - 60_000).run();
  },
} satisfies ExportedHandler<Env>;


async function health(_req: Request, env: Env): Promise<Response> {
  return Response.json({ ok: true, minClientVersion: env.MIN_CLIENT_VERSION });
}

/** Verifies a GitHub token once, records the user and this machine, and returns an account token (LLD 14.2). */
async function signInWithGitHub(req: Request, env: Env): Promise<Response> {
  const body = await parseBody(req, GitHubSignInBody);
  const github = await fetch(`${env.GITHUB_API_URL}/user`, {
    headers: { authorization: `Bearer ${body.githubToken}`, accept: "application/vnd.github+json", "user-agent": "agentlobbies-relay" },
  });
  if (!github.ok) throw new ProtocolError("unauthorized", "GitHub rejected the sign-in");
  const profile = (await github.json()) as { id: number; login: string; avatar_url: string };

  const user = await env.DB.prepare(
    `INSERT INTO users (user_id, github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url
     RETURNING user_id`,
  ).bind(ulid(), profile.id, profile.login, profile.avatar_url, Date.now()).first<{ user_id: string }>();
  const machineId = ulid();
  await env.DB.prepare("INSERT INTO machines (machine_id, user_id, public_key, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(machineId, user!.user_id, body.machinePublicKey, body.machineName, Date.now()).run();

  const token = await issueAccountJwt(env, { userId: user!.user_id, machineId });
  return Response.json({ token, machineId, user: { userId: user!.user_id, login: profile.login, avatarUrl: profile.avatar_url } });
}

async function refreshAccount(req: Request, env: Env): Promise<Response> {
  const { machineId, ts, sig } = await parseBody(req, AccountRefreshBody);
  if (Math.abs(Date.now() - ts) > TIMINGS.refreshSkewMs) throw new ProtocolError("unauthorized");
  const machine = await env.DB.prepare("SELECT user_id, public_key FROM machines WHERE machine_id = ? AND revoked_at IS NULL")
    .bind(machineId).first<{ user_id: string; public_key: string }>();
  const signed = refreshSigningBytes({ lobbyId: "account", agentId: machineId, ts });
  if (!machine || !(await verifyBytes(webCrypto, fromB64u(machine.public_key), signed, sig))) throw new ProtocolError("unauthorized");
  return Response.json({ token: await issueAccountJwt(env, { userId: machine.user_id, machineId }) });
}

async function logout(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  await env.DB.prepare("UPDATE machines SET revoked_at = ? WHERE machine_id = ?").bind(Date.now(), account.machineId).run();
  return Response.json({});
}

/** The signed-in owner of a request: a valid account token from a machine that hasn't logged out. */
async function requireAccount(req: Request, env: Env): Promise<Owner & { userId: string; machineId: string }> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const claims = token ? await verifyAccountJwt(env, token) : undefined;
  if (!claims) throw new ProtocolError("login_required", "sign in with `agentlobbies login` first");
  const user = await env.DB.prepare(
    `SELECT u.login, u.avatar_url FROM machines m JOIN users u ON u.user_id = m.user_id
     WHERE m.machine_id = ? AND m.user_id = ? AND m.revoked_at IS NULL`,
  ).bind(claims.machineId, claims.userId).first<{ login: string; avatar_url: string }>();
  if (!user) throw new ProtocolError("login_required", "sign in with `agentlobbies login` first");
  return { ...claims, login: user.login, avatarUrl: user.avatar_url };
}

async function createLobby(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.CREATE_LIMITER.limit({ key: ip })).success) throw new ProtocolError("rate_limited");

  // The rate limit binding only has 10 s and 60 s windows, so the hourly cap lives in D1 (G14).
  const ipHash = await hmacHex(env.IP_HASH_SALT, ip);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM lobbies WHERE creator_ip_hash = ? AND created_at > ?")
    .bind(ipHash, Date.now() - 3_600_000).first<{ n: number }>();
  const hourlyLimit = Number(env.CREATE_LOBBY_HOURLY_LIMIT ?? RATES.createLobbyPerIpPerHour);
  if ((recent?.n ?? 0) >= hourlyLimit) throw new ProtocolError("rate_limited");

  const owner = await requireAccount(req, env);
  const body = await parseBody(req, CreateLobbyBody);
  const id = env.LOBBY.newUniqueId();
  const lobbyId = id.toString();
  const agentId = ulid();
  const now = Date.now();

  // Register first as 'creating' so a failed init leaves a row the cron can clean up (G30).
  await env.DB.prepare("INSERT INTO lobbies (lobby_id, name, created_at, status, creator_ip_hash) VALUES (?, ?, ?, 'creating', ?)")
    .bind(lobbyId, body.settings?.name ?? null, now, ipHash).run();
  await env.LOBBY.get(id).init({ lobbyId, host: { ...body.host, agentId, owner: ownerOf(owner) }, settings: body.settings ?? {} });

  const code = await insertCode(env.DB, lobbyId, { role: "member", expiresAt: now + TIMINGS.codeTtlMsDefault });
  await env.DB.prepare("UPDATE lobbies SET status = 'open' WHERE lobby_id = ?").bind(lobbyId).run();

  const token = await issueJwt(env, { sub: agentId, lobby: lobbyId, role: "host" });
  return Response.json(
    { lobbyId, agentId, role: "host", code, codeExpiresAt: now + TIMINGS.codeTtlMsDefault, token, wsUrl: wsUrl(env, lobbyId) },
    { status: 201 },
  );
}

async function joinLobby(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.CODE_LIMITER.limit({ key: ip })).success) throw new ProtocolError("rate_limited");
  const owner = await requireAccount(req, env);
  const { code, agent } = await parseBody(req, JoinBody);

  // Atomic redeem: checks expiry and uses, and counts the use, in one statement.
  const row = await env.DB.prepare(
    `UPDATE lobby_codes SET uses = uses + 1
     WHERE code = ? AND expires_at > ? AND (max_uses IS NULL OR uses < max_uses)
     RETURNING lobby_id, role`,
  ).bind(code, Date.now()).first<{ lobby_id: string; role: "member" | "observer" }>();
  if (!row) throw new ProtocolError("invalid_code");

  const agentId = ulid();
  const result = await env.LOBBY.get(env.LOBBY.idFromString(row.lobby_id)).admit({ ...agent, agentId, owner: ownerOf(owner) }, row.role);
  if ("error" in result) throw new ProtocolError(result.error);

  const token = await issueJwt(env, { sub: agentId, lobby: row.lobby_id, role: row.role });
  return Response.json({
    lobbyId: row.lobby_id, agentId, role: row.role, handle: result.handle, token, wsUrl: wsUrl(env, row.lobby_id),
  });
}

async function refreshToken(req: Request, env: Env, params: Record<string, string | undefined>): Promise<Response> {
  const { agentId, ts, sig } = await parseBody(req, RefreshBody);
  if (Math.abs(Date.now() - ts) > TIMINGS.refreshSkewMs || !params.lobbyId) throw new ProtocolError("unauthorized");
  const result = await lobbyStub(env, params.lobbyId).verifySeat(agentId, ts, sig);
  if ("error" in result) throw new ProtocolError(result.error);
  const token = await issueJwt(env, { sub: agentId, lobby: params.lobbyId, role: result.role });
  return Response.json({ token });
}

async function mintCode(req: Request, env: Env, params: Record<string, string | undefined>): Promise<Response> {
  const claims = await requireToken(req, env, params.lobbyId);
  const body = await parseBody(req, MintCodeBody);
  const result = await lobbyStub(env, claims.lobby).mintCode(claims.sub, body);
  if ("error" in result) throw new ProtocolError(result.error);
  return Response.json(result, { status: 201 });
}

async function upgrade(req: Request, env: Env, params: Record<string, string | undefined>): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  const token = tokenFromSubprotocol(req);
  const claims = token ? await verifyJwt(env, token) : undefined;
  if (!claims || claims.lobby !== params.lobbyId) throw new ProtocolError("unauthorized");

  // The object trusts X-Agent-Id because only this Worker can reach it.
  const headers = new Headers(req.headers);
  headers.set("X-Agent-Id", claims.sub);
  headers.delete("Sec-WebSocket-Protocol");
  return lobbyStub(env, claims.lobby).fetch(new Request(req.url, { headers }));
}

async function requireToken(req: Request, env: Env, lobbyId: string | undefined): Promise<Claims> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const claims = token ? await verifyJwt(env, token) : undefined;
  if (!claims || claims.lobby !== lobbyId) throw new ProtocolError("unauthorized");
  return claims;
}

function lobbyStub(env: Env, lobbyId: string) {
  return env.LOBBY.get(env.LOBBY.idFromString(lobbyId));
}


async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) throw new ProtocolError("bad_request", parsed.error.issues[0]?.message ?? "invalid body");
  return parsed.data;
}

function ownerOf(account: Owner & { userId: string }) {
  return { userId: account.userId, login: account.login, avatarUrl: account.avatarUrl };
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function wsUrl(env: Env, lobbyId: string): string {
  return `${env.PUBLIC_URL.replace(/^http/, "ws")}/v1/lobbies/${lobbyId}/ws`;
}

function errorResponse(e: unknown): Response {
  if (e instanceof ProtocolError) {
    return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }
  console.error("internal error", e);
  const code: ErrorCode = "internal";
  return Response.json({ error: { code, message: "internal error" } }, { status: httpStatusOf(code) });
}
