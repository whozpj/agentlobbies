import { execFile } from "node:child_process";
import { Provenance } from "@agentlobbies/protocol";

/**
 * The git checkout an agent is working in: branch, commit, and whether there are uncommitted
 * changes. Undefined outside a repo, without git, or when git is slow, so a send never fails or
 * waits long because of it.
 */
export function readProvenance(cwd: string): Promise<Provenance | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], {
      cwd,
      timeout: 1_500,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      // Never take index.lock from under the user's own git commands, and never ask for anything.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => {
      if (error) return resolve(undefined);
      const found: { branch?: string; commit?: string; dirty: boolean } = { dirty: false };
      for (const line of stdout.split("\n")) {
        if (line.startsWith("# branch.oid ")) {
          const oid = line.slice("# branch.oid ".length);
          if (oid !== "(initial)") found.commit = oid;
        } else if (line.startsWith("# branch.head ")) {
          const head = line.slice("# branch.head ".length);
          if (head !== "(detached)") found.branch = head;
        } else if (line && !line.startsWith("#")) {
          found.dirty = true; // a changed, staged, or untracked file
        }
      }
      const parsed = Provenance.safeParse(found);
      resolve(parsed.success ? parsed.data : undefined);
    });
  });
}
