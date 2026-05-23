import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexKeeperApp } from "../app.js";
import type { BrainClient } from "../brain/brain-client.js";
import { CycleRunner } from "../cycle/cycle-runner.js";
import { runCommand } from "../exec.js";
import { currentCommit } from "../git/git.js";
import { loadState } from "../state/keeper-files.js";
import type { AgentReview, BrainIntent, BrainPlan, KeeperConfig } from "../types.js";

type HarnessResult = {
  name: string;
  passed: boolean;
  details: string[];
};

type HarnessContext = {
  root: string;
  workspaceRoot: string;
  mockBin: string;
  argsLog: string;
  previousPath: string | undefined;
  previousCwd: string;
  previousUsageFixture: string | undefined;
  previousCodexCommand: string | undefined;
  previousCodexArgsPrefix: string | undefined;
};

const FIXTURE_RESET = "2026-05-26T16:59:55.000Z";
const MOCK_SESSION_ID = "33333333-3333-4333-8333-333333333333";

export async function runCoreHarness(): Promise<void> {
  const context = await createHarnessContext();
  const results: HarnessResult[] = [];
  try {
    await installMockCodex(context);
    process.chdir(context.root);
    process.env.PATH = `${context.mockBin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.CODEXWATCHER_CODEX_COMMAND = process.execPath;
    process.env.CODEXWATCHER_CODEX_ARGS_PREFIX = JSON.stringify([path.join(context.mockBin, "mock-codex.js")]);
    results.push(await testQuotaSleep(context));
    results.push(await testAmbiguousRequests(context));
    results.push(await testMissingReport(context));
    results.push(await testFailedValidationGate(context));
    results.push(await testReviewFailureBlocks(context));
    results.push(await testResumeSession(context));
    results.push(await testDirtyRepoCommitBlock(context));
  } finally {
    restoreHarnessEnv(context);
    if (process.env.CODEXWATCHER_KEEP_HARNESS !== "1") {
      await rm(context.root, { recursive: true, force: true });
    } else {
      console.log(`Keeping harness workspace: ${context.root}`);
    }
  }

  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
    for (const detail of result.details) console.log(`  - ${detail}`);
  }
  if (failed.length) {
    throw new Error(`${failed.length} harness scenario(s) failed.`);
  }
}

async function testQuotaSleep(context: HarnessContext): Promise<HarnessResult> {
  const repo = await createRepo(context, "demo-quota-sleep", { "README.md": "# Demo Quota Sleep\n" });
  process.env.CODEXWATCHER_USAGE_FIXTURE = usageFixture(88);
  const notifications: string[] = [];
  const runner = createRunner(context, {
    pauseThresholdPercent: 75,
    notify: notifications,
  });

  await runner.startTask({
    chatId: 0,
    repoPath: repo,
    projectId: "demo-quota-sleep",
    taskText: "Update README.md with one harmless line.",
  });

  const state = await loadState(repo);
  const memory = await readFile(path.join(repo, ".keeper", "memory.md"), "utf8");
  return expect("quota sleep", [
    [state?.status === "sleeping", `state is ${state?.status}`],
    [state?.lastKnownUsagePercent === 88, `lastKnownUsagePercent is ${state?.lastKnownUsagePercent}`],
    [memory.includes("pause threshold"), "memory includes quota pause note"],
    [notifications.some((line) => line.includes("Pausing now")), "notified pause"],
  ]);
}

async function testAmbiguousRequests(context: HarnessContext): Promise<HarnessResult> {
  await createRepo(context, "demo-ambiguous", { "README.md": "# Demo Ambiguous\n" });
  const config = createConfig(context);
  const replies: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    replies.push(String(value ?? ""));
  };
  try {
    const app = new CodexKeeperApp(config);
    await app.handleDevMessage("fix it");
    await app.handleDevMessage("demo-ambiguous");
    await app.handleDevMessage("update that");
  } finally {
    console.log = originalLog;
  }
  return expect("ambiguous requests", [
    [replies[0]?.includes("What should I work on"), `first reply: ${replies[0]}`],
    [replies.some((line) => line.includes("Selected demo-ambiguous")), "project can still be selected"],
    [replies.at(-1)?.includes("What should I change in demo-ambiguous") === true, `last reply: ${replies.at(-1)}`],
  ]);
}

async function testMissingReport(context: HarnessContext): Promise<HarnessResult> {
  const repo = await createRepo(context, "demo-missing-report", { "README.md": "# Demo Missing Report\n" });
  process.env.CODEXWATCHER_USAGE_FIXTURE = usageFixture(20);
  process.env.CODEXWATCHER_MOCK_CODEX_MODE = "missing-report";
  const runner = createRunner(context);
  const before = await currentCommit(repo);

  await runner.startTask({
    chatId: 0,
    repoPath: repo,
    projectId: "demo-missing-report",
    taskText: "Update README.md with one line.",
  });

  const state = await loadState(repo);
  const memory = await readFile(path.join(repo, ".keeper", "memory.md"), "utf8");
  const after = await currentCommit(repo);
  return expect("missing report guard", [
    [state?.status === "blocked", `state is ${state?.status}`],
    [state?.codexSessionId === MOCK_SESSION_ID, `session id is ${state?.codexSessionId}`],
    [state?.resumeNote?.includes("without a valid codex-report") === true, `resume note: ${state?.resumeNote}`],
    [memory.includes("Interrupted Cycle"), "memory includes interrupted-cycle note"],
    [before === after, "no commit was created"],
  ]);
}

async function testFailedValidationGate(context: HarnessContext): Promise<HarnessResult> {
  const repo = await createRepo(context, "demo-failing-gate", {
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2),
    "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
    "test/math.test.js":
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\n\ntest("add sums numbers", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  });
  process.env.CODEXWATCHER_USAGE_FIXTURE = usageFixture(20);
  process.env.CODEXWATCHER_MOCK_CODEX_MODE = "failing-report";
  const runner = createRunner(context, { maxRepairCycles: 0 });
  const before = await currentCommit(repo);

  await runner.startTask({
    chatId: 0,
    repoPath: repo,
    projectId: "demo-failing-gate",
    taskText: "Intentionally break add for gate testing.",
  });

  const state = await loadState(repo);
  const review = JSON.parse(await readFile(path.join(repo, ".keeper", "cycles", "001", "agent-review.json"), "utf8")) as AgentReview;
  const after = await currentCommit(repo);
  return expect("failed validation gate", [
    [state?.status === "blocked", `state is ${state?.status}`],
    [review.taskComplete === false, "review marked task incomplete"],
    [review.nextAction === "ask_codex_to_fix", `nextAction is ${review.nextAction}`],
    [before === after, "no commit was created"],
  ]);
}

async function testReviewFailureBlocks(context: HarnessContext): Promise<HarnessResult> {
  const repo = await createRepo(context, "demo-review-failure", { "README.md": "# Demo Review Failure\n" });
  process.env.CODEXWATCHER_USAGE_FIXTURE = usageFixture(20);
  process.env.CODEXWATCHER_MOCK_CODEX_MODE = "resume-success";
  process.env.CODEXWATCHER_HARNESS_REVIEW_THROW = "1";
  const runner = createRunner(context);
  const before = await currentCommit(repo);

  await runner.startTask({
    chatId: 0,
    repoPath: repo,
    projectId: "demo-review-failure",
    taskText: "Update README.md, then simulate review failure.",
  });

  delete process.env.CODEXWATCHER_HARNESS_REVIEW_THROW;
  const state = await loadState(repo);
  const memory = await readFile(path.join(repo, ".keeper", "memory.md"), "utf8");
  const after = await currentCommit(repo);
  return expect("review failure blocks", [
    [state?.status === "blocked", `state is ${state?.status}`],
    [state?.resumeNote?.includes("review failed") === true, `resume note: ${state?.resumeNote}`],
    [memory.includes("Review Failed Cycle"), "memory records review failure"],
    [before === after, "no commit was created"],
  ]);
}

async function testResumeSession(context: HarnessContext): Promise<HarnessResult> {
  const repo = await createRepo(context, "demo-resume-session", { "README.md": "# Demo Resume Session\n" });
  await writeFile(context.argsLog, "", "utf8");
  process.env.CODEXWATCHER_USAGE_FIXTURE = usageFixture(20);
  process.env.CODEXWATCHER_MOCK_CODEX_MODE = "missing-report";
  const runner = createRunner(context);

  await runner.startTask({
    chatId: 0,
    repoPath: repo,
    projectId: "demo-resume-session",
    taskText: "Update README.md to say resume completed through saved session.",
  });

  process.env.CODEXWATCHER_MOCK_CODEX_MODE = "resume-success";
  await runner.runAutoCycles(0, repo, "demo-resume-session");

  const state = await loadState(repo);
  const argsLog = await readFile(context.argsLog, "utf8");
  const log = await runCommand("git", ["log", "--oneline", "-n", "2"], { cwd: repo, timeoutMs: 30_000 });
  return expect("resume session", [
    [state?.status === "idle", `state is ${state?.status}`],
    [argsLog.includes(`resume ${MOCK_SESSION_ID}`), `args log includes resume: ${JSON.stringify(argsLog)}`],
    [log.stdout.includes("codexwatcher:"), "completion was committed after resume"],
  ]);
}

async function testDirtyRepoCommitBlock(context: HarnessContext): Promise<HarnessResult> {
  const repo = await createRepo(context, "demo-dirty-repo", {
    "README.md": "# Demo Dirty Repo\n",
    "src/app.js": "export const ok = true;\n",
  });
  await writeFile(path.join(repo, "README.md"), "# Demo Dirty Repo\n\nUSER UNCOMMITTED CHANGE\n", "utf8");
  process.env.CODEXWATCHER_USAGE_FIXTURE = usageFixture(20);
  process.env.CODEXWATCHER_MOCK_CODEX_MODE = "resume-success";
  const runner = createRunner(context);
  const before = await currentCommit(repo);

  await runner.startTask({
    chatId: 0,
    repoPath: repo,
    projectId: "demo-dirty-repo",
    taskText: "Update README.md with a small agent change.",
  });

  const state = await loadState(repo);
  const after = await currentCommit(repo);
  const memory = await readFile(path.join(repo, ".keeper", "memory.md"), "utf8");
  const status = await runCommand("git", ["status", "--short"], { cwd: repo, timeoutMs: 30_000 });
  return expect("dirty repo commit block", [
    [state?.status === "blocked", `state is ${state?.status}`],
    [state?.resumeNote?.includes("pre-existing uncommitted changes") === true, `resume note: ${state?.resumeNote}`],
    [memory.includes("Commit Blocked Cycle"), "memory records commit block"],
    [before === after, "no commit was created"],
    [status.stdout.includes("README.md"), `dirty status remains: ${JSON.stringify(status.stdout)}`],
  ]);
}

function createRunner(
  context: HarnessContext,
  overrides: {
    pauseThresholdPercent?: number;
    maxRepairCycles?: number;
    notify?: string[];
  } = {},
): CycleRunner {
  const config = createConfig(context);
  config.codex.pauseThresholdPercent = overrides.pauseThresholdPercent ?? 99;
  config.codex.cautionThresholdPercent = 90;
  config.codex.maxAutoCycles = 1;
  config.codex.maxRepairCycles = overrides.maxRepairCycles ?? 1;
  return new CycleRunner(config, createHarnessBrain() as unknown as BrainClient, async (_chatId, text) => {
    overrides.notify?.push(text);
  });
}

function createHarnessBrain(): {
  interpret(input: { messageText: string }): Promise<BrainIntent>;
  plan(input: { task: string; progress: string }): Promise<BrainPlan>;
  review(input: { codexReport: unknown; progress: string }): Promise<AgentReview>;
  narrateStatus(): Promise<{ reply: string }>;
} {
  return {
    async interpret(input) {
      return {
        action: "start_development",
        reply: "Starting.",
        taskText: input.messageText,
      };
    },
    async plan(input) {
      const lower = input.task.toLowerCase();
      const title = lower.includes("break add")
        ? "Intentionally break add minimally"
        : lower.includes("resume")
          ? "Update README and record progress"
          : lower.includes("missing")
            ? "Add missing report test line"
            : "Update README";
      return {
        reply: "Planned.",
        tasks: [{ title, description: input.task, status: "pending" }],
        nextTask: { title, prompt: input.task },
      };
    },
    async review(input) {
      if (process.env.CODEXWATCHER_HARNESS_REVIEW_THROW === "1") {
        throw new Error("simulated review outage");
      }
      const report = input.codexReport as {
        testsRun?: Array<{ status?: string }>;
        remainingWork?: string[];
        filesChanged?: string[];
      };
      const hasFailedTest = report.testsRun?.some((item) => item.status === "failed") ?? false;
      if (hasFailedTest || report.remainingWork?.length) {
        return {
          taskComplete: false,
          evidence: ["Report or validation indicates incomplete work."],
          missingItems: ["Fix failing validation or clear remaining work."],
          nextAction: "ask_codex_to_fix",
          reply: "The report is not clean, so I am not committing.",
        };
      }
      return {
        taskComplete: true,
        evidence: ["Report is complete and progress evidence is present."],
        missingItems: [],
        nextAction: "commit_and_continue",
        reply: "Task is complete.",
      };
    },
    async narrateStatus() {
      return { reply: "Harness status." };
    },
  };
}

async function createHarnessContext(): Promise<HarnessContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexwatcher-harness-"));
  const workspaceRoot = path.join(root, "workspaces");
  const mockBin = path.join(root, "bin");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(mockBin, { recursive: true });
  return {
    root,
    workspaceRoot,
    mockBin,
    argsLog: path.join(root, "mock-codex-args.log"),
    previousCwd: process.cwd(),
    previousPath: process.env.PATH,
    previousUsageFixture: process.env.CODEXWATCHER_USAGE_FIXTURE,
    previousCodexCommand: process.env.CODEXWATCHER_CODEX_COMMAND,
    previousCodexArgsPrefix: process.env.CODEXWATCHER_CODEX_ARGS_PREFIX,
  };
}

async function createRepo(context: HarnessContext, name: string, files: Record<string, string>): Promise<string> {
  const repoPath = path.join(context.workspaceRoot, name);
  await mkdir(repoPath, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repoPath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await assertCommand("git", ["init", "-q"], repoPath);
  await assertCommand("git", ["config", "user.email", "codexwatcher@example.local"], repoPath);
  await assertCommand("git", ["config", "user.name", "CodexWatcher Harness"], repoPath);
  await assertCommand("git", ["add", "-A"], repoPath);
  await assertCommand("git", ["commit", "-q", "-m", `initial ${name}`], repoPath);
  return repoPath;
}

async function installMockCodex(context: HarnessContext): Promise<void> {
  const scriptPath = path.join(context.mockBin, "mock-codex.js");
  await writeFile(scriptPath, MOCK_CODEX_SCRIPT, "utf8");
  if (process.platform === "win32") {
    await writeFile(path.join(context.mockBin, "codex.cmd"), `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
  } else {
    const codexPath = path.join(context.mockBin, "codex");
    await writeFile(codexPath, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(scriptPath).href)});\n`, {
      encoding: "utf8",
      mode: 0o755,
    });
  }
}

const MOCK_CODEX_SCRIPT = String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const argsLog = process.env.CODEXWATCHER_MOCK_CODEX_ARGS_LOG;
if (argsLog) appendFileSync(argsLog, process.argv.slice(2).join(" ") + "\n");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const mode = process.env.CODEXWATCHER_MOCK_CODEX_MODE ?? "missing-report";
  const cycleId = prompt.match(/\.keeper\/cycles\/(\d+)\/codex-report\.json/)?.[1] ?? "001";
  const taskTitle = prompt.match(/Current task:\n([\s\S]*?)\n\nTask instructions:/)?.[1]?.trim() ?? "Harness task";
  if (mode === "missing-report") {
    emitThread();
    return;
  }
  if (mode === "failing-report") {
    writeFileSync("src/math.js", "export function add(a, b) {\n  return a - b;\n}\n");
    writeReport(cycleId, taskTitle, {
      summary: "Changed add, but validation failed.",
      filesChanged: ["src/math.js", ".keeper/cycles/" + cycleId + "/codex-report.json"],
      testsRun: [{ command: "npm test", status: "failed", outputSummary: "add(2, 3) returned -1." }],
      remainingWork: ["Fix add so npm test passes."],
    });
    emitThread();
    return;
  }
  if (mode === "resume-success") {
    writeFileSync("README.md", "# Demo Resume Session\n\nResume completed through saved Codex session.\n");
    writeFileSync(".keeper/progress.md", "# Progress\n\n- Resume session test completed through saved Codex session.\n");
    appendFileSync(".keeper/memory.md", "\n## Resume Test\n\nSecond run completed after resuming saved session.\n");
    writeReport(cycleId, taskTitle, {
      summary: "Completed the resume-session README update using the saved session.",
      filesChanged: ["README.md", ".keeper/progress.md", ".keeper/memory.md", ".keeper/cycles/" + cycleId + "/codex-report.json"],
      testsRun: [{ command: "README content check", status: "passed", outputSummary: "README contains the resume completion sentence." }],
      remainingWork: [],
    });
    emitThread();
    return;
  }
  emitThread();
});

function writeReport(cycleId, taskTitle, override) {
  const dir = path.join(".keeper", "cycles", cycleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "codex-report.json"), JSON.stringify({
    cycleId,
    taskTitle,
    status: "completed",
    summary: override.summary,
    filesChanged: override.filesChanged,
    testsRun: override.testsRun,
    commitHash: null,
    remainingWork: override.remainingWork,
    blockers: [],
    nextSuggestedTask: null,
  }, null, 2));
}

function emitThread() {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "33333333-3333-4333-8333-333333333333" }));
  console.log(JSON.stringify({ type: "turn.completed" }));
}
`;

function createConfig(context: HarnessContext): KeeperConfig {
  process.env.CODEXWATCHER_MOCK_CODEX_ARGS_LOG = context.argsLog;
  return {
    workspaceRoots: [context.workspaceRoot],
    telegram: {
      botToken: "harness-token",
      mode: "polling",
      allowedChatIds: [0],
    },
    brain: {
      provider: "harness",
      model: "harness",
      baseUrl: "http://127.0.0.1",
      apiKey: "harness",
      api: "openai-chat-completions",
    },
    codex: {
      cautionThresholdPercent: 90,
      pauseThresholdPercent: 99,
      maxAutoCycles: 1,
      maxRepairCycles: 1,
      sandboxMode: "workspace-write",
    },
  };
}

function usageFixture(primaryUsedPercent: number): string {
  return JSON.stringify({
    source: "oauth",
    primaryUsedPercent,
    primaryResetAt: FIXTURE_RESET,
    secondaryUsedPercent: null,
    secondaryResetAt: null,
    creditsBalance: null,
    plan: "fixture",
  });
}

function restoreHarnessEnv(context: HarnessContext): void {
  process.env.PATH = context.previousPath;
  process.chdir(context.previousCwd);
  if (context.previousUsageFixture === undefined) {
    delete process.env.CODEXWATCHER_USAGE_FIXTURE;
  } else {
    process.env.CODEXWATCHER_USAGE_FIXTURE = context.previousUsageFixture;
  }
  if (context.previousCodexCommand === undefined) {
    delete process.env.CODEXWATCHER_CODEX_COMMAND;
  } else {
    process.env.CODEXWATCHER_CODEX_COMMAND = context.previousCodexCommand;
  }
  if (context.previousCodexArgsPrefix === undefined) {
    delete process.env.CODEXWATCHER_CODEX_ARGS_PREFIX;
  } else {
    process.env.CODEXWATCHER_CODEX_ARGS_PREFIX = context.previousCodexArgsPrefix;
  }
  delete process.env.CODEXWATCHER_MOCK_CODEX_MODE;
  delete process.env.CODEXWATCHER_MOCK_CODEX_ARGS_LOG;
  delete process.env.CODEXWATCHER_HARNESS_REVIEW_THROW;
}

async function assertCommand(command: string, args: string[], cwd: string): Promise<void> {
  const result = await runCommand(command, args, { cwd, timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function expect(name: string, checks: Array<[boolean, string]>): HarnessResult {
  const failed = checks.filter(([passed]) => !passed);
  return {
    name,
    passed: failed.length === 0,
    details: checks.map(([passed, detail]) => `${passed ? "ok" : "not ok"}: ${detail}`),
  };
}
