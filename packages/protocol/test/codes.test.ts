import { describe, expect, it } from "vitest";
import { CODE_WORDS, LobbyCode, generateCode, isValidCode, normalizeCode } from "../src/index.js";

describe("word list", () => {
  it("has 2,048 unique lowercase words of 3 to 8 letters", () => {
    expect(CODE_WORDS).toHaveLength(2048);
    expect(new Set(CODE_WORDS).size).toBe(2048);
    for (const w of CODE_WORDS) expect(w).toMatch(/^[a-z]{3,8}$/);
  });

  it("has no two words sharing their first four letters, so typos stay unambiguous", () => {
    expect(new Set(CODE_WORDS.map((w) => w.slice(0, 4))).size).toBe(2048);
  });
});

describe("generateCode", () => {
  it("produces digit-word-word from the list", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[2-9]-[a-z]+-[a-z]+$/);
      expect(isValidCode(code)).toBe(true);
    }
  });

  it("maps random values to the digit and words without modulo bias", () => {
    // 3 draws: digit, word 1, word 2. 0 -> '2' and the first word; max -> '9' and the last word.
    const draws = [0, 0, 0xffffffff];
    const code = generateCode(() => draws.shift()!);
    expect(code).toBe(`2-${CODE_WORDS[0]}-${CODE_WORDS[2047]}`);
    const top = [0xffffffff, 5, 6];
    expect(generateCode(() => top.shift()!)).toBe(`9-${CODE_WORDS[5]}-${CODE_WORDS[6]}`);
  });
});

describe("normalizeCode", () => {
  it("lowercases and turns spaces and underscores into single hyphens", () => {
    expect(normalizeCode("  4 Maple_Orbit ")).toBe("4-maple-orbit");
    expect(normalizeCode("4--maple   orbit")).toBe("4-maple-orbit");
  });
});

describe("isValidCode", () => {
  it("rejects digits outside 2 to 9 and words not in the list", () => {
    const [a, b] = [CODE_WORDS[10]!, CODE_WORDS[20]!];
    expect(isValidCode(`1-${a}-${b}`)).toBe(false);
    expect(isValidCode(`3-${a}-zzzzzz`)).toBe(false);
    expect(isValidCode(`3-${a}-${b}`)).toBe(true);
  });

  it("is exposed as a schema that normalizes input first", () => {
    const [a, b] = [CODE_WORDS[1]!, CODE_WORDS[2]!];
    expect(LobbyCode.parse(` 5 ${a.toUpperCase()} ${b} `)).toBe(`5-${a}-${b}`);
    expect(LobbyCode.safeParse("5-not-inlist-x").success).toBe(false);
  });
});
