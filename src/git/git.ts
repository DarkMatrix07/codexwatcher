import { runCommand } from "../exec.js";

export type GitSnapshot = {
  status: string;
  diff: string;
  lastCommit: string | null;
};

export async function getGitSnapshot(repoPath: string): Promise<GitSnapshot> {
  const [status, diff, lastCommit] = await Promise.all([
    runCommand("git", ["status", "--short"], { cwd: repoPath, timeoutMs: 30_000 }),
    runCommand("git", ["diff", "--stat"], { cwd: repoPath, timeoutMs: 30_000 }),
    runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath, timeoutMs: 30_000 }),
  ]);
  return {
    status: status.stdout.trim(),
    diff: diff.stdout.trim(),
    lastCommit: lastCommit.exitCode === 0 ? lastCommit.stdout.trim() : null,
  };
}

export async function commitAll(repoPath: string, message: string, paths?: string[]): Promise<string | null> {
  const status = await runCommand("git", ["status", "--short"], { cwd: repoPath, timeoutMs: 30_000 });
  if (!status.stdout.trim()) {
    return await currentCommit(repoPath);
  }
  await ensureGitIdentity(repoPath);
  const safePaths = sanitizeGitPaths(paths);
  if (safePaths.length) {
    await runCommand("git", ["add", "-A", "--", ...safePaths], { cwd: repoPath, timeoutMs: 60_000 });
  } else {
    await runCommand("git", ["add", "-A"], { cwd: repoPath, timeoutMs: 60_000 });
  }
  const staged = await runCommand("git", ["diff", "--cached", "--quiet"], { cwd: repoPath, timeoutMs: 30_000 });
  if (staged.exitCode === 0) {
    return await currentCommit(repoPath);
  }
  const commit = await runCommand("git", ["commit", "-m", message], { cwd: repoPath, timeoutMs: 120_000 });
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
  const result = await runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath, timeoutMs: 30_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function ensureGitIdentity(repoPath: string): Promise<void> {
  const [name, email] = await Promise.all([
    runCommand("git", ["config", "--get", "user.name"], { cwd: repoPath, timeoutMs: 30_000 }),
    runCommand("git", ["config", "--get", "user.email"], { cwd: repoPath, timeoutMs: 30_000 }),
  ]);
  if (name.exitCode !== 0 || !name.stdout.trim()) {
    await runCommand("git", ["config", "user.name", "CodexWatcher"], { cwd: repoPath, timeoutMs: 30_000 });
  }
  if (email.exitCode !== 0 || !email.stdout.trim()) {
    await runCommand("git", ["config", "user.email", "codexwatcher@example.local"], {
      cwd: repoPath,
      timeoutMs: 30_000,
    });
  }
}
