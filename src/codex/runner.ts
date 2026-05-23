import path from "node:path";
import { runCommand } from "../exec.js";
import type { CommandResult } from "../types.js";

export type CodexRunResult = CommandResult & {
  sessionId?: string;
  resumeFallbackUsed?: boolean;
};

export type CodexRunnerOptions = {
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
};

export function buildCodexArgs(params: {
  sessionId?: string;
  useLastResume?: boolean;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
}): string[] {
  const args = ["exec", "--json"];
  if (params.sandboxMode) args.push("--sandbox", params.sandboxMode);
  if (params.sessionId) return [...args, "resume", params.sessionId, "-"];
  if (params.useLastResume) return [...args, "resume", "--last", "-"];
  return [...args, "-"];
}

export async function runCodex(
  repoPath: string,
  prompt: string,
  sessionId?: string,
  options: CodexRunnerOptions = {},
): Promise<CodexRunResult> {
  const command = process.env.CODEXWATCHER_CODEX_COMMAND || "codex";
  const prefixArgs = parseCodexArgsPrefix(process.env.CODEXWATCHER_CODEX_ARGS_PREFIX);
  const result = await runCommand(command, [...prefixArgs, ...buildCodexArgs({ sessionId, sandboxMode: options.sandboxMode })], {
    cwd: repoPath,
    input: prompt,
    timeoutMs: 45 * 60_000,
  });
  const parsedSessionId = extractSessionId(`${result.stdout}\n${result.stderr}`);
  return {
    ...result,
    sessionId: parsedSessionId ?? sessionId,
    resumeFallbackUsed: false,
  };
}

function parseCodexArgsPrefix(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall through to whitespace splitting for simple local overrides.
  }
  return raw.split(/\s+/).filter(Boolean);
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
${input.quotaMode === "caution" ? "Avoid dependency installs, broad refactors, generated assets, and full-suite runs unless essential. Prefer the cheapest targeted validation." : ""}

Metadata rule:
- User file restrictions apply to project/source files outside .keeper.
- You must still read/write the required .keeper files listed here, even if task wording says to edit only a specific project file.
- If task wording conflicts with required .keeper reporting, keep the project/source change narrow and complete the .keeper reporting.

Rules:
- Work only on the current task.
- Do not repeat completed work from .keeper/progress.md.
- Update .keeper/progress.md and .keeper/memory.md.
- Run relevant validation if available.
- Do not create git commits. CodexWatcher will commit after the report passes review.
- Stop after this task or the smallest safe checkpoint.
- If this is an understand/analyze/inspect task without an explicit change request, do not modify project/source files. Update only .keeper progress, memory, and report files with a concise architecture/status summary.

Before you stop, write a machine-readable report to ${reportPath}.
Report only facts you verified. Do not invent test results. Use "completed" only when the requested work is fully done and validation passed or was explicitly unnecessary. If work remains or validation failed, use "partial", "blocked", or "failed".
Use this exact JSON shape, choosing one concrete status value:
{
  "cycleId": "${input.cycleId}",
  "taskTitle": "${escapeJson(input.taskTitle)}",
  "status": "completed",
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
