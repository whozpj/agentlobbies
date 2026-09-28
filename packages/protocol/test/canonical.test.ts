import { describe, expect, it } from "vitest";
import { canonical } from "../src/index.js";

describe("canonical", () => {
  it("is independent of key order", () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("sorts keys and removes whitespace (RFC 8785)", () => {
    expect(canonical({ b: [1, "x"], a: true })).toBe('{"a":true,"b":[1,"x"]}');
  });

  it("treats undefined values the same as absent keys, recursively (G36)", () => {
    expect(canonical({ a: 1, inReplyTo: undefined, nested: { x: undefined, y: 2 } }))
      .toBe(canonical({ a: 1, nested: { y: 2 } }));
  });

  it("keeps null values", () => {
    expect(canonical({ a: null })).toBe('{"a":null}');
  });
});
