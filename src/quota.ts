import type { CodexUsage, QuotaDecision } from "./types.js";

export function decideQuota(
  usage: CodexUsage,
  thresholds: { cautionThresholdPercent: number; pauseThresholdPercent: number },
): QuotaDecision {
  if (usage.source === "unavailable" || (usage.primaryUsedPercent === null && usage.secondaryUsedPercent === null)) {
    return {
      mode: "sleep",
      usage,
      wakeAt: null,
      note: `Codex usage is unavailable${usage.error ? `: ${usage.error}` : ""}. I will not start Codex work until usage can be checked.`,
    };
  }
  const used = usage.primaryUsedPercent ?? usage.secondaryUsedPercent ?? 0;
  if (used >= thresholds.pauseThresholdPercent) {
    return {
      mode: "sleep",
      usage,
      wakeAt: usage.primaryResetAt ?? usage.secondaryResetAt,
      note: `Codex usage is ${used}%, at or above the ${thresholds.pauseThresholdPercent}% pause threshold.`,
    };
  }
  if (used >= thresholds.cautionThresholdPercent) {
    return {
      mode: "caution",
      usage,
      note: `Codex usage is ${used}%, so the next Codex prompt should be smaller and resume notes should be stronger.`,
    };
  }
  return { mode: "work", usage };
}
