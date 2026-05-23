import { mkdir, readdir, stat, access } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../exec.js";

export type RepoCandidate = {
  id: string;
  name: string;
  path: string;
};

export async function discoverRepos(workspaceRoots: string[]): Promise<RepoCandidate[]> {
  const repos: RepoCandidate[] = [];
  for (const root of workspaceRoots) {
    await discoverReposUnder(path.resolve(root), repos, 0);
  }
  return dedupeRepos(repos);
}

async function discoverReposUnder(dir: string, repos: RepoCandidate[], depth: number): Promise<void> {
  if (depth > 3) return;
  if (await isGitRepo(dir)) {
    repos.push({
      id: path.basename(dir).toLowerCase(),
      name: path.basename(dir),
      path: dir,
    });
    return;
  }
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith(".")) continue;
    const child = path.join(dir, entry);
    try {
      if ((await stat(child)).isDirectory()) {
        await discoverReposUnder(child, repos, depth + 1);
      }
    } catch {
      // Ignore unreadable folders.
    }
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function resolveRepoFromHint(repos: RepoCandidate[], hint: string | undefined): {
  repo?: RepoCandidate;
  matches: RepoCandidate[];
  reason?: string;
} {
  if (!hint?.trim()) {
    return { matches: [], reason: "No project name was provided." };
  }
  const normalized = normalize(hint);
  const exact = repos.filter((repo) => normalize(repo.name) === normalized || normalize(repo.id) === normalized);
  if (exact.length === 1) return { repo: exact[0], matches: exact };
  if (exact.length > 1) return { matches: exact, reason: "Multiple projects match exactly." };
  const fuzzy = repos.filter((repo) => normalize(repo.name).includes(normalized) || normalized.includes(normalize(repo.name)));
  if (fuzzy.length === 1) return { repo: fuzzy[0], matches: fuzzy };
  return {
    matches: fuzzy,
    reason: fuzzy.length > 1 ? "Multiple projects match that name." : "I could not find a matching project.",
  };
}

export function extractGitUrl(text: string): string | null {
  const match = text.match(/\b(?:https?:\/\/|git@|ssh:\/\/|file:\/\/)[^\s<>"']+/i);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/g, "");
}

export function extractBranchHint(text: string): string | null {
  const patterns = [
    /\bbranch\s+([A-Za-z0-9._/-]{1,200})\b/i,
    /\b(?:checkout|switch\s+to)\s+(?!https?:|git@|ssh:)([A-Za-z0-9._/-]{1,200})\b/i,
    /\b(?:from|on)\s+branch\s+([A-Za-z0-9._/-]{1,200})\b/i,
  ];
  for (const pattern of patterns) {
    const candidate = pattern.exec(text)?.[1]?.replace(/[),.;]+$/g, "");
    if (candidate && isSafeBranchName(candidate)) return candidate;
  }
  return null;
}

export function repoNameFromGitUrl(url: string): string {
  const withoutTrailing = url.replace(/[),.;]+$/g, "").replace(/\/+$/g, "");
  const last = withoutTrailing.split(/[/:\\]/).filter(Boolean).at(-1) ?? "repo";
  const withoutGit = last.replace(/\.git$/i, "");
  const safe = withoutGit.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return safe || "repo";
}

export async function cloneRepoIntoWorkspace(workspaceRoot: string, gitUrl: string, branch?: string | null): Promise<{
  repo: RepoCandidate;
  cloned: boolean;
}> {
  if (branch && !isSafeBranchName(branch)) {
    throw new Error("The requested branch name is not safe to check out.");
  }
  const root = path.resolve(workspaceRoot);
  await mkdir(root, { recursive: true });
  const name = repoNameFromGitUrl(gitUrl);
  const target = path.join(root, name);
  if (await exists(target)) {
    if (await isGitRepo(target)) {
      const remote = await runCommand("git", ["remote", "get-url", "origin"], { cwd: target, timeoutMs: 30_000 });
      const currentUrl = remote.exitCode === 0 ? remote.stdout.trim() : "";
      if (currentUrl && normalizeGitUrl(currentUrl) !== normalizeGitUrl(gitUrl)) {
        throw new Error(`A different git repo already exists at ${target}. Existing origin: ${redactGitUrl(currentUrl)}`);
      }
      if (branch) await checkoutBranch(target, branch);
      return {
        cloned: false,
        repo: { id: name.toLowerCase(), name, path: target },
      };
    }
    throw new Error(`Target path already exists and is not a git repo: ${target}`);
  }
  const result = await runCommand("git", ["clone", ...(branch ? ["--branch", branch] : []), gitUrl, target], {
    cwd: root,
    timeoutMs: 10 * 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git clone failed: ${redactGitUrl(result.stderr || result.stdout)}`);
  }
  return {
    cloned: true,
    repo: { id: name.toLowerCase(), name, path: target },
  };
}

async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  const checkout = await runCommand("git", ["checkout", branch], { cwd: repoPath, timeoutMs: 60_000 });
  if (checkout.exitCode === 0) return;
  await runCommand("git", ["fetch", "origin", branch], { cwd: repoPath, timeoutMs: 120_000 });
  const tracking = await runCommand("git", ["checkout", "-B", branch, `origin/${branch}`], {
    cwd: repoPath,
    timeoutMs: 60_000,
  });
  if (tracking.exitCode !== 0) {
    throw new Error(`Could not check out branch ${branch}: ${redactGitUrl(tracking.stderr || tracking.stdout)}`);
  }
}

function isSafeBranchName(branch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.endsWith(".lock")
  );
}

function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function redactGitUrl(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+)@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^/:@\s]+:)([^/@\s]+)@/gi, "$1[REDACTED]@");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function dedupeRepos(repos: RepoCandidate[]): RepoCandidate[] {
  const seen = new Set<string>();
  return repos.filter((repo) => {
    const key = path.resolve(repo.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
