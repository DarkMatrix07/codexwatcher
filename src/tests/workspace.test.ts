import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../exec.js";
import { cloneRepoIntoWorkspace, extractGitUrl, repoNameFromGitUrl, resolveRepoFromHint } from "../workspace/workspace.js";

const repos = [
  { id: "ecommerce-app", name: "ecommerce-app", path: "/tmp/ecommerce-app" },
  { id: "crm-dashboard", name: "crm-dashboard", path: "/tmp/crm-dashboard" },
];

test("resolves exact repo names", () => {
  assert.equal(resolveRepoFromHint(repos, "ecommerce-app").repo?.name, "ecommerce-app");
});

test("resolves fuzzy repo names", () => {
  assert.equal(resolveRepoFromHint(repos, "crm").repo?.name, "crm-dashboard");
});

test("returns reason when project is missing", () => {
  const result = resolveRepoFromHint(repos, "unknown");
  assert.equal(result.repo, undefined);
  assert.ok(result.reason);
});

test("extracts git URLs from natural language", () => {
  assert.equal(
    extractGitUrl("clone https://github.com/DarkMatrix07/codexwatcher.git and understand it"),
    "https://github.com/DarkMatrix07/codexwatcher.git",
  );
  assert.equal(extractGitUrl("clone git@github.com:DarkMatrix07/codexwatcher.git"), "git@github.com:DarkMatrix07/codexwatcher.git");
});

test("derives safe repo names from git URLs", () => {
  assert.equal(repoNameFromGitUrl("https://github.com/DarkMatrix07/codexwatcher.git"), "codexwatcher");
  assert.equal(repoNameFromGitUrl("file:///tmp/demo-source.git"), "demo-source");
});

test("cloneRepoIntoWorkspace rejects basename collisions with different origins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexwatcher-workspace-"));
  const workspace = path.join(root, "workspace");
  const first = await createGitSource(root, "one", "api");
  const second = await createGitSource(root, "two", "api");
  await cloneRepoIntoWorkspace(workspace, `file://${first}`);
  await assert.rejects(() => cloneRepoIntoWorkspace(workspace, `file://${second}`), /different git repo already exists/);
});

async function createGitSource(root: string, owner: string, name: string): Promise<string> {
  const repo = path.join(root, owner, name);
  await mkdir(repo, { recursive: true });
  await runCommand("git", ["init", "-q"], { cwd: repo, timeoutMs: 30_000 });
  await runCommand("git", ["config", "user.email", "test@example.local"], { cwd: repo, timeoutMs: 30_000 });
  await runCommand("git", ["config", "user.name", "Workspace Test"], { cwd: repo, timeoutMs: 30_000 });
  await writeFile(path.join(repo, "README.md"), `# ${owner}/${name}\n`, "utf8");
  await runCommand("git", ["add", "-A"], { cwd: repo, timeoutMs: 30_000 });
  await runCommand("git", ["commit", "-q", "-m", "initial"], { cwd: repo, timeoutMs: 30_000 });
  return repo;
}
