import { describe, expect, it } from "vitest";
import { findSecret } from "../src/guard";

describe("findSecret", () => {
  it.each([
    ["an AWS access key", "key AKIAIOSFODNN7EXAMPLE here", "aws_access_key"],
    ["a GitHub token", "ghp_" + "a".repeat(36), "github_token"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc", "private_key"],
    ["an Anthropic key", "sk-ant-api03-" + "x".repeat(40), "anthropic_key"],
  ])("finds %s", (_name, text, kind) => {
    expect(findSecret(text)).toBe(kind);
  });

  it("does not flag commit hashes or UUIDs (G34)", () => {
    expect(findSecret("fixed in 2f5eed53a4727b4bf8880d8f3f199efc90e58503")).toBeUndefined();
    expect(findSecret("id 123e4567-e89b-12d3-a456-426614174000")).toBeUndefined();
  });
});
