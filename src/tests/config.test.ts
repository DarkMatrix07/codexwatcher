import test from "node:test";
import assert from "node:assert/strict";
import { resolveSecret } from "../config.js";

test("resolveSecret reads env var references", () => {
  process.env.TEST_CODEXWATCHER_SECRET = "actual";
  assert.equal(resolveSecret("TEST_CODEXWATCHER_SECRET"), "actual");
});

test("resolveSecret keeps literal values", () => {
  assert.equal(resolveSecret("literal-value"), "literal-value");
});
