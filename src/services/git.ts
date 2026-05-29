// Git service. Wraps git CLI operations on a vault working checkout.
//
// Design (v1):
//  - Per-operation sync: pull before reads, commit+push after writes.
//  - Stop-and-report on conflict: if a pull would require a merge, or a
//    push is rejected as non-fast-forward, we DO NOT auto-merge. We
//    throw a ToolError so the agent can surface it to the user. This
//    avoids silent corruption from automatic merges.
//  - TOLARIA_DISABLE_GIT_SYNC: tests and offline development can set
//    this env var to "true" to make pull and push no-ops. The local
//    filesystem still works as the source of truth.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GIT_REMOTE,
  GIT_BRANCH,
  COMMIT_AUTHOR_NAME,
  COMMIT_AUTHOR_EMAIL,
  DISABLE_GIT_SYNC,
} from "../constants.js";
import { ToolError } from "../types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000,
    });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr?.trim() || e.message || "git command failed");
  }
}

/**
 * Pull the latest from origin. Uses --ff-only so a divergence (local
 * changes that conflict with remote) fails loudly instead of creating
 * a merge commit. A clean fast-forward or already-up-to-date both
 * succeed.
 *
 * No-op when DISABLE_GIT_SYNC is true.
 */
export async function pull(cwd: string): Promise<void> {
  if (DISABLE_GIT_SYNC) return;

  // Check for uncommitted local changes first — these would block a pull.
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status) {
    throw new ToolError(
      `The working copy at this vault has uncommitted local changes, so it can't be safely synced. ` +
        `This usually means a previous operation didn't complete. The changes are:\n${status}\n` +
        `Resolve this on the host before continuing (commit, stash, or discard).`
    );
  }
  try {
    await git(cwd, ["pull", "--ff-only", GIT_REMOTE, GIT_BRANCH]);
  } catch (err: unknown) {
    const msg = (err as Error).message || "";
    if (/non-fast-forward|diverge|not possible to fast-forward/i.test(msg)) {
      throw new ToolError(
        `Cannot fast-forward this vault: local and remote histories have diverged. ` +
          `Another device likely pushed changes that conflict with the local checkout. ` +
          `This needs manual reconciliation on the host — I've stopped rather than auto-merge.`
      );
    }
    throw new ToolError(`Failed to sync vault from remote: ${msg}`);
  }
}

/**
 * Stage a specific file, commit it, and push. Stop-and-report if the
 * push is rejected (someone else pushed between our pull and push).
 *
 * Returns the short commit hash, or "no-change" if the file's content
 * was unchanged.
 *
 * When DISABLE_GIT_SYNC is true, this still commits locally but skips
 * the push. The returned hash is the local commit.
 */
export async function commitAndPush(
  cwd: string,
  relPath: string,
  message: string
): Promise<string> {
  await git(cwd, ["add", "--", relPath]);

  // Nothing staged? Then the write was a no-op (content identical).
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged) {
    return "no-change";
  }

  await git(cwd, [
    "-c",
    `user.name=${COMMIT_AUTHOR_NAME}`,
    "-c",
    `user.email=${COMMIT_AUTHOR_EMAIL}`,
    "commit",
    "-m",
    message,
  ]);

  if (!DISABLE_GIT_SYNC) {
    try {
      await git(cwd, ["push", GIT_REMOTE, GIT_BRANCH]);
    } catch (err: unknown) {
      const msg = (err as Error).message || "";
      if (/non-fast-forward|rejected|fetch first/i.test(msg)) {
        throw new ToolError(
          `Commit was made locally but the push was rejected — the remote moved (another device pushed) ` +
            `between sync and push. The local commit exists but is NOT on the remote yet. ` +
            `This needs manual reconciliation on the host; I've stopped rather than force-push or auto-merge.`
        );
      }
      throw new ToolError(`Commit succeeded but push failed: ${msg}`);
    }
  }

  return await git(cwd, ["rev-parse", "--short", "HEAD"]);
}
