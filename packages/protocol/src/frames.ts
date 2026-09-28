import { z } from "zod";
import { LIMITS } from "./constants.js";
import { AgentProfile, B64u, BoardEntry, BoardKey, Envelope, LobbyEvent, LobbySettings, Ms, PresenceStatus, Role, Seq, Topic, Ulid } from "./schemas.js";

const Cursor = z.number().int().min(0);

export const ClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), v: z.literal(1), afterSeq: Cursor, clientVersion: z.string(), wantsPresence: z.boolean().default(false) }),
  z.object({ t: z.literal("send"), reqId: Ulid, envelope: Envelope }),
  z.object({ t: z.literal("ack"), seq: Cursor }),
  z.object({ t: z.literal("presence"), status: PresenceStatus, workingOn: z.string().max(LIMITS.maxWorkingOnChars) }),
  z.object({ t: z.literal("subscribe"), reqId: Ulid, topic: Topic }),
  z.object({ t: z.literal("unsubscribe"), reqId: Ulid, topic: Topic }),
  z.object({ t: z.literal("board.put"), reqId: Ulid, key: BoardKey, value: z.string(), expectedVersion: Cursor, sig: B64u }),
  z.object({ t: z.literal("board.delete"), reqId: Ulid, key: BoardKey, expectedVersion: z.number().int().positive(), sig: B64u }),
  z.object({ t: z.literal("replay.more"), afterSeq: Cursor }),
]);

export const ServerFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"), agentId: Ulid, role: Role, headSeq: Cursor,
    roster: z.array(AgentProfile), board: z.array(BoardEntry.omit({ value: true })),
    settings: LobbySettings, subscriptions: z.array(Topic), truncatedBefore: Seq.optional(),
  }),
  z.object({ t: z.literal("events"), events: z.array(LobbyEvent), more: z.boolean() }),
  z.object({ t: z.literal("event"), event: LobbyEvent }),
  z.object({ t: z.literal("ok"), reqId: Ulid, seq: Seq.optional(), held: z.boolean().optional(), entry: BoardEntry.optional() }),
  z.object({
    t: z.literal("err"), reqId: Ulid.optional(), code: z.string(), message: z.string(),
    retryAfterMs: Ms.optional(), current: BoardEntry.optional(),
  }),
  z.object({ t: z.literal("roster"), agent: AgentProfile }),
  z.object({
    t: z.literal("held"), count: z.number().int().min(0),
    latest: z.object({ envelopeId: Ulid, from: Ulid, preview: z.string().max(200) }).optional(),
  }),
  z.object({ t: z.literal("notice"), kind: z.literal("rate_limited"), agentId: Ulid }),
]);

export type ClientFrame = z.infer<typeof ClientFrame>;
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Heartbeats bypass parsing: the relay answers them with the hibernation auto-response (C7). */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';
