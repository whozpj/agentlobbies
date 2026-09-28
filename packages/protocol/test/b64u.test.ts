import { describe, expect, it } from "vitest";
import { fromB64u, toB64u } from "../src/index.js";

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    const s = toB64u(bytes);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.endsWith("=")).toBe(false);
    expect(Array.from(fromB64u(s))).toEqual(Array.from(bytes));
  });

  it("rejects characters outside the base64url alphabet", () => {
    expect(() => fromB64u("ab+c")).toThrow();
  });
});
