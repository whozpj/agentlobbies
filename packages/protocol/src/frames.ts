import { z } from "zod";
import { LIMITS } from "./constants.js";
import { AgentProfile, B64u, BoardEntry, BoardKey, Envelope, LobbyEvent, LobbySettings, MessageMeta, Ms, PresenceStatus, Role, Seq, Topic, Ulid } from "./schemas.js";

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
  z.object({
    // create: start epoch `current + 1`; otherwise fill in copies of an existing epoch.
    t: z.literal("keys.put"), reqId: Ulid, epoch: z.number().int().positive(), create: z.boolean(),
    sealed: z.array(z.object({ machineId: Ulid, sealed: B64u })).min(1).max(LIMITS.maxMachinesPerLobby),
  }),
]);

export const ServerFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"), agentId: Ulid, role: Role, headSeq: Cursor,
    roster: z.array(AgentProfile), board: z.array(BoardEntry.omit({ value: true })),
    settings: LobbySettings, subscriptions: z.array(Topic), truncatedBefore: Seq.optional(),
  }),
  z.object({ t: z.literal("events"), events: z.array(LobbyEvent), more: z.boolean() }),
  z.object({ t: z.literal("event"), event: LobbyEvent }),
  z.object({ t: z.literal("ok"), reqId: Ulid, seq: Seq.optional(), entry: BoardEntry.optional() }),
  z.object({
    t: z.literal("err"), reqId: Ulid.optional(), code: z.string(), message: z.string(),
    retryAfterMs: Ms.optional(), current: BoardEntry.optional(),
  }),
  z.object({ t: z.literal("roster"), agent: AgentProfile }),
  z.object({ t: z.literal("notice"), kind: z.literal("rate_limited"), agentId: Ulid }),
  // Lobby keys, sealed to machines (LLD 15.4).
  z.object({
    t: z.literal("keys"), current: Cursor, rotate: z.boolean(),
    mine: z.array(z.object({ epoch: z.number().int().positive(), sealed: B64u })),
    machines: z.array(z.object({ machineId: Ulid, boxPublicKey: B64u })),
    missing: z.array(z.object({ machineId: Ulid, epochs: z.array(z.number().int().positive()) })),
  }),
  // To dashboard watchers only: a message without its content (LLD 15.6).
  z.object({ t: z.literal("meta"), message: MessageMeta }),
]);

export type ClientFrame = z.infer<typeof ClientFrame>;
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Heartbeats bypass parsing: the relay answers them with the hibernation auto-response (C7). */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';
