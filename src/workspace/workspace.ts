import { readdir, stat, access } from "node:fs/promises";
import path from "node:path";

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

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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
