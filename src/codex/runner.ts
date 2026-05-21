import path from "node:path";
import { runCommand } from "../exec.js";
import type { CommandResult } from "../types.js";

export type CodexRunResult = CommandResult & {
  sessionId?: string;
  resumeFallbackUsed?: boolean;
};

export function buildCodexArgs(params: { sessionId?: string; useLastResume?: boolean }): string[] {
  if (params.sessionId) return ["exec", "--json", "resume", params.sessionId, "-"];
  if (params.useLastResume) return ["exec", "--json", "resume", "--last", "-"];
  return ["exec", "--json", "-"];
}

export async function runCodex(repoPath: string, prompt: string, sessionId?: string): Promise<CodexRunResult> {
  let result = await runCommand("codex", buildCodexArgs({ sessionId }), {
    cwd: repoPath,
    input: prompt,
    timeoutMs: 45 * 60_000,
  });
  let resumeFallbackUsed = false;
  if (sessionId && result.exitCode !== 0) {
    resumeFallbackUsed = true;
    result = await runCommand("codex", buildCodexArgs({ useLastResume: true }), {
      cwd: repoPath,
      input: prompt,
      timeoutMs: 45 * 60_000,
    });
  }
  const parsedSessionId = extractSessionId(`${result.stdout}\n${result.stderr}`);
  return {
    ...result,
    sessionId: parsedSessionId ?? (resumeFallbackUsed ? undefined : sessionId),
    resumeFallbackUsed,
  };
}

export function buildCodexPrompt(input: {
  cycleId: string;
  taskTitle: string;
  taskPrompt: string;
  quotaMode: "work" | "caution";
}): string {
  const reportPath = path.posix.join(".keeper", "cycles", input.cycleId, "codex-report.json");
  return `You are Codex working under CodexWatcher.

Before coding, read:
- .keeper/task.md
- .keeper/plan.md
- .keeper/progress.md
- .keeper/memory.md
- git status
- git log --oneline -5

Current task:
${input.taskTitle}

Task instructions:
${input.taskPrompt}

Quota mode: ${input.quotaMode}
${input.quotaMode === "caution" ? "Keep this change especially small. Preserve a clear resume note before risky work." : ""}

Rules:
- Work only on the current task.
- Do not repeat completed work from .keeper/progress.md.
- Update .keeper/progress.md and .keeper/memory.md.
- Run relevant validation if available.
- Commit completed safe progress when possible.
- Stop after this task or the smallest safe checkpoint.

Before you stop, write a machine-readable report to ${reportPath}.
Use this exact JSON shape:
{
  "cycleId": "${input.cycleId}",
  "taskTitle": "${escapeJson(input.taskTitle)}",
  "status": "completed | partial | blocked | failed",
  "summary": "...",
  "filesChanged": [],
  "testsRun": [
    { "command": "...", "status": "passed | failed | skipped", "outputSummary": "..." }
  ],
  "commitHash": null,
  "remainingWork": [],
  "blockers": [],
  "nextSuggestedTask": null
}
`;
}

function extractSessionId(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = findUuid(parsed);
      if (id) return id;
    } catch {
      const id = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (id) return id;
    }
  }
  return undefined;
}

function findUuid(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  }
  if (!value || typeof value !== "object") return undefined;
  for (const nested of Object.values(value)) {
    const id = findUuid(nested);
    if (id) return id;
  }
  return undefined;
}

function escapeJson(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
