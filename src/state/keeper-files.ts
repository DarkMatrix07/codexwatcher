import { mkdir, readFile, writeFile, appendFile, access } from "node:fs/promises";
import path from "node:path";
import type { AgentReview, CodexReport, KeeperState } from "../types.js";

export function keeperDir(repoPath: string): string {
  return path.join(repoPath, ".keeper");
}

export function cycleDir(repoPath: string, cycleId: string): string {
  return path.join(keeperDir(repoPath), "cycles", cycleId);
}

export async function ensureKeeperFiles(repoPath: string): Promise<void> {
  const dir = keeperDir(repoPath);
  await mkdir(path.join(dir, "cycles"), { recursive: true });
  await ensureFile(path.join(dir, "task.md"), "# Task\n\n");
  await ensureFile(path.join(dir, "plan.md"), "# Plan\n\n");
  await ensureFile(path.join(dir, "progress.md"), "# Progress\n\n");
  await ensureFile(path.join(dir, "memory.md"), "# Memory\n\n");
  await ensureFile(path.join(dir, "prompts.md"), "# Codex Prompts\n\n");
  await ensureFile(path.join(dir, "responses.md"), "# Codex Responses\n\n");
}

async function ensureFile(filePath: string, initial: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, initial, "utf8");
  }
}

export async function readKeeperFile(repoPath: string, name: string): Promise<string> {
  return await readFile(path.join(keeperDir(repoPath), name), "utf8");
}

export async function writeKeeperFile(repoPath: string, name: string, content: string): Promise<void> {
  await ensureKeeperFiles(repoPath);
  await writeFile(path.join(keeperDir(repoPath), name), content, "utf8");
}

export async function appendKeeperFile(repoPath: string, name: string, content: string): Promise<void> {
  await ensureKeeperFiles(repoPath);
  await appendFile(path.join(keeperDir(repoPath), name), content, "utf8");
}

export async function loadState(repoPath: string): Promise<KeeperState | null> {
  try {
    return JSON.parse(await readFile(path.join(keeperDir(repoPath), "state.json"), "utf8")) as KeeperState;
  } catch {
    return null;
  }
}

export async function saveState(repoPath: string, state: KeeperState): Promise<void> {
  await ensureKeeperFiles(repoPath);
  await writeFile(path.join(keeperDir(repoPath), "state.json"), JSON.stringify(state, null, 2), "utf8");
}

export async function saveCyclePrompt(repoPath: string, cycleId: string, prompt: string): Promise<void> {
  const dir = cycleDir(repoPath, cycleId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "prompt.md"), prompt, "utf8");
  await appendKeeperFile(
    repoPath,
    "prompts.md",
    `\n## Cycle ${cycleId}\n\nStarted: ${new Date().toISOString()}\n\n\`\`\`text\n${prompt}\n\`\`\`\n`,
  );
}

export async function saveCycleOutput(repoPath: string, cycleId: string, output: string): Promise<void> {
  const dir = cycleDir(repoPath, cycleId);
  const safeOutput = redactSecrets(output);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "codex-output.log"), safeOutput, "utf8");
  await appendKeeperFile(
    repoPath,
    "responses.md",
    `\n## Cycle ${cycleId}\n\n\`\`\`text\n${truncate(safeOutput, 12000)}\n\`\`\`\n`,
  );
}

export async function loadCodexReport(repoPath: string, cycleId: string, expectedTaskTitle?: string): Promise<CodexReport> {
  const report = JSON.parse(
    await readFile(path.join(cycleDir(repoPath, cycleId), "codex-report.json"), "utf8"),
  ) as CodexReport;
  validateCodexReport(report, cycleId, expectedTaskTitle);
  return report;
}

export async function saveAgentReview(repoPath: string, cycleId: string, review: AgentReview): Promise<void> {
  await writeFile(
    path.join(cycleDir(repoPath, cycleId), "agent-review.json"),
    JSON.stringify(review, null, 2),
    "utf8",
  );
}

export function validateCodexReport(report: CodexReport, expectedCycleId?: string, expectedTaskTitle?: string): void {
  const statuses = new Set(["completed", "partial", "blocked", "failed"]);
  if (expectedCycleId && report.cycleId !== expectedCycleId) {
    throw new Error(`Codex report cycleId "${report.cycleId}" did not match "${expectedCycleId}".`);
  }
  if (!report.taskTitle || !statuses.has(report.status)) {
    throw new Error("Codex report is missing taskTitle or has an invalid status.");
  }
  if (expectedTaskTitle && report.taskTitle !== expectedTaskTitle) {
    throw new Error(`Codex report taskTitle "${report.taskTitle}" did not match "${expectedTaskTitle}".`);
  }
  if (typeof report.summary !== "string") {
    throw new Error("Codex report summary must be a string.");
  }
  if (!Array.isArray(report.filesChanged) || !Array.isArray(report.testsRun)) {
    throw new Error("Codex report filesChanged and testsRun must be arrays.");
  }
  if (!Array.isArray(report.remainingWork) || !Array.isArray(report.blockers)) {
    throw new Error("Codex report remainingWork and blockers must be arrays.");
  }
  for (const test of report.testsRun) {
    if (
      !test ||
      typeof test.command !== "string" ||
      !["passed", "failed", "skipped"].includes(test.status) ||
      typeof test.outputSummary !== "string"
    ) {
      throw new Error("Codex report testsRun items must include command, status, and outputSummary.");
    }
  }
}

export function nextCycleId(state: KeeperState | null): string {
  const previous = Number(state?.lastCycleId ?? 0);
  return String(previous + 1).padStart(3, "0");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function redactSecrets(value: string): string {
  let redacted = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key)) continue;
    redacted = redacted.split(secret).join(`[REDACTED:${key}]`);
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [REDACTED]")
    .replace(/(sk|ccs|ghp|gho|xox[baprs]?)-[A-Za-z0-9_-]{12,}/g, "$1-[REDACTED]");
}
