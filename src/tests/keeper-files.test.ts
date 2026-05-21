import test from "node:test";
import assert from "node:assert/strict";
import { validateCodexReport } from "../state/keeper-files.js";

test("validates codex report schema", () => {
  assert.doesNotThrow(() =>
    validateCodexReport(
      {
        cycleId: "001",
        taskTitle: "Task",
        status: "completed",
        summary: "Done",
        filesChanged: [],
        testsRun: [],
        commitHash: null,
        remainingWork: [],
        blockers: [],
        nextSuggestedTask: null,
      },
      "001",
    ),
  );
});

test("rejects mismatched cycle report", () => {
  assert.throws(() =>
    validateCodexReport(
      {
        cycleId: "002",
        taskTitle: "Task",
        status: "completed",
        summary: "Done",
        filesChanged: [],
        testsRun: [],
        commitHash: null,
        remainingWork: [],
        blockers: [],
        nextSuggestedTask: null,
      },
      "001",
    ),
  );
});

test("rejects mismatched task title", () => {
  assert.throws(() =>
    validateCodexReport(
      {
        cycleId: "001",
        taskTitle: "Other",
        status: "completed",
        summary: "Done",
        filesChanged: [],
        testsRun: [],
        commitHash: null,
        remainingWork: [],
        blockers: [],
        nextSuggestedTask: null,
      },
      "001",
      "Expected",
    ),
  );
});

test("rejects malformed testsRun item", () => {
  assert.throws(() =>
    validateCodexReport(
      {
        cycleId: "001",
        taskTitle: "Task",
        status: "completed",
        summary: "Done",
        filesChanged: [],
        testsRun: [{ command: "npm test", status: "weird", outputSummary: "bad" } as never],
        commitHash: null,
        remainingWork: [],
        blockers: [],
        nextSuggestedTask: null,
      },
      "001",
    ),
  );
});
