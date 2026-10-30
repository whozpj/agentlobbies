import type { SurfacedMessage } from "@agentlobbies/daemon/client";
import { describe, expect, it } from "vitest";
import { ago, describeSource, renderMessage, renderPending } from "../src/render";

const now = Date.UTC(2026, 9, 29, 15, 0);
const commit = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

function message(fields: Partial<SurfacedMessage> = {}): SurfacedMessage {
  return {
    id: "01K00000000000000000000001", seq: 1, from: "api-codex", fromAgentId: "a", fromClient: "codex",
    type: "answer", to: { kind: "broadcast" }, body: "estimatedArrival, ISO 8601", sentAt: now - 12 * 60_000,
    provenance: { branch: "main", commit, dirty: false }, ...fields,
  };
}

describe("how old a message is", () => {
  it("reads as just now, minutes, hours, or days, and a sender's clock running ahead reads as just now", () => {
    expect(ago(now - 30_000, now)).toBe("just now");
    expect(ago(now + 5 * 60_000, now)).toBe("just now");
    expect(ago(now - 60_000, now)).toBe("1 minute ago");
    expect(ago(now - 59 * 60_000, now)).toBe("59 minutes ago");
    expect(ago(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(ago(now - 47 * 3_600_000, now)).toBe("47 hours ago");
    expect(ago(now - 72 * 3_600_000, now)).toBe("3 days ago");
  });
});

describe("where a message came from", () => {
  it("names the branch, the short commit, whether there were uncommitted changes, and when", () => {
    expect(describeSource(message(), now)).toBe("Sent from branch main at commit 1a2b3c4, no uncommitted changes, 12 minutes ago.");
    expect(describeSource(message({ provenance: { branch: "feat/eta", commit, dirty: true } }), now))
      .toBe("Sent from branch feat/eta at commit 1a2b3c4, with uncommitted changes, 12 minutes ago.");
  });

  it("says so for a detached checkout, a repo with no commits, and a sender with no git details", () => {
    expect(describeSource(message({ provenance: { commit, dirty: false } }), now)).toBe("Sent from a detached checkout at commit 1a2b3c4, no uncommitted changes, 12 minutes ago.");
    expect(describeSource(message({ provenance: { branch: "main", dirty: true } }), now)).toBe("Sent from branch main with no commits yet, with uncommitted changes, 12 minutes ago.");
    expect(describeSource(message({ provenance: undefined }), now)).toBe("Sent without git checkout details (not a git repo, or an older client), 12 minutes ago.");
    expect(describeSource(message({ provenance: undefined, sentAt: undefined }), now)).toBe("Sent without git checkout details (not a git repo, or an older client).");
  });
});

describe("a rendered peer message", () => {
  const verify = "check it against code you can see";

  it("puts where it came from right under the header, and tells the agent to check an answer or update before relying on it", () => {
    const lines = renderMessage(message(), { now }).split("\n");
    expect(lines[0]).toBe("[lobby message from api-codex (codex) | id 01K00000000000000000000001 | answer]");
    expect(lines[1]).toBe("Sent from branch main at commit 1a2b3c4, no uncommitted changes, 12 minutes ago.");
    expect(lines[2]).toContain(verify);
    expect(renderMessage(message({ type: "update" }), { now })).toContain(verify);
  });

  it("doesn't ask the agent to verify a question, and adds nothing for a person or a notice", () => {
    const question = renderMessage(message({ type: "question" }), { now });
    expect(question).toContain("Sent from branch main");
    expect(question).not.toContain(verify);

    const fromPerson = renderMessage(message({ from: "whozpj", fromClient: "cli", type: "update", provenance: undefined }), { now });
    expect(fromPerson).not.toContain("Sent ");
    expect(fromPerson).not.toContain(verify);

    expect(renderMessage(message({ type: "notice", body: "You were added" }), { now })).toBe("[lobby notice] You were added");
  });

  it("keeps where it came from in the short previews other tools' results carry", () => {
    expect(renderPending([message({ body: "x".repeat(5_000) })], 0)).toContain("Sent from branch main at commit 1a2b3c4");
  });
});
