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
  const windows = [
    { used: usage.primaryUsedPercent, resetAt: usage.primaryResetAt },
    { used: usage.secondaryUsedPercent, resetAt: usage.secondaryResetAt },
  ].filter((window): window is { used: number; resetAt: string | null } => window.used !== null);
  const limiting = windows.reduce((max, window) => (window.used > max.used ? window : max), windows[0]);
  const used = limiting.used;
  if (used >= thresholds.pauseThresholdPercent) {
    return {
      mode: "sleep",
      usage,
      wakeAt: limiting.resetAt ?? usage.primaryResetAt ?? usage.secondaryResetAt,
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
