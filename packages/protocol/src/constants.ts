export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  maxAgentsPerLobby: 32,
  maxBodyBytes: 16 * 1024,
  maxSealedChars: 110 * 1024,
  maxMachinesPerLobby: 256,
  maxAttachmentBytesTotal: 64 * 1024,
  maxAttachmentsPerEnvelope: 8,
  maxBoardValueBytes: 32 * 1024,
  maxBoardKeys: 500,
  maxWorkingOnChars: 140,
  maxOwns: 16,
  maxSubscriptionsPerAgent: 32,
  maxThreadDepthDefault: 6,
  maxThreadDepthCeiling: 12,
  maxFrameBytes: 128 * 1024,
  maxBoardHotVersions: 20,
  replayPageMaxBytes: 512 * 1024,
  piggybackMaxBytes: 12 * 1024,
  piggybackBodyPreviewBytes: 2 * 1024,
} as const;

export const RATES = {
  sendPerMinute: 30,
  sendRefillPerSecond: 0.5,
  sendPerHour: 300,
  lobbyEventsPerSecond: 50,
  createLobbyPerIpPerMinute: 5,
  createLobbyPerIpPerHour: 20,
  inviteAttemptsPerIpPerMinute: 10,
  presenceMinIntervalMs: 5_000,
} as const;

export const TIMINGS = {
  jwtTtlSec: 24 * 60 * 60,
  refreshSkewMs: 5 * 60_000,
  heartbeatIntervalMs: 20_000,
  offlineAfterMs: 60_000,
  presenceSweepMs: 30_000,
  helloTimeoutMs: 10_000,
  archiveAlarmMs: 6 * 60 * 60_000,
  hotRetentionMs: 7 * 24 * 60 * 60_000,
  idleCloseMs: 7 * 24 * 60 * 60_000,
  reconnectMinMs: 500,
  reconnectMaxMs: 30_000,
  replayPageSize: 100,
  rpcTimeoutMs: 10_000,
  sendAckTimeoutMs: 10_000,
} as const;
