import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, buildCodexPrompt } from "../codex/runner.js";

test("builds fresh codex exec args", () => {
  assert.deepEqual(buildCodexArgs({}), ["exec", "--json", "-"]);
});

test("builds session resume args", () => {
  assert.deepEqual(buildCodexArgs({ sessionId: "abc" }), ["exec", "--json", "resume", "abc", "-"]);
});

test("builds sandboxed codex exec args", () => {
  assert.deepEqual(buildCodexArgs({ sandboxMode: "workspace-write" }), [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-",
  ]);
});

test("prompt requires report path", () => {
  const prompt = buildCodexPrompt({
    cycleId: "001",
    taskTitle: "Do work",
    taskPrompt: "Implement it",
    quotaMode: "work",
  });
  assert.match(prompt, /\.keeper\/cycles\/001\/codex-report\.json/);
});
