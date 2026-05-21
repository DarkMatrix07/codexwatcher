import test from "node:test";
import assert from "node:assert/strict";
import { resolveRepoFromHint } from "../workspace/workspace.js";

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
