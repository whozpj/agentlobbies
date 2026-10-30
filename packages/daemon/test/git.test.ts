import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProvenance } from "../src/git";
import { git, makeRepo } from "./lobby-helpers";

const head = (dir: string) => git(dir, "rev-parse", "HEAD");
const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; });

describe("reading the checkout an agent writes from", () => {
  it("reads the branch and full commit of a clean repo", async () => {
    const dir = makeRepo();
    expect(await readProvenance(dir)).toEqual({ branch: "main", commit: head(dir), dirty: false });
  });

  it("counts a changed file, a staged-only change, and a new untracked file as uncommitted changes", async () => {
    const changed = makeRepo();
    writeFileSync(join(changed, "orders.ts"), "export const v = 2;\n");
    expect(await readProvenance(changed)).toMatchObject({ dirty: true });

    const staged = makeRepo();
    writeFileSync(join(staged, "orders.ts"), "export const v = 3;\n");
    git(staged, "add", "orders.ts");
    expect(await readProvenance(staged)).toMatchObject({ dirty: true });

    const untracked = makeRepo();
    writeFileSync(join(untracked, "new.ts"), "\n");
    expect(await readProvenance(untracked)).toMatchObject({ dirty: true });
  });

  it("has no branch on a detached HEAD, and no commit in a repo with no commits yet", async () => {
    const detached = makeRepo();
    git(detached, "checkout", "-q", "--detach");
    expect(await readProvenance(detached)).toEqual({ commit: head(detached), dirty: false });

    const empty = mkdtempSync(join(tmpdir(), "al-repo-"));
    git(empty, "init", "-q", "-b", "main");
    expect(await readProvenance(empty)).toEqual({ branch: "main", dirty: false });
  });

  it("reads a branch with a slash, and works from a subfolder of the repo", async () => {
    const dir = makeRepo();
    git(dir, "checkout", "-q", "-b", "feat/eta");
    mkdirSync(join(dir, "src"));
    expect(await readProvenance(join(dir, "src"))).toEqual({ branch: "feat/eta", commit: head(dir), dirty: false });
  });

  it("gives nothing, without failing, outside a repo, in a deleted folder, or without git", async () => {
    expect(await readProvenance(mkdtempSync(join(tmpdir(), "al-plain-")))).toBeUndefined();
    expect(await readProvenance(join(tmpdir(), "al-no-such-folder-here"))).toBeUndefined();
    process.env.PATH = mkdtempSync(join(tmpdir(), "al-empty-path-"));
    expect(await readProvenance(makeRepoWith(originalPath))).toBeUndefined();
  });

  it("gives up on a git that hangs, so a send never waits long", async () => {
    const bin = mkdtempSync(join(tmpdir(), "al-slow-git-"));
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 10\n");
    chmodSync(join(bin, "git"), 0o755);
    const dir = makeRepo();
    process.env.PATH = `${bin}:${originalPath}`;
    const started = Date.now();
    expect(await readProvenance(dir)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never takes git's index lock, and never runs a program the repo's config names", async () => {
    const dir = makeRepo();
    const marker = join(dir, "..", `${dir.split("/").pop()}-fsmonitor-ran`);
    writeFileSync(join(dir, "monitor.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(dir, "monitor.sh"), 0o755);
    git(dir, "config", "core.fsmonitor", join(dir, "monitor.sh"));
    await readProvenance(dir);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});

/** Makes a repo with git still on PATH, for tests that then take git away. */
function makeRepoWith(path: string | undefined): string {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return makeRepo();
  } finally {
    process.env.PATH = saved;
  }
}
