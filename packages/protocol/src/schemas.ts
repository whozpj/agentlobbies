import { z } from "zod";
import { LIMITS } from "./constants.js";

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const LobbyId = z.string().regex(/^[0-9a-f]{64}$/);
export const Handle = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/);
export const Topic = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const BoardKey = Topic;
export const B64u = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const Ms = z.number().int().nonnegative();
export const Seq = z.number().int().positive();

export const ClientId = z.enum(["claude-code", "codex", "gemini-cli", "cursor", "opencode", "cli", "custom"]);
export const Role = z.enum(["host", "member", "observer"]);
export const Status = z.enum(["active", "busy", "idle", "offline"]);
/** What a client may claim about itself; only the relay marks agents offline (G31). */
export const PresenceStatus = z.enum(["active", "busy", "idle"]);

export const Owner = z.object({ login: z.string(), avatarUrl: z.string() });

export const AgentProfile = z.object({
  agentId: Ulid,
  handle: Handle,
  client: ClientId,
  model: z.string().max(64).optional(),
  owns: z.array(Topic).max(LIMITS.maxOwns),
  workingOn: z.string().max(LIMITS.maxWorkingOnChars),
  status: Status,
  role: Role,
  publicKey: B64u,
  joinedAt: Ms,
  lastSeenAt: Ms,
  owner: Owner.optional(),
});

export const JoinProfile = AgentProfile.pick({ handle: true, client: true, model: true, owns: true, publicKey: true })
  .extend({ workingOn: z.string().max(LIMITS.maxWorkingOnChars).default("") });

export const Recipient = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), agentId: Ulid }),
  z.object({ kind: z.literal("broadcast") }),
  z.object({ kind: z.literal("topic"), topic: Topic }),
]);

export const Attachment = z.object({
  kind: z.enum(["diff", "file_snippet", "schema", "text"]),
  name: z.string().min(1).max(200),
  content: z.string(),
});

export const MessageType = z.enum(["question", "answer", "update"]);

/** A body and attachments encrypted with the lobby key of `epoch` (LLD 15.5). */
export const Sealed = z.object({
  epoch: z.number().int().positive(),
  iv: B64u,
  data: B64u.max(LIMITS.maxSealedChars),
});

/** v1 carries `body` in the clear (history from before v0.4); v2 carries only `sealed`. */
export const Envelope = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  id: Ulid,
  lobbyId: LobbyId,
  from: Ulid,
  to: Recipient,
  type: MessageType,
  inReplyTo: Ulid.optional(),
  threadDepth: z.number().int().min(0).max(LIMITS.maxThreadDepthCeiling),
  body: z.string().min(1).optional(),
  attachments: z.array(Attachment).max(LIMITS.maxAttachmentsPerEnvelope).optional(),
  sealed: Sealed.optional(),
  createdAt: Ms,
  sig: B64u,
}).refine(
  (e) => (e.v === 1 ? e.body !== undefined && !e.sealed : e.sealed !== undefined && e.body === undefined && e.attachments === undefined),
  { message: "a v1 envelope carries a body; a v2 envelope carries only sealed content" },
);

/** What the relay can show about a message without reading it (LLD 15.1). */
export const MessageMeta = z.object({
  id: Ulid,
  seq: Seq,
  from: z.string(),
  to: z.string(),
  type: MessageType,
  inReplyTo: Ulid.nullable(),
  committedAt: Ms,
});

export const BoardEntry = z.object({
  key: BoardKey,
  value: z.string(),
  author: Ulid,
  version: z.number().int().positive(),
  seq: Seq,
  updatedAt: Ms,
  deleted: z.boolean().optional(),
});

export const LobbySettings = z.object({
  name: z.string().max(64).optional(),
  maxThreadDepth: z.number().int().min(1).max(LIMITS.maxThreadDepthCeiling).default(LIMITS.maxThreadDepthDefault),
  sendPerMinute: z.number().int().min(1).max(120).default(30),
  historyOnJoin: z.enum(["full", "since_join"]).default("full"),
  observersSeeDirects: z.boolean().default(false),
});

export const SystemEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("lobby_created"), hostId: Ulid.optional() }),
  z.object({ type: z.literal("joined"), agent: AgentProfile }),
  z.object({ type: z.literal("left"), agentId: Ulid, reason: z.enum(["left", "kicked", "never_connected"]) }),
  z.object({ type: z.literal("role_changed"), agentId: Ulid, role: Role, by: Ulid }),
  z.object({ type: z.literal("settings_changed"), settings: LobbySettings }),
  z.object({ type: z.literal("closing") }),
]);

export const LobbyEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), seq: Seq, committedAt: Ms, envelope: Envelope }),
  z.object({ kind: z.literal("board"), seq: Seq, committedAt: Ms, entry: BoardEntry }),
  z.object({ kind: z.literal("system"), seq: Seq, committedAt: Ms, system: SystemEvent }),
]);

export type ClientId = z.infer<typeof ClientId>;
export type Role = z.infer<typeof Role>;
export type Status = z.infer<typeof Status>;
export type AgentProfile = z.infer<typeof AgentProfile>;
export type Owner = z.infer<typeof Owner>;
export type JoinProfile = z.infer<typeof JoinProfile>;
export type Recipient = z.infer<typeof Recipient>;
export type Attachment = z.infer<typeof Attachment>;
export type Envelope = z.infer<typeof Envelope>;
export type Sealed = z.infer<typeof Sealed>;
export type MessageMeta = z.infer<typeof MessageMeta>;
export type BoardEntry = z.infer<typeof BoardEntry>;
export type LobbySettings = z.infer<typeof LobbySettings>;
export type SystemEvent = z.infer<typeof SystemEvent>;
export type LobbyEvent = z.infer<typeof LobbyEvent>;
