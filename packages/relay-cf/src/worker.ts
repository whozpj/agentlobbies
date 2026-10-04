import {
  B64u, JoinProfile, LIMITS, ProtocolError, RATES, TIMINGS, fromB64u, httpStatusOf, refreshSigningBytes, toAreas, toB64u, toHandle, verifyBytes, webCrypto,
  type ErrorCode, type Owner, type Role,
} from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { z } from "zod";
import { issueAccountJwt, issueJwt, readCookie, tokenFromSubprotocol, verifyAccountJwt, verifyJwt, verifyWebJwt } from "./auth";
import { SESSION_COOKIE, finishWebSignIn, signOut, startWebSignIn, userFromGitHub } from "./github";

export { LobbyDurableObject } from "./lobby-do";
export { UserDurableObject } from "./user-do";

const MAX_BODY_BYTES = 160 * 1024;
/** The Worker builds every request it forwards to a Durable Object from scratch, at these internal URLs. */
const INTERNAL = "https://internal";

const CreateLobbyBody = z.object({ name: z.string().trim().min(1).max(64).optional() });
const PersonBody = z.object({ person: JoinProfile });
const AddAgentBody = z.union([
  z.object({ agent: JoinProfile }),
  z.object({ machineId: z.string(), seatKey: z.string(), owns: z.array(z.string()).max(16).default([]) }),
]);
const AcceptInviteBody = z.object({ token: z.string().min(20).max(64) });
const UpdateAgentBody = z.object({ handle: z.string().optional(), owns: z.array(z.string()).max(LIMITS.maxOwns).optional() });
const InviteBody = z.object({
  role: z.enum(["member", "viewer"]).default("member"),
  ttlMs: z.number().int().positive().max(30 * 24 * 60 * 60_000).default(7 * 24 * 60 * 60_000),
  maxUses: z.number().int().positive().optional(),
});
const RefreshBody = z.object({ agentId: z.string(), ts: z.number().int(), sig: z.string() });
const GitHubSignInBody = z.object({
  githubToken: z.string().min(1), machinePublicKey: z.string(), boxPublicKey: B64u.optional(), machineName: z.string().max(100),
});
const AccountRefreshBody = z.object({ machineId: z.string(), ts: z.number().int(), sig: z.string() });
const BoxKeyBody = z.object({ boxPublicKey: B64u });
const DeviceBody = z.object({ boxPublicKey: B64u, name: z.string().max(100) });

type MemberRole = "owner" | "member" | "viewer";

/** Per-account caps on top of the per-IP ones, so one account can't fill the relay. */
const ACCOUNT_LIMITS = { lobbiesPerDay: 50, invitesPerDay: 200, devicesPerDay: 20, devices: 50 };
const DAY_MS = 24 * 60 * 60_000;
type Params = Record<string, string | undefined>;
type Handler = (req: Request, env: Env, params: Params) => Promise<Response>;

/** Who is making a request: a signed-in machine (daemon) has a machine id; a browser has a session id. */
interface Account extends Owner {
  userId: string;
  machineId?: string;
  sessionId?: string;
}

const routes: [method: string, pattern: URLPattern, handler: Handler][] = [
  ["GET", new URLPattern({ pathname: "/v1/health" }), health],
  ["POST", new URLPattern({ pathname: "/v1/auth/github" }), signInWithGitHub],
  ["POST", new URLPattern({ pathname: "/v1/auth/refresh" }), refreshAccount],
  ["POST", new URLPattern({ pathname: "/v1/auth/logout" }), logout],
  ["POST", new URLPattern({ pathname: "/v1/auth/box-key" }), registerBoxKey],
  ["GET", new URLPattern({ pathname: "/auth/github/login" }), startWebSignIn],
  ["GET", new URLPattern({ pathname: "/auth/github/callback" }), finishWebSignIn],
  ["POST", new URLPattern({ pathname: "/auth/logout" }), webLogout],
  ["GET", new URLPattern({ pathname: "/v1/me" }), me],
  ["GET", new URLPattern({ pathname: "/v1/me/agents" }), myAgents],
  ["POST", new URLPattern({ pathname: "/v1/me/agents/secure" }), setAgentSecure],
  ["GET", new URLPattern({ pathname: "/v1/me/devices" }), listDevices],
  ["GET", new URLPattern({ pathname: "/v1/me/export" }), exportAccount],
  ["DELETE", new URLPattern({ pathname: "/v1/me" }), deleteAccount],
  ["POST", new URLPattern({ pathname: "/v1/me/devices" }), addBrowserDevice],
  ["DELETE", new URLPattern({ pathname: "/v1/me/devices/:machineId" }), removeDevice],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/keys" }), browserKeys],
  ["GET", new URLPattern({ pathname: "/v1/me/ws" }), machineSocket],
  ["GET", new URLPattern({ pathname: "/v1/me/live" }), browserSocket],
  ["GET", new URLPattern({ pathname: "/v1/lobbies" }), listLobbies],
  ["POST", new URLPattern({ pathname: "/v1/lobbies" }), createLobby],
  ["GET", new URLPattern({ pathname: "/v1/invites/:token" }), previewInvite],
  ["POST", new URLPattern({ pathname: "/v1/invites/accept" }), acceptInvite],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/invites" }), createInvite],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/people" }), addPerson],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/agents" }), addAgent],
  ["PATCH", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/agents/:agentId" }), updateAgent],
  ["DELETE", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/agents/:agentId" }), removeAgent],
  ["DELETE", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/members/:login" }), removeMember],
  ["DELETE", new URLPattern({ pathname: "/v1/lobbies/:lobbyId" }), deleteLobby],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/events" }), listEvents],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/ws" }), seatSocket],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/watch" }), watchSocket],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/token" }), refreshToken],
  ["POST", new URLPattern({ pathname: "/v1/admin/suspend" }), suspendAccount],
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      const isApi = url.pathname.startsWith("/v1/");
      // The old workers.dev address keeps its API for older installs; people go to the site itself.
      if (!isApi && url.hostname.endsWith(".workers.dev") && url.host !== new URL(env.PUBLIC_URL).host) {
        return Response.redirect(`${env.PUBLIC_URL}${url.pathname}${url.search}`, 301);
      }
      if (!isApi && !url.pathname.startsWith("/auth/")) return await env.ASSETS.fetch(req);
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
    await env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(Date.now()).run();
  },
} satisfies ExportedHandler<Env>;


async function health(_req: Request, env: Env): Promise<Response> {
  await env.DB.prepare("SELECT 1").first();
  return Response.json({ ok: true, minClientVersion: env.MIN_CLIENT_VERSION });
}

/** A machine signs in with a GitHub token from the device flow and gets an account token (LLD 14.2). */
async function signInWithGitHub(req: Request, env: Env): Promise<Response> {
  const body = await parseBody(req, GitHubSignInBody);
  if (body.boxPublicKey !== undefined) await requireBoxKey(body.boxPublicKey);
  const user = await userFromGitHub(env, body.githubToken);
  await limitDevices(env, user.userId);
  const machineId = ulid();
  await env.DB.prepare("INSERT INTO machines (machine_id, user_id, public_key, box_public_key, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(machineId, user.userId, body.machinePublicKey, body.boxPublicKey ?? null, body.machineName, Date.now()).run();
  await forEachLobbyOf(env, user.userId, (lobby) => lobby.refreshKeys());

  const token = await issueAccountJwt(env, { userId: user.userId, machineId });
  return Response.json({ token, machineId, user });
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

/** A machine signs out: it can't refresh any more, its agents leave its lobbies, and they make new keys without it. */
async function logout(req: Request, env: Env): Promise<Response> {
  const account = await requireMachine(req, env);
  await revokeDevice(env, account.userId, account.machineId);
  return Response.json({});
}

/** Machines that signed in before v0.4 register their encryption key here (LLD 15.2). */
async function registerBoxKey(req: Request, env: Env): Promise<Response> {
  const account = await requireMachine(req, env);
  const { boxPublicKey } = await parseBody(req, BoxKeyBody);
  await requireBoxKey(boxPublicKey);
  await env.DB.prepare("UPDATE machines SET box_public_key = ? WHERE machine_id = ?").bind(boxPublicKey, account.machineId).run();
  await forEachLobbyOf(env, account.userId, (lobby) => lobby.refreshKeys());
  return Response.json({});
}

/**
 * A browser registers its own encryption key as one of the user's devices, so member machines seal
 * lobby keys to it and it can read messages (LLD 15.11). A browser has no signing key: it never sends
 * as an agent and never refreshes an account token.
 */
async function addBrowserDevice(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  if (!account.sessionId) throw new ProtocolError("forbidden", "only a browser registers this way");
  await limitDevices(env, account.userId);
  const { boxPublicKey, name } = await parseBody(req, DeviceBody);
  await requireBoxKey(boxPublicKey);
  const machineId = ulid();
  await env.DB.prepare(
    "INSERT INTO machines (machine_id, user_id, public_key, box_public_key, name, created_at, session_id) VALUES (?, ?, '', ?, ?, ?, ?)",
  ).bind(machineId, account.userId, boxPublicKey, name, Date.now(), account.sessionId).run();
  await forEachLobbyOf(env, account.userId, (lobby) => lobby.refreshKeys());
  return Response.json({ machineId }, { status: 201 });
}

/** Every machine and browser the user is signed in on: the devices that receive their lobby keys. */
async function listDevices(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  const { results } = await env.DB.prepare(
    "SELECT machine_id, name, public_key, created_at, session_id FROM machines WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
  ).bind(account.userId).all<{ machine_id: string; name: string; public_key: string; created_at: number; session_id: string | null }>();
  return Response.json(results.map((d) => ({
    deviceId: d.machine_id,
    name: d.name,
    kind: d.public_key === "" ? "browser" : "machine", // a browser has no signing key
    createdAt: d.created_at,
    current: d.machine_id === account.machineId || (d.session_id !== null && d.session_id === account.sessionId),
  })));
}

/**
 * Revokes one of the user's devices (a lost laptop, an old browser, or signing out of one): it can't
 * sign in or receive keys any more, and its lobbies make new keys without it.
 */
async function removeDevice(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  const device = await env.DB.prepare("SELECT session_id FROM machines WHERE machine_id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(params.machineId, account.userId).first<{ session_id: string | null }>();
  if (!device) return Response.json({});
  // A browser's sign-in ends with its device, so it can't simply register a new one.
  if (device.session_id) await endWebSession(env, account.userId, device.session_id);
  else await revokeDevice(env, account.userId, params.machineId!);
  return Response.json({});
}

/**
 * Revokes a machine or browser device: it can't sign in or receive keys any more, its agents leave
 * every lobby (enforced here, so a stolen device can't ignore it), and the lobbies make new keys.
 */
async function revokeDevice(env: Env, userId: string, machineId: string): Promise<void> {
  await env.DB.prepare("UPDATE machines SET revoked_at = ? WHERE machine_id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), machineId, userId).run();
  await userStub(env, userId).revokeMachine(machineId);
  await forEachLobbyOf(env, userId, (lobby) => lobby.removeMachine(machineId));
}

/** Ends a browser sign-in: the cookie stops working, its devices are revoked, and its open tabs are disconnected. */
async function endWebSession(env: Env, userId: string, sessionId: string): Promise<void> {
  await env.DB.prepare("UPDATE web_sessions SET revoked_at = ? WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), sessionId, userId).run();
  const { results: devices } = await env.DB.prepare("SELECT machine_id FROM machines WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(sessionId, userId).all<{ machine_id: string }>();
  for (const device of devices) await revokeDevice(env, userId, device.machine_id);
  await userStub(env, userId).closeSession(sessionId);
  await forEachLobbyOf(env, userId, (lobby) => lobby.closeSession(sessionId));
}

/** The lobby keys sealed to one of the caller's own devices. */
async function browserKeys(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  if (!(await membership(env, params.lobbyId, account.userId))) throw new ProtocolError("forbidden");
  const machineId = new URL(req.url).searchParams.get("device") ?? "";
  const device = await env.DB.prepare("SELECT 1 AS ok FROM machines WHERE machine_id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(machineId, account.userId).first<{ ok: number }>();
  if (!device) throw new ProtocolError("forbidden", "that isn't one of your devices");
  return Response.json(await lobbyStub(env, params.lobbyId!).sealedKeysFor(machineId));
}

async function webLogout(req: Request, env: Env): Promise<Response> {
  requireSameOrigin(req, env);
  const session = await webSession(req, env);
  if (session) await endWebSession(env, session.userId, session.sessionId);
  return signOut();
}

async function me(req: Request, env: Env): Promise<Response> {
  const { userId, login, avatarUrl } = await requireAccount(req, env);
  return Response.json({ userId, login, avatarUrl });
}

async function myAgents(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  return Response.json(await userStub(env, account.userId).machines());
}

/** Turns secure mode on or off for one of the user's agents; the agent's machine keeps the setting. */
async function setAgentSecure(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  const body = await parseBody(req, z.object({ machineId: z.string(), seatKey: z.string(), secure: z.boolean() }));
  const call = await userStub(env, account.userId).call(body.machineId, "agent.setSecure", { seatKey: body.seatKey, secure: body.secure });
  if (call.error) return Response.json({ error: call.error }, { status: call.error.code === "machine_offline" ? 409 : 400 });
  return Response.json({});
}

/** A daemon's connection to its user object, so the hosted dashboard can reach it (LLD 15.6). */
async function machineSocket(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  const token = tokenFromSubprotocol(req, "account");
  const account = token ? await accountFromToken(env, token) : undefined;
  if (!account?.machineId) throw new ProtocolError("login_required");
  const machine = await env.DB.prepare("SELECT name FROM machines WHERE machine_id = ?").bind(account.machineId).first<{ name: string }>();

  const headers = { Upgrade: "websocket", "X-Machine-Id": account.machineId, "X-Machine-Name": machine?.name ?? "unknown" };
  const res = await userStub(env, account.userId).fetch(new Request(`${INTERNAL}/machine`, { headers }));
  return new Response(null, { status: 101, webSocket: res.webSocket, headers: { "Sec-WebSocket-Protocol": "agentlobbies.v1" } });
}

/** A browser tab's live view of the user's machines and agents. */
async function browserSocket(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  requireSameOrigin(req, env);
  const account = await requireAccount(req, env);
  if (!account.sessionId) throw new ProtocolError("forbidden");
  const headers = { Upgrade: "websocket", "X-Session-Id": account.sessionId };
  return userStub(env, account.userId).fetch(new Request(`${INTERNAL}/web`, { headers }));
}

/** The caller's lobbies, each with its people (members exist whether or not they have a machine or agent there). */
async function listLobbies(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  const lobbies = await lobbiesOf(env, account.userId);
  const result = await Promise.all(lobbies.map(async (l) => ({
    lobbyId: l.lobby_id, name: l.name, role: l.role, people: await peopleOf(env, l.lobby_id), ...(await lobbyStub(env, l.lobby_id).summary()),
  })));
  return Response.json(result);
}

async function peopleOf(env: Env, lobbyId: string): Promise<{ login: string; avatarUrl: string; role: MemberRole }[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.login, u.avatar_url AS avatarUrl, lm.role FROM lobby_members lm JOIN users u ON u.user_id = lm.user_id
     WHERE lm.lobby_id = ? ORDER BY lm.added_at`,
  ).bind(lobbyId).all<{ login: string; avatarUrl: string; role: MemberRole }>();
  return results;
}

/** Tells every member's machines and tabs that the lobby's people changed. */
async function notifyMembers(env: Env, lobbyId: string, alsoUserId?: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT user_id FROM lobby_members WHERE lobby_id = ?").bind(lobbyId).all<{ user_id: string }>();
  const userIds = new Set(results.map((r) => r.user_id));
  if (alsoUserId) userIds.add(alsoUserId);
  for (const userId of userIds) await userStub(env, userId).notify({ t: "lobbies" });
}

/** Creates an empty lobby owned by the caller. Their machines add their person seat when they sync (LLD 15.6). */
async function createLobby(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.CREATE_LIMITER.limit({ key: ip })).success) throw new ProtocolError("rate_limited");

  // The rate limit binding only has 10 s and 60 s windows, so the hourly cap lives in D1 (G14).
  const ipHash = await hmacHex(env.IP_HASH_SALT, ip);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM lobbies WHERE creator_ip_hash = ? AND created_at > ?")
    .bind(ipHash, Date.now() - 3_600_000).first<{ n: number }>();
  const hourlyLimit = Number(env.CREATE_LOBBY_HOURLY_LIMIT ?? RATES.createLobbyPerIpPerHour);
  if ((recent?.n ?? 0) >= hourlyLimit) throw new ProtocolError("rate_limited");

  const account = await requireAccount(req, env);
  await limitPerDay(env, "SELECT COUNT(*) AS n FROM lobby_members WHERE user_id = ? AND role = 'owner' AND added_at > ?", account.userId,
    ACCOUNT_LIMITS.lobbiesPerDay, "lobbies");
  const { name } = await parseBody(req, CreateLobbyBody);
  const id = env.LOBBY.newUniqueId();
  const lobbyId = id.toString();
  const now = Date.now();

  // Register first as 'creating' so a failed init leaves a row the cron can clean up (G30).
  await env.DB.prepare("INSERT INTO lobbies (lobby_id, name, created_at, status, creator_ip_hash) VALUES (?, ?, ?, 'creating', ?)")
    .bind(lobbyId, name ?? null, now, ipHash).run();
  await env.LOBBY.get(id).init({ lobbyId, settings: name ? { name } : {} });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO lobby_members (lobby_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)").bind(lobbyId, account.userId, now),
    env.DB.prepare("UPDATE lobbies SET status = 'open' WHERE lobby_id = ?").bind(lobbyId),
  ]);
  await userStub(env, account.userId).notify({ t: "lobbies" });
  return Response.json({ lobbyId, name: name ?? null }, { status: 201 });
}

/** A machine adds its user's person seat to a lobby they belong to. */
async function addPerson(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireMachine(req, env);
  const role = await membership(env, params.lobbyId, account.userId);
  if (!role) throw new ProtocolError("forbidden", "you aren't a member of that lobby");
  const { person } = await parseBody(req, PersonBody);
  const seatRole: Record<MemberRole, Role> = { owner: "host", member: "member", viewer: "observer" };
  const lobby = await env.DB.prepare("SELECT name FROM lobbies WHERE lobby_id = ?").bind(params.lobbyId).first<{ name: string | null }>();
  return admitToLobby(env, params.lobbyId!, person, account, seatRole[role], 201, { name: lobby?.name ?? null });
}

async function refreshToken(req: Request, env: Env, params: Params): Promise<Response> {
  const { agentId, ts, sig } = await parseBody(req, RefreshBody);
  if (Math.abs(Date.now() - ts) > TIMINGS.refreshSkewMs || !params.lobbyId) throw new ProtocolError("unauthorized");
  const result = await lobbyStub(env, params.lobbyId).verifySeat(agentId, ts, sig);
  if ("error" in result) throw new ProtocolError(result.error);
  if (result.machineId) {
    const machine = await env.DB.prepare("SELECT 1 AS ok FROM machines WHERE machine_id = ? AND revoked_at IS NULL")
      .bind(result.machineId).first<{ ok: number }>();
    if (!machine) throw new ProtocolError("unauthorized", "this agent's device was signed out");
  }
  const token = await issueJwt(env, { sub: agentId, lobby: params.lobbyId, role: result.role });
  return Response.json({ token });
}

/** The lobby owner makes a link that lets whoever opens it (after signing in) become a member or viewer. */
async function createInvite(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  if ((await membership(env, params.lobbyId, account.userId)) !== "owner") throw new ProtocolError("forbidden", "only the lobby owner can invite");
  await limitPerDay(env, "SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND created_at > ?", account.userId,
    ACCOUNT_LIMITS.invitesPerDay, "invites");
  const body = await parseBody(req, InviteBody);
  const token = toB64u(crypto.getRandomValues(new Uint8Array(24)));
  const expiresAt = Date.now() + body.ttlMs;
  await env.DB.prepare("INSERT INTO invites (token_hash, lobby_id, role, created_by, expires_at, max_uses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), params.lobbyId, body.role, account.userId, expiresAt, body.maxUses ?? null, Date.now()).run();
  return Response.json({ token, url: `${env.PUBLIC_URL}/invite/${token}`, expiresAt, role: body.role }, { status: 201 });
}

/** What an invite page shows before someone accepts. */
async function previewInvite(req: Request, env: Env, params: Params): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.INVITE_LIMITER.limit({ key: ip })).success) throw new ProtocolError("rate_limited");
  const invite = await env.DB.prepare(
    `SELECT i.role, l.name, u.login FROM invites i JOIN lobbies l ON l.lobby_id = i.lobby_id JOIN users u ON u.user_id = i.created_by
     WHERE i.token_hash = ? AND i.expires_at > ? AND (i.max_uses IS NULL OR i.uses < i.max_uses)`,
  ).bind(await sha256Hex(params.token ?? ""), Date.now()).first<{ role: string; name: string | null; login: string }>();
  if (!invite) throw new ProtocolError("invalid_invite", "that invite is invalid, expired, or used up");
  return Response.json({ lobbyName: invite.name, role: invite.role, invitedBy: invite.login });
}

async function acceptInvite(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.INVITE_LIMITER.limit({ key: ip })).success) throw new ProtocolError("rate_limited");
  const account = await requireAccount(req, env);
  const { token } = await parseBody(req, AcceptInviteBody);

  const invite = await env.DB.prepare(
    `UPDATE invites SET uses = uses + 1
     WHERE token_hash = ? AND expires_at > ? AND (max_uses IS NULL OR uses < max_uses)
     RETURNING lobby_id, role`,
  ).bind(await sha256Hex(token), Date.now()).first<{ lobby_id: string; role: "member" | "viewer" }>();
  if (!invite) throw new ProtocolError("invalid_invite", "that invite is invalid, expired, or used up");

  await env.DB.prepare("INSERT OR IGNORE INTO lobby_members (lobby_id, user_id, role, added_at) VALUES (?, ?, ?, ?)")
    .bind(invite.lobby_id, account.userId, invite.role, Date.now()).run();
  await lobbyStub(env, invite.lobby_id).refreshKeys();
  await notifyMembers(env, invite.lobby_id);
  const lobby = await env.DB.prepare("SELECT name FROM lobbies WHERE lobby_id = ?").bind(invite.lobby_id).first<{ name: string | null }>();
  return Response.json({ lobbyId: invite.lobby_id, name: lobby?.name ?? null, role: invite.role });
}

/**
 * A member places one of their own agents into the lobby (LLD 14.5). A daemon sends the agent's profile;
 * the hosted dashboard names a machine and agent, and that machine's daemon does the rest (LLD 15.6).
 */
async function addAgent(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  const role = await membership(env, params.lobbyId, account.userId);
  if (role !== "owner" && role !== "member") throw new ProtocolError("forbidden", "only lobby members can add agents");
  const body = await parseBody(req, AddAgentBody);

  if ("agent" in body) {
    if (!account.machineId) throw new ProtocolError("forbidden");
    return admitToLobby(env, params.lobbyId!, body.agent, account, "member", 201);
  }
  const call = await userStub(env, account.userId).call(body.machineId, "lobby.addAgent", { lobbyId: params.lobbyId, seatKey: body.seatKey, owns: body.owns });
  if (call.error) {
    const status = call.error.code === "machine_offline" ? 409 : 400;
    return Response.json({ error: call.error }, { status });
  }
  return Response.json(call.result, { status: 201 });
}

/** Renames an agent or changes what it owns; the agent hears about it through the roster (LLD 15.6). */
async function updateAgent(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  const role = await membership(env, params.lobbyId, account.userId);
  if (!role) throw new ProtocolError("forbidden");
  const body = await parseBody(req, UpdateAgentBody);

  // Names and areas are accepted as people type them ("Mobile App") and stored as handles and topics.
  const changes: { handle?: string; owns?: string[] } = {};
  if (body.handle !== undefined) changes.handle = toHandle(body.handle);
  if (body.owns !== undefined) changes.owns = toAreas(body.owns);

  const actor = { userId: account.userId, isLobbyOwner: role === "owner" };
  const result = await lobbyStub(env, params.lobbyId!).updateAgent(params.agentId ?? "", changes, actor);
  if ("error" in result) throw new ProtocolError(result.error);
  return Response.json(result.profile);
}

async function removeAgent(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  const role = await membership(env, params.lobbyId, account.userId);
  if (!role) throw new ProtocolError("forbidden");
  const result = await lobbyStub(env, params.lobbyId!).removeAgent(params.agentId ?? "", { userId: account.userId, isLobbyOwner: role === "owner" });
  if ("error" in result) throw new ProtocolError(result.error);
  return Response.json({});
}

/** The owner removes a member, or a member leaves. Their agents go and the lobby key rotates (LLD 15.4). */
async function removeMember(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  const callerRole = await membership(env, params.lobbyId, account.userId);
  if (!callerRole) throw new ProtocolError("forbidden");
  const target = await env.DB.prepare(
    `SELECT u.user_id FROM lobby_members lm JOIN users u ON u.user_id = lm.user_id
     WHERE lm.lobby_id = ? AND u.login = ? COLLATE NOCASE`,
  ).bind(params.lobbyId, params.login ?? "").first<{ user_id: string }>();
  if (!target) throw new ProtocolError("not_found", "they aren't a member");

  const leaving = target.user_id === account.userId;
  if (leaving && callerRole === "owner") throw new ProtocolError("forbidden", "the owner can't leave their own lobby");
  if (!leaving && callerRole !== "owner") throw new ProtocolError("forbidden", "only the lobby owner can remove people");

  await env.DB.prepare("DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?").bind(params.lobbyId, target.user_id).run();
  await lobbyStub(env, params.lobbyId!).removeUser(target.user_id);
  await notifyMembers(env, params.lobbyId!, target.user_id);
  return Response.json({});
}

/**
 * The owner deletes a lobby for everyone: its messages and keys are erased, and members' machines
 * drop it when their connections close. The lobby row stays, marked closed, so its id is never reused.
 */
async function deleteLobby(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  if ((await membership(env, params.lobbyId, account.userId)) !== "owner") throw new ProtocolError("forbidden", "only the lobby owner can delete it");

  await closeLobby(env, params.lobbyId!);
  return Response.json({});
}

/** Closes a lobby for everyone, erases what it stored, and tells its members' machines. */
async function closeLobby(env: Env, lobbyId: string): Promise<void> {
  const { results: members } = await env.DB.prepare("SELECT user_id FROM lobby_members WHERE lobby_id = ?").bind(lobbyId).all<{ user_id: string }>();
  await env.DB.batch([
    env.DB.prepare("UPDATE lobbies SET status = 'closed' WHERE lobby_id = ?").bind(lobbyId),
    env.DB.prepare("DELETE FROM lobby_members WHERE lobby_id = ?").bind(lobbyId),
    env.DB.prepare("DELETE FROM invites WHERE lobby_id = ?").bind(lobbyId),
  ]);
  await lobbyStub(env, lobbyId).deleteLobby();
  for (const member of members) await userStub(env, member.user_id).notify({ t: "lobbies" });
}

/** Everything the relay keeps about the caller. Message content isn't here: the relay only has it encrypted. */
async function exportAccount(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  const user = await env.DB.prepare("SELECT user_id, github_id, login, avatar_url, created_at FROM users WHERE user_id = ?").bind(account.userId).first();
  const devices = await env.DB.prepare("SELECT machine_id, name, created_at, revoked_at FROM machines WHERE user_id = ?").bind(account.userId).all();
  const lobbies = await env.DB.prepare(
    `SELECT lm.lobby_id, l.name, lm.role, lm.added_at FROM lobby_members lm JOIN lobbies l ON l.lobby_id = lm.lobby_id WHERE lm.user_id = ?`,
  ).bind(account.userId).all();
  const invites = await env.DB.prepare("SELECT lobby_id, role, expires_at, max_uses, uses FROM invites WHERE created_by = ?").bind(account.userId).all();
  return Response.json(
    { exportedAt: Date.now(), user, devices: devices.results, lobbies: lobbies.results, invitesCreated: invites.results },
    { headers: { "content-disposition": 'attachment; filename="agentlobbies-account.json"' } },
  );
}

/**
 * Deletes the caller's account: lobbies they own are deleted for everyone, they leave the rest (those
 * lobbies get new keys), and their devices, invites, and account are erased.
 */
async function deleteAccount(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  for (const lobby of await lobbiesOf(env, account.userId)) {
    if (lobby.role === "owner") {
      await closeLobby(env, lobby.lobby_id);
    } else {
      await env.DB.prepare("DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?").bind(lobby.lobby_id, account.userId).run();
      await lobbyStub(env, lobby.lobby_id).removeUser(account.userId);
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM lobby_members WHERE user_id = ?").bind(account.userId),
    env.DB.prepare("DELETE FROM invites WHERE created_by = ?").bind(account.userId),
    env.DB.prepare("DELETE FROM web_sessions WHERE user_id = ?").bind(account.userId),
    env.DB.prepare("DELETE FROM machines WHERE user_id = ?").bind(account.userId),
    env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(account.userId),
  ]);
  await userStub(env, account.userId).forget();
  return signOut();
}

/**
 * The operator suspends an account for abuse (the terms allow it): lobbies it owns close for everyone,
 * it leaves the rest, its devices and browser sign-ins end, and it can't sign in again. Nothing is erased.
 */
async function suspendAccount(req: Request, env: Env): Promise<Response> {
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.ADMIN_TOKEN || !(await sameSecret(given, env.ADMIN_TOKEN))) throw new ProtocolError("not_found");
  const { login } = await parseBody(req, z.object({ login: z.string().min(1) }));
  const user = await env.DB.prepare("SELECT user_id FROM users WHERE login = ? COLLATE NOCASE").bind(login).first<{ user_id: string }>();
  if (!user) throw new ProtocolError("not_found", "no such user");

  await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE user_id = ?").bind(Date.now(), user.user_id).run();
  for (const lobby of await lobbiesOf(env, user.user_id)) {
    if (lobby.role === "owner") {
      await closeLobby(env, lobby.lobby_id);
    } else {
      await env.DB.prepare("DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?").bind(lobby.lobby_id, user.user_id).run();
      await lobbyStub(env, lobby.lobby_id).removeUser(user.user_id);
    }
  }
  const { results: sessions } = await env.DB.prepare("SELECT session_id FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL")
    .bind(user.user_id).all<{ session_id: string }>();
  for (const s of sessions) await endWebSession(env, user.user_id, s.session_id);
  const { results: devices } = await env.DB.prepare("SELECT machine_id FROM machines WHERE user_id = ? AND revoked_at IS NULL")
    .bind(user.user_id).all<{ machine_id: string }>();
  for (const d of devices) await revokeDevice(env, user.user_id, d.machine_id);
  await env.DB.prepare("DELETE FROM invites WHERE created_by = ?").bind(user.user_id).run();
  return Response.json({ suspended: login });
}

/** Compares secrets without leaking how much of them matched through timing. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Who said what to whom and when, without the content (LLD 15.6). */
async function listEvents(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  const role = await membership(env, params.lobbyId, account.userId);
  if (!role) throw new ProtocolError("forbidden");
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 200) || 200, 500);
  return Response.json(await lobbyStub(env, params.lobbyId!).messageMeta({ userId: account.userId, isOwner: role === "owner" }, limit));
}

/** An agent's socket. An account token alongside the seat token identifies the machine, for keys (LLD 15.3). */
async function seatSocket(req: Request, env: Env, params: Params): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  const token = tokenFromSubprotocol(req);
  const claims = token ? await verifyJwt(env, token) : undefined;
  if (!claims || claims.lobby !== params.lobbyId) throw new ProtocolError("unauthorized");

  const headers = new Headers({ Upgrade: "websocket", "X-Agent-Id": claims.sub });
  const accountToken = tokenFromSubprotocol(req, "account");
  const machine = accountToken ? await accountFromToken(env, accountToken) : undefined;
  if (machine?.machineId) {
    headers.set("X-Machine-Id", machine.machineId);
    headers.set("X-User-Id", machine.userId);
  }
  return lobbyStub(env, claims.lobby).fetch(new Request(`${INTERNAL}/agent`, { headers }));
}

/** The hosted dashboard watching a lobby live: roster and message metadata only. */
async function watchSocket(req: Request, env: Env, params: Params): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  requireSameOrigin(req, env);
  const account = await requireAccount(req, env);
  const role = await membership(env, params.lobbyId, account.userId);
  if (!role || !account.sessionId) throw new ProtocolError("forbidden");
  const headers = { Upgrade: "websocket", "X-Watch-User": account.userId, "X-Watch-Owner": role === "owner" ? "1" : "0", "X-Session-Id": account.sessionId };
  return lobbyStub(env, params.lobbyId!).fetch(new Request(`${INTERNAL}/watch`, { headers }));
}


/** The signed-in caller: a daemon's Bearer account token, or a browser's session cookie (LLD 15.6). */
async function requireAccount(req: Request, env: Env): Promise<Account> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (bearer) {
    const account = await accountFromToken(env, bearer);
    if (account) return account;
    throw new ProtocolError("login_required", "sign in with `agentlobbies login` first");
  }

  const session = await webSession(req, env);
  if (session) {
    // A cookie is sent by the browser on its own, so changes must come from this site's pages.
    if (req.method !== "GET") requireSameOrigin(req, env);
    return { userId: session.userId, sessionId: session.sessionId, login: session.login, avatarUrl: session.avatarUrl };
  }
  throw new ProtocolError("login_required", "sign in first");
}

/** The browser's sign-in from its session cookie, if it's valid and hasn't been ended. */
async function webSession(req: Request, env: Env): Promise<{ userId: string; sessionId: string; login: string; avatarUrl: string } | undefined> {
  const cookie = readCookie(req, SESSION_COOKIE);
  const claims = cookie ? await verifyWebJwt(env, cookie) : undefined;
  if (!claims) return undefined;
  const user = await env.DB.prepare(
    `SELECT u.login, u.avatar_url FROM web_sessions s JOIN users u ON u.user_id = s.user_id
     WHERE s.session_id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND u.suspended_at IS NULL`,
  ).bind(claims.sessionId, claims.userId).first<{ login: string; avatar_url: string }>();
  if (!user) return undefined;
  return { ...claims, login: user.login, avatarUrl: user.avatar_url };
}

/** Routes only the agentlobbies app on a machine may call. */
async function requireMachine(req: Request, env: Env): Promise<Account & { machineId: string }> {
  const account = await requireAccount(req, env);
  if (!account.machineId) throw new ProtocolError("forbidden", "this needs the agentlobbies app on your machine");
  return { ...account, machineId: account.machineId };
}

/** A valid account token from a machine that hasn't signed out. */
async function accountFromToken(env: Env, token: string): Promise<Account | undefined> {
  const claims = await verifyAccountJwt(env, token);
  if (!claims) return undefined;
  const user = await env.DB.prepare(
    `SELECT u.login, u.avatar_url FROM machines m JOIN users u ON u.user_id = m.user_id
     WHERE m.machine_id = ? AND m.user_id = ? AND m.revoked_at IS NULL AND u.suspended_at IS NULL`,
  ).bind(claims.machineId, claims.userId).first<{ login: string; avatar_url: string }>();
  if (!user) return undefined;
  return { ...claims, login: user.login, avatarUrl: user.avatar_url };
}

function requireSameOrigin(req: Request, env: Env): void {
  if (req.headers.get("origin") !== new URL(env.PUBLIC_URL).origin) throw new ProtocolError("forbidden", "cross-site request");
}

/** New devices a day, and devices in total, so one account can't fill a lobby's key list. */
async function limitDevices(env: Env, userId: string): Promise<void> {
  await limitPerDay(env, "SELECT COUNT(*) AS n FROM machines WHERE user_id = ? AND created_at > ?", userId, ACCOUNT_LIMITS.devicesPerDay, "new devices");
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM machines WHERE user_id = ? AND revoked_at IS NULL").bind(userId).first<{ n: number }>();
  if ((active?.n ?? 0) >= ACCOUNT_LIMITS.devices) {
    throw new ProtocolError("rate_limited", `you have ${ACCOUNT_LIMITS.devices} devices signed in; revoke one from the Account page first`);
  }
}

/** Throws unless `value` is an X25519 public key a lobby key can safely be sealed to (32 bytes, not a weak point). */
async function requireBoxKey(value: string): Promise<void> {
  try {
    const raw = fromB64u(value);
    if (raw.length !== 32) throw new Error("wrong length");
    const peer = await crypto.subtle.importKey("raw", raw, { name: "X25519" }, false, []);
    const probe = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    // The Workers types spell the `public` member `$public`; the runtime wants `public`, as in the spec.
    const algorithm = { name: "X25519", public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm;
    await crypto.subtle.deriveBits(algorithm, probe.privateKey, 256); // fails for weak points
  } catch {
    throw new ProtocolError("bad_request", "that isn't a valid encryption key");
  }
}

/** Throws rate_limited if `query` (bound to the user and a time 24 hours ago) counts `limit` or more. */
async function limitPerDay(env: Env, query: string, userId: string, limit: number, what: string): Promise<void> {
  const row = await env.DB.prepare(query).bind(userId, Date.now() - DAY_MS).first<{ n: number }>();
  if ((row?.n ?? 0) >= limit) throw new ProtocolError("rate_limited", `too many ${what} today (${limit} a day); try again tomorrow`);
}

/** Lobby membership of a user, or undefined if they aren't a member. */
async function membership(env: Env, lobbyId: string | undefined, userId: string): Promise<MemberRole | undefined> {
  if (!lobbyId) return undefined;
  const row = await env.DB.prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?").bind(lobbyId, userId)
    .first<{ role: MemberRole }>();
  return row?.role;
}

async function lobbiesOf(env: Env, userId: string): Promise<{ lobby_id: string; name: string | null; role: MemberRole }[]> {
  const { results } = await env.DB.prepare(
    `SELECT lm.lobby_id, l.name, lm.role FROM lobby_members lm JOIN lobbies l ON l.lobby_id = lm.lobby_id
     WHERE lm.user_id = ? AND l.status = 'open' ORDER BY lm.added_at`,
  ).bind(userId).all<{ lobby_id: string; name: string | null; role: MemberRole }>();
  return results;
}

async function forEachLobbyOf(env: Env, userId: string, fn: (lobby: ReturnType<typeof lobbyStub>) => Promise<void>): Promise<void> {
  for (const lobby of await lobbiesOf(env, userId)) await fn(lobbyStub(env, lobby.lobby_id));
}

async function admitToLobby(
  env: Env, lobbyId: string, profile: z.infer<typeof JoinProfile>, account: Account, role: Role,
  status = 200, extra: Record<string, unknown> = {},
): Promise<Response> {
  const agentId = ulid();
  const owner = { userId: account.userId, login: account.login, avatarUrl: account.avatarUrl };
  const result = await lobbyStub(env, lobbyId).admit({ ...profile, agentId, owner, machineId: account.machineId }, role);
  if ("error" in result) throw new ProtocolError(result.error);
  const token = await issueJwt(env, { sub: agentId, lobby: lobbyId, role });
  return Response.json({ lobbyId, agentId, role, handle: result.handle, token, wsUrl: wsUrl(env, lobbyId), ...extra }, { status });
}

function lobbyStub(env: Env, lobbyId: string) {
  return env.LOBBY.get(env.LOBBY.idFromString(lobbyId));
}

function userStub(env: Env, userId: string) {
  return env.USER.get(env.USER.idFromName(userId));
}

async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = JSON.parse(await readBody(req));
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    json = undefined; // not JSON; the schema reports it
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ProtocolError("bad_request", parsed.error.issues[0]?.message ?? "invalid body");
  return parsed.data;
}

/** Reads the body, counting bytes as they arrive: Content-Length is optional, so it can't be trusted for the limit. */
async function readBody(req: Request): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ProtocolError("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
