import {
  B64u, JoinProfile, ProtocolError, RATES, TIMINGS, fromB64u, httpStatusOf, refreshSigningBytes, toB64u, verifyBytes, webCrypto,
  type ErrorCode, type Owner, type Role,
} from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { z } from "zod";
import { issueAccountJwt, issueJwt, readCookie, tokenFromSubprotocol, verifyAccountJwt, verifyJwt, verifyWebJwt } from "./auth";
import { SESSION_COOKIE, finishWebSignIn, signOut, startWebSignIn, userFromGitHub } from "./github";

export { LobbyDurableObject } from "./lobby-do";
export { UserDurableObject } from "./user-do";

const MAX_BODY_BYTES = 160 * 1024;

const CreateLobbyBody = z.object({ name: z.string().trim().min(1).max(64).optional() });
const PersonBody = z.object({ person: JoinProfile });
const AddAgentBody = z.union([
  z.object({ agent: JoinProfile }),
  z.object({ machineId: z.string(), seatKey: z.string(), owns: z.array(z.string()).max(16).default([]) }),
]);
const AcceptInviteBody = z.object({ token: z.string().min(20).max(64) });
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

type MemberRole = "owner" | "member" | "viewer";
type Params = Record<string, string | undefined>;
type Handler = (req: Request, env: Env, params: Params) => Promise<Response>;

/** Who is making a request: a signed-in machine (daemon) has a machine id; a browser session doesn't. */
interface Account extends Owner {
  userId: string;
  machineId?: string;
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
  ["GET", new URLPattern({ pathname: "/v1/me/ws" }), machineSocket],
  ["GET", new URLPattern({ pathname: "/v1/me/live" }), browserSocket],
  ["GET", new URLPattern({ pathname: "/v1/lobbies" }), listLobbies],
  ["POST", new URLPattern({ pathname: "/v1/lobbies" }), createLobby],
  ["GET", new URLPattern({ pathname: "/v1/invites/:token" }), previewInvite],
  ["POST", new URLPattern({ pathname: "/v1/invites/accept" }), acceptInvite],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/invites" }), createInvite],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/people" }), addPerson],
  ["POST", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/agents" }), addAgent],
  ["DELETE", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/agents/:agentId" }), removeAgent],
  ["DELETE", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/members/:login" }), removeMember],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/events" }), listEvents],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/ws" }), seatSocket],
  ["GET", new URLPattern({ pathname: "/v1/lobbies/:lobbyId/watch" }), watchSocket],
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
    await env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(Date.now()).run();
  },
} satisfies ExportedHandler<Env>;


async function health(_req: Request, env: Env): Promise<Response> {
  return Response.json({ ok: true, minClientVersion: env.MIN_CLIENT_VERSION });
}

/** A machine signs in with a GitHub token from the device flow and gets an account token (LLD 14.2). */
async function signInWithGitHub(req: Request, env: Env): Promise<Response> {
  const body = await parseBody(req, GitHubSignInBody);
  const user = await userFromGitHub(env, body.githubToken);
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

/** A machine signs out: it can't refresh any more, and its lobbies make new keys without it. */
async function logout(req: Request, env: Env): Promise<Response> {
  const account = await requireMachine(req, env);
  await env.DB.prepare("UPDATE machines SET revoked_at = ? WHERE machine_id = ?").bind(Date.now(), account.machineId).run();
  await forEachLobbyOf(env, account.userId, (lobby) => lobby.rotateKeys());
  return Response.json({});
}

/** Machines that signed in before v0.4 register their encryption key here (LLD 15.2). */
async function registerBoxKey(req: Request, env: Env): Promise<Response> {
  const account = await requireMachine(req, env);
  const { boxPublicKey } = await parseBody(req, BoxKeyBody);
  await env.DB.prepare("UPDATE machines SET box_public_key = ? WHERE machine_id = ?").bind(boxPublicKey, account.machineId).run();
  await forEachLobbyOf(env, account.userId, (lobby) => lobby.refreshKeys());
  return Response.json({});
}

async function webLogout(req: Request, env: Env): Promise<Response> {
  requireSameOrigin(req, env);
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

/** A daemon's connection to its user object, so the hosted dashboard can reach it (LLD 15.6). */
async function machineSocket(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  const token = tokenFromSubprotocol(req, "account");
  const account = token ? await accountFromToken(env, token) : undefined;
  if (!account?.machineId) throw new ProtocolError("login_required");
  const machine = await env.DB.prepare("SELECT name FROM machines WHERE machine_id = ?").bind(account.machineId).first<{ name: string }>();

  const headers = new Headers(req.headers);
  headers.set("X-Machine-Id", account.machineId);
  headers.set("X-Machine-Name", machine?.name ?? "unknown");
  headers.delete("Sec-WebSocket-Protocol");
  const res = await userStub(env, account.userId).fetch(new Request(req.url, { headers }));
  return new Response(null, { status: 101, webSocket: res.webSocket, headers: { "Sec-WebSocket-Protocol": "agentlobbies.v1" } });
}

/** A browser tab's live view of the user's machines and agents. */
async function browserSocket(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  requireSameOrigin(req, env);
  const account = await requireAccount(req, env);
  const headers = new Headers(req.headers);
  headers.delete("X-Machine-Id");
  return userStub(env, account.userId).fetch(new Request(req.url, { headers }));
}

async function listLobbies(req: Request, env: Env): Promise<Response> {
  const account = await requireAccount(req, env);
  const lobbies = await lobbiesOf(env, account.userId);
  const result = await Promise.all(lobbies.map(async (l) => ({
    lobbyId: l.lobby_id, name: l.name, role: l.role, ...(await lobbyStub(env, l.lobby_id).summary()),
  })));
  return Response.json(result);
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
  const token = await issueJwt(env, { sub: agentId, lobby: params.lobbyId, role: result.role });
  return Response.json({ token });
}

/** The lobby owner makes a link that lets whoever opens it (after signing in) become a member or viewer. */
async function createInvite(req: Request, env: Env, params: Params): Promise<Response> {
  const account = await requireAccount(req, env);
  if ((await membership(env, params.lobbyId, account.userId)) !== "owner") throw new ProtocolError("forbidden", "only the lobby owner can invite");
  const body = await parseBody(req, InviteBody);
  const token = toB64u(crypto.getRandomValues(new Uint8Array(24)));
  const expiresAt = Date.now() + body.ttlMs;
  await env.DB.prepare("INSERT INTO invites (token_hash, lobby_id, role, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), params.lobbyId, body.role, account.userId, expiresAt, body.maxUses ?? null).run();
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
  await userStub(env, account.userId).notify({ t: "lobbies" });
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
  await userStub(env, target.user_id).notify({ t: "lobbies" });
  return Response.json({});
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

  const headers = new Headers(req.headers);
  headers.set("X-Agent-Id", claims.sub);
  headers.delete("X-Machine-Id");
  headers.delete("X-User-Id");
  const accountToken = tokenFromSubprotocol(req, "account");
  let machine: Account | undefined;
  if (accountToken) machine = await accountFromToken(env, accountToken);
  if (machine?.machineId) {
    headers.set("X-Machine-Id", machine.machineId);
    headers.set("X-User-Id", machine.userId);
  }
  headers.delete("Sec-WebSocket-Protocol");
  return lobbyStub(env, claims.lobby).fetch(new Request(req.url, { headers }));
}

/** The hosted dashboard watching a lobby live: roster and message metadata only. */
async function watchSocket(req: Request, env: Env, params: Params): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") throw new ProtocolError("bad_request", "expected a websocket upgrade");
  requireSameOrigin(req, env);
  const account = await requireAccount(req, env);
  const role = await membership(env, params.lobbyId, account.userId);
  if (!role) throw new ProtocolError("forbidden");
  const headers = new Headers(req.headers);
  headers.set("X-Watch-User", account.userId);
  headers.set("X-Watch-Owner", role === "owner" ? "1" : "0");
  return lobbyStub(env, params.lobbyId!).fetch(new Request(req.url, { headers }));
}


/** The signed-in caller: a daemon's Bearer account token, or a browser's session cookie (LLD 15.6). */
async function requireAccount(req: Request, env: Env): Promise<Account> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (bearer) {
    const account = await accountFromToken(env, bearer);
    if (account) return account;
    throw new ProtocolError("login_required", "sign in with `agentlobbies login` first");
  }

  const session = readCookie(req, SESSION_COOKIE);
  const userId = session ? await verifyWebJwt(env, session) : undefined;
  if (userId) {
    // A cookie is sent by the browser on its own, so changes must come from this site's pages.
    if (req.method !== "GET") requireSameOrigin(req, env);
    const user = await env.DB.prepare("SELECT login, avatar_url FROM users WHERE user_id = ?").bind(userId).first<{ login: string; avatar_url: string }>();
    if (user) return { userId, login: user.login, avatarUrl: user.avatar_url };
  }
  throw new ProtocolError("login_required", "sign in first");
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
     WHERE m.machine_id = ? AND m.user_id = ? AND m.revoked_at IS NULL`,
  ).bind(claims.machineId, claims.userId).first<{ login: string; avatar_url: string }>();
  if (!user) return undefined;
  return { ...claims, login: user.login, avatarUrl: user.avatar_url };
}

function requireSameOrigin(req: Request, env: Env): void {
  if (req.headers.get("origin") !== new URL(env.PUBLIC_URL).origin) throw new ProtocolError("forbidden", "cross-site request");
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
  const result = await lobbyStub(env, lobbyId).admit({ ...profile, agentId, owner }, role);
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
    json = await req.json();
  } catch {
    json = undefined; // not JSON; the schema reports it
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ProtocolError("bad_request", parsed.error.issues[0]?.message ?? "invalid body");
  return parsed.data;
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
