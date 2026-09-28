import { z } from "zod";
import { CODE_WORDS } from "./wordlist.js";

export { CODE_WORDS };

const WORD_INDEX = new Set(CODE_WORDS);
const FORMAT = /^([2-9])-([a-z]+)-([a-z]+)$/;

function randomUint32(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

/**
 * A lobby code: a digit 2 to 9 and two list words, about 33.5 million combinations.
 * 8 and 2,048 are powers of two, so masking a uniform uint32 is unbiased.
 */
export function generateCode(random: () => number = randomUint32): string {
  const digit = 2 + (random() & 7);
  const a = CODE_WORDS[random() & 2047]!;
  const b = CODE_WORDS[random() & 2047]!;
  return `${digit}-${a}-${b}`;
}

/** Lowercase, trim, and turn runs of spaces, underscores, or hyphens into one hyphen. */
export function normalizeCode(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

export function isValidCode(code: string): boolean {
  const m = FORMAT.exec(code);
  return m !== null && WORD_INDEX.has(m[2]!) && WORD_INDEX.has(m[3]!);
}

export const LobbyCode = z.string().transform(normalizeCode).refine(isValidCode, "invalid lobby code");
