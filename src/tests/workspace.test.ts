import test from "node:test";
import assert from "node:assert/strict";
import { extractGitUrl, repoNameFromGitUrl, resolveRepoFromHint } from "../workspace/workspace.js";

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
