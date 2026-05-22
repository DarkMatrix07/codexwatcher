import test from "node:test";
import assert from "node:assert/strict";
import { checkCodexUsage } from "../codex/usage.js";

test("checkCodexUsage uses fixture when provided", async () => {
  const previous = process.env.CODEXWATCHER_USAGE_FIXTURE;
  process.env.CODEXWATCHER_USAGE_FIXTURE = JSON.stringify({
    source: "oauth",
    primaryUsedPercent: 88,
    primaryResetAt: "2026-05-26T16:59:55.000Z",
    plan: "fixture",
  });
  try {
    const usage = await checkCodexUsage();
    assert.equal(usage.source, "oauth");
    assert.equal(usage.primaryUsedPercent, 88);
    assert.equal(usage.primaryResetAt, "2026-05-26T16:59:55.000Z");
    assert.equal(usage.plan, "fixture");
  } finally {
    if (previous === undefined) {
      delete process.env.CODEXWATCHER_USAGE_FIXTURE;
    } else {
      process.env.CODEXWATCHER_USAGE_FIXTURE = previous;
    }
  }
});
