// Only well-known formats: generic long strings like commit hashes must not block (G34).
const SECRET_PATTERNS: [kind: string, pattern: RegExp][] = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** The kind of the first secret found in `text`, if any. */
export function findSecret(text: string): string | undefined {
  return SECRET_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}
