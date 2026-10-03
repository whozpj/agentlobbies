import { ProtocolError, toB64u } from "@agentlobbies/protocol";
import { ulid } from "ulid";
import { issueWebJwt, readCookie } from "./auth";

export const SESSION_COOKIE = "__Host-session";
const STATE_COOKIE = "__Host-oauth";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export interface User {
  userId: string;
  login: string;
  avatarUrl: string;
}

/** Looks up who a GitHub token belongs to (one call), records them, and forgets the token (LLD 14.2). */
export async function userFromGitHub(env: Env, githubToken: string): Promise<User> {
  const res = await fetch(`${env.GITHUB_API_URL}/user`, {
    headers: { authorization: `Bearer ${githubToken}`, accept: "application/vnd.github+json", "user-agent": "agentlobbies-relay" },
  });
  if (!res.ok) throw new ProtocolError("unauthorized", "GitHub rejected the sign-in");
  const profile = (await res.json()) as { id: number; login: string; avatar_url: string };

  const row = await env.DB.prepare(
    `INSERT INTO users (user_id, github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url
     RETURNING user_id, suspended_at`,
  ).bind(ulid(), profile.id, profile.login, profile.avatar_url, Date.now()).first<{ user_id: string; suspended_at: number | null }>();
  if (row!.suspended_at !== null) throw new ProtocolError("forbidden", "this account is suspended");
  return { userId: row!.user_id, login: profile.login, avatarUrl: profile.avatar_url };
}

/** Only paths on this site, so sign-in can't be used to redirect somewhere else. */
function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

function returnPathFrom(encoded: string | undefined): string {
  try {
    return safeReturnPath(decodeURIComponent(encoded ?? ""));
  } catch {
    return "/"; // not valid percent-encoding
  }
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function callbackUrl(env: Env): string {
  return `${env.PUBLIC_URL}/auth/github/callback`;
}

/** Step 1 of the OAuth web flow: remember a random state and where to come back to, then go to GitHub. */
export async function startWebSignIn(req: Request, env: Env): Promise<Response> {
  const state = toB64u(crypto.getRandomValues(new Uint8Array(16)));
  const returnPath = safeReturnPath(new URL(req.url).searchParams.get("return"));
  const authorize = new URL(`${env.GITHUB_URL}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callbackUrl(env));
  authorize.searchParams.set("state", state);
  const cookie = `${STATE_COOKIE}=${state}.${encodeURIComponent(returnPath)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  return redirect(authorize.toString(), [cookie]);
}

/** Step 2: GitHub sends the user back with a code. Exchange it, record the user, and start a session. */
export async function finishWebSignIn(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const [expectedState, encodedReturn] = (readCookie(req, STATE_COOKIE) ?? "").split(".");
  const clearState = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const code = url.searchParams.get("code");
  if (!code || !expectedState || url.searchParams.get("state") !== expectedState) {
    return redirect("/?signin=failed", [clearState]);
  }

  const exchange = await fetch(`${env.GITHUB_URL}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agentlobbies-relay" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callbackUrl(env) }),
  });
  const token = exchange.ok ? ((await exchange.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return redirect("/?signin=failed", [clearState]);

  let user: User;
  try {
    user = await userFromGitHub(env, token);
  } catch {
    return redirect("/?signin=failed", [clearState]);
  }
  const sessionId = ulid();
  await env.DB.prepare("INSERT INTO web_sessions (session_id, user_id, created_at) VALUES (?, ?, ?)").bind(sessionId, user.userId, Date.now()).run();
  const jwt = await issueWebJwt(env, { userId: user.userId, sessionId });
  const session = `${SESSION_COOKIE}=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
  return redirect(returnPathFrom(encodedReturn), [clearState, session]);
}

export function signOut(): Response {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` },
  });
}
