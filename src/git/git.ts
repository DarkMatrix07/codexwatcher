import { runCommand } from "../exec.js";
import type { CommandResult } from "../types.js";

export type GitSnapshot = {
  status: string;
  diff: string;
  lastCommit: string | null;
};

export async function getGitSnapshot(repoPath: string): Promise<GitSnapshot> {
  const [status, diff, lastCommit] = await Promise.all([
    runGit(repoPath, ["status", "--short"], 30_000),
    runGit(repoPath, ["diff", "--stat"], 30_000),
    runGit(repoPath, ["rev-parse", "--short", "HEAD"], 30_000),
  ]);
  return {
    status: status.stdout.trim(),
    diff: diff.stdout.trim(),
    lastCommit: lastCommit.exitCode === 0 ? lastCommit.stdout.trim() : null,
  };
}

export async function commitAll(repoPath: string, message: string, paths?: string[]): Promise<string | null> {
  const status = await runGit(repoPath, ["status", "--short"], 30_000);
  if (!status.stdout.trim()) {
    return await currentCommit(repoPath);
  }
  await ensureGitIdentity(repoPath);
  const safePaths = sanitizeGitPaths(paths);
  if (safePaths.length) {
    await runGit(repoPath, ["add", "-A", "--", ...safePaths], 60_000);
  } else {
    await runGit(repoPath, ["add", "-A"], 60_000);
  }
  const staged = await runGit(repoPath, ["diff", "--cached", "--quiet"], 30_000);
  if (staged.exitCode === 0) {
    return await currentCommit(repoPath);
  }
  const commit = await runGit(repoPath, ["commit", "-m", message], 120_000);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  return await currentCommit(repoPath);
}

function sanitizeGitPaths(paths: string[] | undefined): string[] {
  const seen = new Set<string>();
  const safe: string[] = [];
  for (const raw of paths ?? []) {
    const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!normalized || normalized === "." || normalized.includes("\0")) continue;
    if (normalized.split("/").includes("..")) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    safe.push(normalized);
  }
  return safe;
}

export async function currentCommit(repoPath: string): Promise<string | null> {
  const result = await runGit(repoPath, ["rev-parse", "--short", "HEAD"], 30_000);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function ensureGitIdentity(repoPath: string): Promise<void> {
  const [name, email] = await Promise.all([
    runGit(repoPath, ["config", "--get", "user.name"], 30_000),
    runGit(repoPath, ["config", "--get", "user.email"], 30_000),
  ]);
  if (name.exitCode !== 0 || !name.stdout.trim()) {
    await runGit(repoPath, ["config", "user.name", "CodexWatcher"], 30_000);
  }
  if (email.exitCode !== 0 || !email.stdout.trim()) {
    await runGit(repoPath, ["config", "user.email", "codexwatcher@example.local"], 30_000);
  }
}

function runGit(repoPath: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return runCommand("git", ["-c", `safe.directory=${safeDirectoryPath(repoPath)}`, ...args], {
    cwd: repoPath,
    timeoutMs,
  });
}

function safeDirectoryPath(repoPath: string): string {
  return repoPath.replace(/\\/g, "/");
}
