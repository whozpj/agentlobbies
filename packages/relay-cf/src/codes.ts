import { generateCode } from "@agentlobbies/protocol";

/** Inserts a fresh code, retrying on the rare collision with an existing one. */
export async function insertCode(
  db: D1Database, lobbyId: string, opts: { role: "member" | "observer"; expiresAt: number; maxUses?: number },
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const code = generateCode();
    try {
      await db.prepare("INSERT INTO lobby_codes (code, lobby_id, role, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)")
        .bind(code, lobbyId, opts.role, opts.expiresAt, opts.maxUses ?? null).run();
      return code;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}
