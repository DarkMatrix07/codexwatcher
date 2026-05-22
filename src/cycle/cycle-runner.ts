import { BrainClient } from "../brain/brain-client.js";
import { buildCodexPrompt, runCodex } from "../codex/runner.js";
import { checkCodexUsage } from "../codex/usage.js";
import { commitAll, getGitSnapshot } from "../git/git.js";
import { decideQuota } from "../quota.js";
import {
  appendKeeperFile,
  ensureKeeperFiles,
  loadCodexReport,
  loadState,
  nextCycleId,
  readKeeperFile,
  saveAgentReview,
  saveCycleOutput,
  saveCyclePrompt,
  saveState,
  writeKeeperFile,
} from "../state/keeper-files.js";
import type { AgentReview, CodexReport, KeeperConfig, KeeperState, QuotaDecision } from "../types.js";

type CycleOutcome = "continue" | "stop";

export class CycleRunner {
  private readonly activeRepos = new Set<string>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: KeeperConfig,
    private readonly brain: BrainClient,
    private readonly notify: (chatId: number, text: string) => Promise<void>,
  ) {}

  async startTask(params: {
    chatId: number;
    repoPath: string;
    projectId: string;
    taskText: string;
    fileText?: string;
  }): Promise<void> {
    const baselineGit = await getGitSnapshot(params.repoPath);
    const baselineUserGitStatus = filterKeeperStatus(baselineGit.status);
    await ensureKeeperFiles(params.repoPath);
    const task = [params.taskText, params.fileText].filter(Boolean).join("\n\n--- uploaded file ---\n\n");
    await writeKeeperFile(params.repoPath, "task.md", `# Task\n\n${task.trim()}\n`);
    const previous = await loadState(params.repoPath);
    await saveState(params.repoPath, {
      projectId: params.projectId,
      repoPath: params.repoPath,
      activeChatId: params.chatId,
      status: "planning",
      currentTask: params.taskText,
      codexSessionId: previous?.codexSessionId,
      lastCycleId: previous?.lastCycleId,
      baselineGitStatus: baselineUserGitStatus,
      updatedAt: new Date().toISOString(),
    });
    await this.notify(
      params.chatId,
      `Got it. I'm checking Codex usage and planning the next small task for ${params.projectId}.`,
    );
    await this.runAutoCycles(params.chatId, params.repoPath, params.projectId);
  }

  async runAutoCycles(chatId: number, repoPath: string, projectId: string): Promise<void> {
    if (this.activeRepos.has(repoPath)) {
      await this.notify(chatId, `I'm already working on ${projectId}. I won't start a second overlapping run.`);
      return;
    }
    this.activeRepos.add(repoPath);
    try {
      for (let i = 0; i < this.config.codex.maxAutoCycles; i++) {
        const outcome = await this.runOneCycle(chatId, repoPath, projectId);
        if (outcome !== "continue") return;
      }
      await this.notify(
        chatId,
        `I reached the ${this.config.codex.maxAutoCycles}-cycle safety stop. Ask me to continue when you're ready.`,
      );
    } finally {
      this.activeRepos.delete(repoPath);
    }
  }

  async runOneCycle(chatId: number, repoPath: string, projectId: string): Promise<CycleOutcome> {
    await ensureKeeperFiles(repoPath);
    const state = await loadState(repoPath);
    const usage = await checkCodexUsage();
    const decision = decideQuota(usage, this.config.codex);
    await this.handleQuotaMemory(repoPath, decision);
    if (decision.mode === "sleep") {
      if (usage.source === "unavailable") {
        await saveState(repoPath, {
          ...(state ?? {
            projectId,
            repoPath,
            status: "blocked",
            updatedAt: new Date().toISOString(),
          }),
          activeChatId: chatId,
          status: "blocked",
          lastKnownUsagePercent: undefined,
          nextWakeAt: undefined,
          resumeNote: decision.note,
          updatedAt: new Date().toISOString(),
        });
        await this.notify(chatId, `I can't check Codex usage, so I won't start work yet.\n${decision.note}`);
        return "stop";
      }
      const nextWakeAt = decision.wakeAt ?? new Date(Date.now() + 60 * 60_000).toISOString();
      await saveState(repoPath, {
        ...(state ?? {
          projectId,
          repoPath,
          status: "sleeping",
          updatedAt: new Date().toISOString(),
        }),
        activeChatId: chatId,
        status: "sleeping",
        lastKnownUsagePercent: usage.primaryUsedPercent ?? usage.secondaryUsedPercent ?? undefined,
        nextWakeAt,
        resumeNote: decision.note,
        updatedAt: new Date().toISOString(),
      });
      await this.notify(chatId, `Pausing now. ${decision.note}\nNext wake: ${nextWakeAt}`);
      this.scheduleWake(chatId, repoPath, projectId, nextWakeAt);
      return "stop";
    }

    const cycleId = nextCycleId(state);
    const [taskFile, progress, memory, git] = await Promise.all([
      readKeeperFile(repoPath, "task.md"),
      readKeeperFile(repoPath, "progress.md"),
      readKeeperFile(repoPath, "memory.md"),
      getGitSnapshot(repoPath),
    ]);
    const plan = await this.brain.plan({
      task: state?.currentTask ?? taskFile,
      taskFile,
      progress,
      memory,
      gitStatus: git.status,
      quotaMode: decision.mode,
    });
    await writeKeeperFile(
      repoPath,
      "plan.md",
      `# Plan\n\n${plan.tasks
        .map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.title}: ${task.description}`)
        .join("\n")}\n`,
    );
    if (!plan.nextTask) {
      await this.notify(chatId, plan.reply || "I need a clearer next task before starting Codex.");
      return "stop";
    }
    return await this.executeTaskCycle({
      chatId,
      repoPath,
      projectId,
      cycleId,
      taskTitle: plan.nextTask.title,
      taskPrompt: plan.nextTask.prompt,
      quotaMode: decision.mode,
      sessionId: state?.codexSessionId,
      previousState: state,
    });
  }

  private async executeTaskCycle(params: {
    chatId: number;
    repoPath: string;
    projectId: string;
    cycleId: string;
    taskTitle: string;
    taskPrompt: string;
    quotaMode: "work" | "caution";
    sessionId?: string;
    previousState: KeeperState | null;
    repairDepth?: number;
  }): Promise<CycleOutcome> {
    await this.notify(params.chatId, `Starting Codex cycle ${params.cycleId}: ${params.taskTitle}`);
    const prompt = buildCodexPrompt({
      cycleId: params.cycleId,
      taskTitle: params.taskTitle,
      taskPrompt: params.taskPrompt,
      quotaMode: params.quotaMode,
    });
    await saveCyclePrompt(params.repoPath, params.cycleId, prompt);
    await saveState(params.repoPath, {
      ...(params.previousState ?? {
        projectId: params.projectId,
        repoPath: params.repoPath,
        status: "working",
        updatedAt: new Date().toISOString(),
      }),
      activeChatId: params.chatId,
      status: "working",
      currentTask: params.taskTitle,
      lastCycleId: params.cycleId,
      resumeNote: `Working on ${params.taskTitle} in cycle ${params.cycleId}.`,
      updatedAt: new Date().toISOString(),
    });
    const run = await runCodex(params.repoPath, prompt, params.sessionId, {
      sandboxMode: this.config.codex.sandboxMode,
    });
    await saveCycleOutput(params.repoPath, params.cycleId, `${run.stdout}\n${run.stderr}`);
    if (run.exitCode !== 0) {
      await appendKeeperFile(
        params.repoPath,
        "memory.md",
        `\n## Codex Failed Cycle ${params.cycleId}\n\nTask: ${params.taskTitle}\nExit code: ${run.exitCode ?? "unknown"}\nResume by inspecting .keeper/cycles/${params.cycleId}/codex-output.log and git status.\n`,
      );
      await saveState(params.repoPath, {
        ...(params.previousState ?? {
          projectId: params.projectId,
          repoPath: params.repoPath,
          status: "blocked",
          updatedAt: new Date().toISOString(),
        }),
        activeChatId: params.chatId,
        status: "blocked",
        codexSessionId: run.sessionId,
        lastCycleId: params.cycleId,
        resumeNote: `Codex failed during ${params.taskTitle}.`,
        updatedAt: new Date().toISOString(),
      });
      await this.notify(params.chatId, `Codex failed during cycle ${params.cycleId}. I saved the output and blocked instead of reviewing/committing.`);
      return "stop";
    }
    let report: CodexReport;
    try {
      report = await loadCodexReport(params.repoPath, params.cycleId, params.taskTitle);
    } catch (error) {
      await appendKeeperFile(
        params.repoPath,
        "memory.md",
        `\n## Interrupted Cycle ${params.cycleId}\n\nCodex did not produce a valid report. Resume by inspecting git status and cycle output.\n\nError: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      await saveState(params.repoPath, {
        ...(params.previousState ?? {
          projectId: params.projectId,
          repoPath: params.repoPath,
          status: "blocked",
          updatedAt: new Date().toISOString(),
        }),
        activeChatId: params.chatId,
        status: "blocked",
        codexSessionId: run.sessionId ?? params.sessionId,
        lastCycleId: params.cycleId,
        resumeNote: `Cycle ${params.cycleId} stopped without a valid codex-report.json.`,
        updatedAt: new Date().toISOString(),
      });
      await this.notify(
        params.chatId,
        `Codex stopped without a valid report for cycle ${params.cycleId}. I saved a resume note in memory.md.`,
      );
      return "stop";
    }

    const review = await this.reviewReport(params.repoPath, params.taskTitle, report);
    await saveAgentReview(params.repoPath, params.cycleId, review);
    const complete =
      report.status === "completed" &&
      review.taskComplete &&
      (review.nextAction === "commit_and_continue" || review.nextAction === "sleep");
    const nextState: KeeperState = {
      projectId: params.projectId,
      repoPath: params.repoPath,
      activeChatId: params.chatId,
      status: complete ? "idle" : "blocked",
      currentTask: complete ? report.nextSuggestedTask ?? undefined : params.taskTitle,
      codexSessionId: run.sessionId ?? params.sessionId,
      lastCycleId: params.cycleId,
      updatedAt: new Date().toISOString(),
    };

    if (complete) {
      if (params.previousState?.baselineGitStatus?.trim()) {
        await appendKeeperFile(
          params.repoPath,
          "memory.md",
          `\n## Commit Blocked Cycle ${params.cycleId}\n\nTask: ${params.taskTitle}\nReason: repo had pre-existing changes before CodexWatcher started this task.\nBaseline git status:\n\`\`\`text\n${params.previousState.baselineGitStatus}\n\`\`\`\n`,
        );
        await saveState(params.repoPath, {
          ...nextState,
          status: "blocked",
          currentTask: params.taskTitle,
          resumeNote: "Commit blocked because the repo had pre-existing uncommitted changes.",
        });
        await this.notify(
          params.chatId,
          `Task passed review, but I did not commit because ${params.projectId} had uncommitted changes before I started. Please review/commit/stash those changes, then ask me to continue.`,
        );
        return "stop";
      }
      nextState.resumeNote = `Last completed task: ${params.taskTitle}.`;
      await saveState(params.repoPath, nextState);
      const commit = await commitAll(params.repoPath, `codexwatcher: ${params.taskTitle}`);
      await this.notify(params.chatId, `Task done: ${params.taskTitle}\nCommit: ${commit ?? "no changes"}\n${review.reply}`);
      return report.nextSuggestedTask ? "continue" : "stop";
    }

    await saveState(params.repoPath, nextState);
    if (review.nextAction === "ask_codex_to_fix") {
      const repairDepth = params.repairDepth ?? 0;
      if (repairDepth >= this.config.codex.maxRepairCycles) {
        await appendKeeperFile(
          params.repoPath,
          "memory.md",
          `\n## Repair Limit Reached Cycle ${params.cycleId}\n\nTask: ${params.taskTitle}\nMissing: ${review.missingItems.join(", ") || "not specified"}\n`,
        );
        await this.notify(params.chatId, `Repair limit reached for ${params.taskTitle}. I saved the missing items and stopped.`);
        return "stop";
      }
      return await this.runRepairCycle(params.chatId, params.repoPath, params.projectId, {
        previousCycleId: params.cycleId,
        sessionId: run.sessionId ?? params.sessionId,
        taskTitle: params.taskTitle,
        missingItems: review.missingItems,
        reviewReply: review.reply,
        repairDepth: repairDepth + 1,
      });
    }

    await appendKeeperFile(
      params.repoPath,
      "memory.md",
      `\n## Review Blocked Cycle ${params.cycleId}\n\nTask: ${params.taskTitle}\nReport status: ${report.status}\nMissing: ${review.missingItems.join(", ") || "not specified"}\nNext action: ${review.nextAction}\n`,
    );
    await this.notify(params.chatId, `I'm not moving to the next task yet.\n${review.reply}`);
    return "stop";
  }

  private async runRepairCycle(
    chatId: number,
    repoPath: string,
    projectId: string,
    repair: {
      previousCycleId: string;
      sessionId?: string;
      taskTitle: string;
      missingItems: string[];
      reviewReply: string;
      repairDepth: number;
    },
  ): Promise<CycleOutcome> {
    const state = await loadState(repoPath);
    const cycleId = nextCycleId(state);
    const taskPrompt = `Continue the same task from cycle ${repair.previousCycleId}. The agent review found these issues:
${repair.missingItems.map((item) => `- ${item}`).join("\n") || "- Review said the task is incomplete."}

Review note:
${repair.reviewReply}

Fix only these issues, update .keeper/progress.md and .keeper/memory.md, write the required codex-report.json, and stop.`;
    await this.notify(chatId, `The review found missing work. I'm sending one repair prompt to Codex for cycle ${cycleId}.`);
    return await this.executeTaskCycle({
      chatId,
      repoPath,
      projectId,
      cycleId,
      taskTitle: `Repair: ${repair.taskTitle}`,
      taskPrompt,
      quotaMode: "caution",
      sessionId: repair.sessionId,
      previousState: state,
      repairDepth: repair.repairDepth,
    });
  }

  private async reviewReport(repoPath: string, taskTitle: string, report: CodexReport): Promise<AgentReview> {
    const afterGit = await getGitSnapshot(repoPath);
    return await this.brain.review({
      taskTitle,
      codexReport: report,
      gitStatus: afterGit.status,
      gitDiff: afterGit.diff,
      progress: await readKeeperFile(repoPath, "progress.md"),
      memory: await readKeeperFile(repoPath, "memory.md"),
    });
  }

  private async handleQuotaMemory(repoPath: string, decision: QuotaDecision): Promise<void> {
    if (decision.mode === "work") return;
    await appendKeeperFile(repoPath, "memory.md", `\n## Quota Note ${new Date().toISOString()}\n\n${decision.note}\n`);
  }

  scheduleWake(chatId: number, repoPath: string, projectId: string, wakeAt: string): void {
    const key = `${repoPath}:${wakeAt}`;
    if (this.wakeTimers.has(key)) return;
    const delay = Math.max(5_000, new Date(wakeAt).getTime() - Date.now() + 60_000);
    const timer = setTimeout(() => {
      this.wakeTimers.delete(key);
      void (async () => {
        const state = await loadState(repoPath);
        if (state?.status === "paused") {
          await this.notify(chatId, `${projectId} is paused, so I am not resuming automatically.`);
          return;
        }
        await this.notify(chatId, `I'm awake again for ${projectId}. Checking usage and continuing from memory/progress.`);
        await this.runAutoCycles(chatId, repoPath, projectId);
      })();
    }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
    this.wakeTimers.set(key, timer);
  }
}

function filterKeeperStatus(status: string): string {
  return status
    .split(/\r?\n/)
    .filter((line) => {
      const file = line.slice(3).trim().replace(/\\/g, "/");
      return file && !file.startsWith(".keeper/");
    })
    .join("\n");
}
