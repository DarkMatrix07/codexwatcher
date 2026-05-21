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

export async function commitAll(repoPath: string, message: string): Promise<string | null> {
  const status = await runCommand("git", ["status", "--short"], { cwd: repoPath, timeoutMs: 30_000 });
  if (!status.stdout.trim()) {
    return await currentCommit(repoPath);
  }
  await runCommand("git", ["add", "-A"], { cwd: repoPath, timeoutMs: 60_000 });
  const commit = await runCommand("git", ["commit", "-m", message], { cwd: repoPath, timeoutMs: 120_000 });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  return await currentCommit(repoPath);
}

export async function currentCommit(repoPath: string): Promise<string | null> {
  const result = await runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath, timeoutMs: 30_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}
