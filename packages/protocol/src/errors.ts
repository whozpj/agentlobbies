const STATUS = {
  bad_request: 400,
  bad_signature: 400,
  lobby_mismatch: 400,
  too_large: 413,
  unauthorized: 401,
  login_required: 401,
  forbidden: 403,
  kicked: 403,
  not_found: 404,
  invalid_code: 404,
  handle_taken: 409,
  version_conflict: 409,
  duplicate: 409,
  already_rejected: 409,
  lobby_full: 409,
  machine_offline: 409,
  lobby_closed: 410,
  client_too_old: 426,
  thread_too_deep: 422,
  bad_reply: 422,
  unknown_recipient: 422,
  rate_limited: 429,
  board_full: 429,
  held_full: 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof STATUS;
export const ERROR_CODES = Object.keys(STATUS) as ErrorCode[];

export function httpStatusOf(code: ErrorCode): number {
  return STATUS[code];
}

export class ProtocolError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(readonly code: ErrorCode, message: string = code, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ProtocolError";
    this.status = STATUS[code];
    this.retryAfterMs = opts.retryAfterMs;
  }
}
