import { describe, expect, it } from "vitest";
import { ERROR_CODES, ProtocolError, httpStatusOf } from "../src/index.js";

describe("errors", () => {
  it("maps codes to the HTTP statuses in section 3.6", () => {
    expect(httpStatusOf("bad_request")).toBe(400);
    expect(httpStatusOf("version_conflict")).toBe(409);
    expect(httpStatusOf("handle_taken")).toBe(409);
    expect(httpStatusOf("lobby_closed")).toBe(410);
    expect(httpStatusOf("rate_limited")).toBe(429);
  });

  it("carries a code, message, and optional retry hint", () => {
    const e = new ProtocolError("rate_limited", "slow down", { retryAfterMs: 2000 });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("rate_limited");
    expect(e.status).toBe(429);
    expect(e.retryAfterMs).toBe(2000);
  });

  it("lists every code exactly once", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toContain("internal");
  });
});
