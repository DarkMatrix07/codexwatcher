import test from "node:test";
import assert from "node:assert/strict";
import { decideQuota } from "../quota.js";
import type { CodexUsage } from "../types.js";

const baseUsage: CodexUsage = {
  source: "oauth",
  primaryUsedPercent: null,
  primaryResetAt: null,
  secondaryUsedPercent: null,
  secondaryResetAt: null,
  creditsBalance: null,
  plan: null,
};

test("quota decision works below caution threshold", () => {
  assert.equal(decideQuota({ ...baseUsage, primaryUsedPercent: 42 }, thresholds()).mode, "work");
});

test("quota decision enters caution mode", () => {
  assert.equal(decideQuota({ ...baseUsage, primaryUsedPercent: 75 }, thresholds()).mode, "caution");
});

test("quota decision enters sleep mode", () => {
  assert.equal(decideQuota({ ...baseUsage, primaryUsedPercent: 91 }, thresholds()).mode, "sleep");
});

test("quota decision uses the highest usage window", () => {
  const decision = decideQuota(
    {
      ...baseUsage,
      primaryUsedPercent: 10,
      primaryResetAt: "2026-01-01T00:00:00.000Z",
      secondaryUsedPercent: 95,
      secondaryResetAt: "2026-01-02T00:00:00.000Z",
    },
    thresholds(),
  );
  assert.equal(decision.mode, "sleep");
  assert.equal(decision.mode === "sleep" ? decision.wakeAt : null, "2026-01-02T00:00:00.000Z");
});

test("quota decision sleeps when usage is unavailable", () => {
  assert.equal(decideQuota({ ...baseUsage, source: "unavailable", error: "no auth" }, thresholds()).mode, "sleep");
});

function thresholds() {
  return { cautionThresholdPercent: 70, pauseThresholdPercent: 90 };
}
