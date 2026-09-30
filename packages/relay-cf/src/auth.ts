import { TIMINGS, type Role } from "@agentlobbies/protocol";
import { SignJWT, decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify } from "jose";

const ISSUER = "agentlobbies";
const AUDIENCE = "agentlobbies-relay";

export interface Claims {
  sub: string; // agent id
  lobby: string;
  role: Role; // display hint only; roles are always read from the lobby (H9)
}

export async function issueJwt(env: Env, claims: Claims): Promise<string> {
  const key = await importPKCS8(env.JWT_PRIVATE_KEY, "EdDSA");
  return new SignJWT({ lobby: claims.lobby, role: claims.role })
    .setProtectedHeader({ alg: "EdDSA", kid: env.JWT_KID })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TIMINGS.jwtTtlSec}s`)
    .sign(key);
}

/** Verifies a token against the public key named by its `kid`. Returns undefined if invalid. */
export async function verifyJwt(env: Env, token: string): Promise<Claims | undefined> {
  try {
    const { kid } = decodeProtectedHeader(token);
    const pem = (JSON.parse(env.JWT_PUBLIC_KEYS) as Record<string, string>)[kid ?? ""];
    if (!pem) return undefined;
    const { payload } = await jwtVerify(token, await importSPKI(pem, "EdDSA"), {
      issuer: ISSUER, audience: AUDIENCE, algorithms: ["EdDSA"],
    });
    if (typeof payload.sub !== "string" || typeof payload.lobby !== "string") return undefined;
    return { sub: payload.sub, lobby: payload.lobby, role: payload.role as Role };
  } catch {
    return undefined;
  }
}

export interface AccountClaims {
  userId: string;
  machineId: string;
}

const ACCOUNT_TTL = "30d";

export async function issueAccountJwt(env: Env, claims: AccountClaims): Promise<string> {
  const key = await importPKCS8(env.JWT_PRIVATE_KEY, "EdDSA");
  return new SignJWT({ kind: "account", machine: claims.machineId })
    .setProtectedHeader({ alg: "EdDSA", kid: env.JWT_KID })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ACCOUNT_TTL)
    .sign(key);
}

/** Verifies an account token (not a lobby seat token). Returns undefined if invalid. */
export async function verifyAccountJwt(env: Env, token: string): Promise<AccountClaims | undefined> {
  try {
    const { kid } = decodeProtectedHeader(token);
    const pem = (JSON.parse(env.JWT_PUBLIC_KEYS) as Record<string, string>)[kid ?? ""];
    if (!pem) return undefined;
    const { payload } = await jwtVerify(token, await importSPKI(pem, "EdDSA"), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["EdDSA"] });
    if (payload.kind !== "account" || typeof payload.sub !== "string" || typeof payload.machine !== "string") return undefined;
    return { userId: payload.sub, machineId: payload.machine };
  } catch {
    return undefined;
  }
}

/** Browsers can't set headers on WebSockets, so the token rides in the subprotocol list. */
export function tokenFromSubprotocol(req: Request): string | undefined {
  const protocols = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
  return protocols.find((p) => p.startsWith("bearer."))?.slice("bearer.".length);
}
