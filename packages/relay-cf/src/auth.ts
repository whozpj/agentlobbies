import { TIMINGS, type Role } from "@agentlobbies/protocol";
import { SignJWT, decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify, type JWTPayload } from "jose";

const ISSUER = "agentlobbies";
const AUDIENCE = "agentlobbies-relay";

/** A lobby seat token. */
export interface Claims {
  sub: string; // agent id
  lobby: string;
  role: Role; // display hint only; roles are always read from the lobby (H9)
}

/** A signed-in machine (daemon). */
export interface AccountClaims {
  userId: string;
  machineId: string;
}

async function sign(env: Env, subject: string, claims: Record<string, unknown>, ttl: string): Promise<string> {
  const key = await importPKCS8(env.JWT_PRIVATE_KEY, "EdDSA");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: env.JWT_KID })
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key);
}

/** Verifies a token against the public key named by its `kid`. Returns undefined if invalid. */
async function verify(env: Env, token: string): Promise<JWTPayload | undefined> {
  try {
    const { kid } = decodeProtectedHeader(token);
    const pem = (JSON.parse(env.JWT_PUBLIC_KEYS) as Record<string, string>)[kid ?? ""];
    if (!pem) return undefined;
    const { payload } = await jwtVerify(token, await importSPKI(pem, "EdDSA"), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["EdDSA"] });
    if (typeof payload.sub !== "string") return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function issueJwt(env: Env, claims: Claims): Promise<string> {
  return sign(env, claims.sub, { lobby: claims.lobby, role: claims.role }, `${TIMINGS.jwtTtlSec}s`);
}

export async function verifyJwt(env: Env, token: string): Promise<Claims | undefined> {
  const payload = await verify(env, token);
  if (!payload || typeof payload.lobby !== "string") return undefined;
  return { sub: payload.sub!, lobby: payload.lobby, role: payload.role as Role };
}

export function issueAccountJwt(env: Env, claims: AccountClaims): Promise<string> {
  return sign(env, claims.userId, { kind: "account", machine: claims.machineId }, "30d");
}

export async function verifyAccountJwt(env: Env, token: string): Promise<AccountClaims | undefined> {
  const payload = await verify(env, token);
  if (!payload || payload.kind !== "account" || typeof payload.machine !== "string") return undefined;
  return { userId: payload.sub!, machineId: payload.machine };
}

/** A browser session (LLD 15.6). */
export function issueWebJwt(env: Env, userId: string): Promise<string> {
  return sign(env, userId, { kind: "web" }, "7d");
}

export async function verifyWebJwt(env: Env, token: string): Promise<string | undefined> {
  const payload = await verify(env, token);
  if (!payload || payload.kind !== "web") return undefined;
  return payload.sub;
}

/** Browsers can't set headers on WebSockets, so tokens ride in the subprotocol list as `<prefix>.<token>`. */
export function tokenFromSubprotocol(req: Request, prefix = "bearer"): string | undefined {
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
  return protocols.find((p) => p.startsWith(`${prefix}.`))?.slice(prefix.length + 1);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}
