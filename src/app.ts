import { BrainClient } from "./brain/brain-client.js";
import { CycleRunner } from "./cycle/cycle-runner.js";
import { getGitSnapshot } from "./git/git.js";
import {
  appendChatHistory,
  appendProjectChatHistory,
  freshPending,
  getProjectHistory,
  loadChatContext,
  rememberActiveProject,
  saveChatContext,
} from "./state/chat-state.js";
import { TelegramClient } from "./telegram/telegram.js";
import type { KeeperConfig, NormalizedMessage } from "./types.js";
import {
  cloneRepoIntoWorkspace,
  discoverRepos,
  extractGitUrl,
  resolveRepoFromHint,
  type RepoCandidate,
} from "./workspace/workspace.js";
import { loadState, readKeeperFile, saveState } from "./state/keeper-files.js";

export class CodexKeeperApp {
  private readonly brain: BrainClient;
  private readonly telegram: TelegramClient;
  private readonly runner: CycleRunner;

  constructor(private readonly config: KeeperConfig) {
    this.brain = new BrainClient(config.brain);
    this.telegram = new TelegramClient(config.telegram);
    this.runner = new CycleRunner(config, this.brain, async (chatId, text) => {
      await this.reply(chatId, text);
    });
  }

  async start(): Promise<void> {
    await this.restoreSleepingProjects();
    if (this.config.telegram.mode === "webhook") {
      await this.telegram.startWebhook((message) => this.handleMessage(message));
    } else {
      await this.telegram.startPolling((message) => this.handleMessage(message));
    }
  }

  async handleDevMessage(text: string): Promise<void> {
    await this.handleMessage({ chatId: 0, text, raw: { dev: true } });
  }

  async handleMessage(message: NormalizedMessage): Promise<void> {
    if (!this.isAllowedChat(message.chatId)) {
      await this.reply(message.chatId, "Unauthorized.");
      return;
    }
    const repos = await discoverRepos(this.config.workspaceRoots);
    const chatContext = await loadChatContext(message.chatId);
    const rememberedProject = chatContext.activeProjectId
      ? repos.find((repo) => repo.id === chatContext.activeProjectId || repo.name === chatContext.activeProjectId)
      : null;
    const activeProject = rememberedProject ?? null;
    const mentionedProject = this.findMentionedProject(message.text, repos);
    const pending = freshPending(chatContext.pending);
    const contextAfterUser = await appendChatHistory(message.chatId, { role: "user", text: message.text });
    const gitUrl = extractGitUrl(message.text);
    if (this.isRepoOnboardingRequest(message.text)) {
      if (!gitUrl) {
        await this.reply(message.chatId, "Send me the git repo URL to clone.");
        return;
      }
      const root = this.config.workspaceRoots[0];
      if (!root) {
        await this.reply(message.chatId, "No workspace root is configured, so I cannot clone a repo yet.");
        return;
      }
      let cloneResult: Awaited<ReturnType<typeof cloneRepoIntoWorkspace>>;
      try {
        cloneResult = await cloneRepoIntoWorkspace(root, gitUrl);
      } catch (error) {
        await this.reply(message.chatId, `I could not clone that repo: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await this.rememberProject(message.chatId, cloneResult.repo);
      await appendProjectChatHistory(message.chatId, cloneResult.repo, { role: "user", text: message.text });
      await this.replyForProject(
        message.chatId,
        cloneResult.repo,
        `${cloneResult.cloned ? "Cloned" : "Using existing clone"} ${cloneResult.repo.name}. I will inspect it as the selected project.`,
      );
      await this.runner.startTask({
        chatId: message.chatId,
        repoPath: cloneResult.repo.path,
        projectId: cloneResult.repo.name,
        taskText: message.text,
        fileText: message.fileText,
      });
      return;
    }
    if (this.isGreeting(message.text)) {
      await this.reply(
        message.chatId,
        activeProject
          ? `Hey. I have ${activeProject.name} selected right now. Ask for status, switch project, or tell me the next task.`
          : `Hey. Tell me which project to use, or ask for status and I will show the available projects.`,
      );
      return;
    }
    if (this.isCurrentProjectQuestion(message.text)) {
      await this.reply(
        message.chatId,
        activeProject
          ? `The current project is ${activeProject.name}.`
          : `No project is selected yet. Available projects: ${repos.map((repo) => repo.name).join(", ")}.`,
      );
      return;
    }
    if (pending?.action === "status" && mentionedProject && this.isProjectSelection(message.text, mentionedProject)) {
      await this.rememberProject(message.chatId, mentionedProject);
      await appendProjectChatHistory(message.chatId, mentionedProject, { role: "user", text: message.text });
      await this.replyForProject(
        message.chatId,
        mentionedProject,
        await this.buildProjectStatus(message.chatId, mentionedProject, pending.originalText ?? message.text),
      );
      return;
    }
    if (mentionedProject && this.isProjectSelection(message.text, mentionedProject)) {
      await this.rememberProject(message.chatId, mentionedProject);
      await this.replyForProject(
        message.chatId,
        mentionedProject,
        `Selected ${mentionedProject.name}. Ask for status, or tell me the task for this project.`,
      );
      return;
    }
    const isDevelopment = this.isDevelopmentRequest(message.text);
    if (isDevelopment && this.isVagueDevelopmentRequest(message.text)) {
      await this.reply(
        message.chatId,
        activeProject
          ? `What should I change in ${activeProject.name}? Give me the file, bug, or feature you want handled.`
          : `What should I work on, and in which project?`,
      );
      return;
    }
    if (this.isStatusRequest(message.text) && !isDevelopment) {
      if (mentionedProject) {
        await this.rememberProject(message.chatId, mentionedProject);
        await appendProjectChatHistory(message.chatId, mentionedProject, { role: "user", text: message.text });
        await this.replyForProject(
          message.chatId,
          mentionedProject,
          await this.buildProjectStatus(message.chatId, mentionedProject, message.text),
        );
        return;
      }
      if (activeProject) {
        await this.rememberProject(message.chatId, activeProject);
        await appendProjectChatHistory(message.chatId, activeProject, { role: "user", text: message.text });
        await this.replyForProject(
          message.chatId,
          activeProject,
          await this.buildProjectStatus(message.chatId, activeProject, message.text),
        );
        return;
      }
      if (repos.length > 1) {
        await saveChatContext({
          ...contextAfterUser,
          pending: { action: "status", createdAt: Date.now(), originalText: message.text },
        });
        await this.reply(
          message.chatId,
          `Which project would you like the status for? Available projects: ${repos.map((repo) => repo.name).join(", ")}.`,
        );
        return;
      }
      if (repos.length === 1) {
        await this.reply(message.chatId, await this.buildProjectStatus(message.chatId, repos[0], message.text));
        return;
      }
    }
    if (isDevelopment) {
      if (repos.length > 1 && !mentionedProject && !activeProject) {
        await this.reply(
          message.chatId,
          `Which project should I use? I found: ${repos.map((repo) => repo.name).join(", ")}.`,
        );
        return;
      }
      const repo = mentionedProject ?? activeProject ?? repos[0];
      if (!repo) {
        await this.reply(message.chatId, "I need the project before I start development.");
        return;
      }
      await this.rememberProject(message.chatId, repo);
      await appendProjectChatHistory(message.chatId, repo, { role: "user", text: message.text });
      await this.runner.startTask({
        chatId: message.chatId,
        repoPath: repo.path,
        projectId: repo.name,
        taskText: message.text,
        fileText: message.fileText,
      });
      return;
    }
    const intent = await this.brain.interpret({
      messageText: message.text,
      fileText: message.fileText,
      repos: repos.map((repo) => ({ name: repo.name, path: repo.path })),
      activeProject: activeProject?.name,
      recentHistory: (contextAfterUser.history ?? []).slice(-8).map((entry) => ({
        role: entry.role,
        text: entry.text,
      })),
    });
    if (intent.action === "status") {
      await this.reply(message.chatId, await this.buildStatus(repos, message.chatId));
      return;
    }
    if (intent.action === "chat" || intent.action === "clarify" || intent.needsClarification) {
      await this.reply(message.chatId, intent.clarificationQuestion ?? intent.reply);
      return;
    }
    if (intent.action === "pause") {
      const repo = mentionedProject ?? activeProject;
      if (!repo) {
        await this.reply(message.chatId, "Which project should I pause?");
        return;
      }
      {
        const state = await loadState(repo.path);
        await saveState(repo.path, {
          ...(state ?? {
            projectId: repo.name,
            repoPath: repo.path,
            updatedAt: new Date().toISOString(),
          }),
          activeChatId: message.chatId,
          status: "paused",
          nextWakeAt: undefined,
          resumeNote: "Paused by user.",
          updatedAt: new Date().toISOString(),
        });
      }
      await this.rememberProject(message.chatId, repo);
      await this.reply(message.chatId, "Paused. I will wait until you ask me to continue.");
      return;
    }
    if (intent.action !== "start_development" && intent.action !== "resume") {
      await this.reply(message.chatId, intent.reply);
      return;
    }
    if (intent.action === "start_development" && repos.length > 1 && !mentionedProject && !activeProject) {
      await this.reply(
        message.chatId,
        `Which project should I use? I found: ${repos.map((repo) => repo.name).join(", ")}.`,
      );
      return;
    }
    const resolved = mentionedProject
      ? { repo: mentionedProject, matches: [mentionedProject] }
      : resolveRepoFromHint(repos, intent.projectHint ?? activeProject?.name);
    if (!resolved.repo) {
      const choices = resolved.matches.map((repo) => repo.name).join(", ");
      await this.reply(
        message.chatId,
        `${resolved.reason ?? "I need the project first."}${choices ? ` I found: ${choices}. Which one should I use?` : ""}`,
      );
      return;
    }
    if (intent.action === "resume" && !intent.taskText && !message.fileText) {
      await this.rememberProject(message.chatId, resolved.repo);
      const state = await loadState(resolved.repo.path);
      if (state?.status === "paused" && !state.currentTask) {
        await saveState(resolved.repo.path, {
          ...state,
          activeChatId: message.chatId,
          status: "idle",
          resumeNote: "Resumed by user. No active task to continue.",
          updatedAt: new Date().toISOString(),
        });
        await this.reply(message.chatId, `${resolved.repo.name} is resumed. There is no active task to continue.`);
        return;
      }
      await this.runner.runAutoCycles(message.chatId, resolved.repo.path, resolved.repo.name);
      return;
    }
    const taskText = intent.taskText ?? message.text ?? message.fileText;
    if (!taskText?.trim()) {
      await this.reply(message.chatId, "I found the project, but I need the task before I start development.");
      return;
    }
    await this.rememberProject(message.chatId, resolved.repo);
    await appendProjectChatHistory(message.chatId, resolved.repo, { role: "user", text: message.text });
    await this.runner.startTask({
      chatId: message.chatId,
      repoPath: resolved.repo.path,
      projectId: resolved.repo.name,
      taskText,
      fileText: message.fileText,
    });
  }

  private async reply(chatId: number, text: string): Promise<void> {
    if (chatId === 0) {
      console.log(text);
      await appendChatHistory(chatId, { role: "assistant", text });
      return;
    }
    await this.telegram.sendMessage(chatId, text);
    await appendChatHistory(chatId, { role: "assistant", text });
  }

  private async replyForProject(chatId: number, repo: { id?: string; name: string }, text: string): Promise<void> {
    await this.reply(chatId, text);
    await appendProjectChatHistory(chatId, repo, { role: "assistant", text });
  }

  private findMentionedProject(text: string, repos: RepoCandidate[]): RepoCandidate | null {
    const normalizedText = normalizeProjectText(text);
    const matches = repos.filter((repo) => {
      const name = normalizeProjectText(repo.name);
      const id = normalizeProjectText(repo.id);
      return (name.length >= 3 && normalizedText.includes(name)) || (id.length >= 3 && normalizedText.includes(id));
    });
    return matches.length === 1 ? matches[0] : null;
  }

  private isAllowedChat(chatId: number): boolean {
    if (chatId === 0) return true;
    const allowed = this.config.telegram.allowedChatIds;
    return this.config.telegram.allowAllChatsUnsafe === true || allowed?.includes(chatId) === true;
  }

  private async rememberProject(chatId: number, repo: { id?: string; name: string }): Promise<void> {
    await rememberActiveProject(chatId, repo);
  }

  private async buildStatus(repos: Array<{ name: string; path: string }>, chatId: number): Promise<string> {
    const lines = ["CodexWatcher status:", ""];
    for (const repo of repos) {
      const state = await loadState(repo.path);
      if (!state) continue;
      if (chatId !== 0 && state.activeChatId !== chatId) continue;
      lines.push(`- ${repo.name}: ${state.status}${state.nextWakeAt ? `, wakes ${state.nextWakeAt}` : ""}`);
    }
    return lines.join("\n").trim() || "CodexWatcher is running. No project state yet.";
  }

  private async buildProjectStatus(chatId: number, repo: { name: string; path: string }, userMessage: string): Promise<string> {
    const chatContext = await loadChatContext(chatId);
    const [state, git, progress, memory] = await Promise.all([
      loadState(repo.path),
      getGitSnapshot(repo.path).catch(() => null),
      readKeeperFile(repo.path, "progress.md").catch(() => ""),
      readKeeperFile(repo.path, "memory.md").catch(() => ""),
    ]);
    const progressLines = summarizeMarkdown(progress);
    const memoryLines = summarizeMarkdown(memory);
    const refreshedContext = await loadChatContext(chatId);
    const facts = {
      userMessage,
      projectName: repo.name,
      state: state?.status ?? "no watcher state yet",
      lastCycleId: state?.lastCycleId,
      resumeNote: state?.resumeNote,
      nextWakeAt: state?.nextWakeAt,
      gitSummary: git ? `${git.status ? "changes pending" : "clean"}${git.lastCommit ? `, last commit ${git.lastCommit}` : ""}` : undefined,
      progress: progressLines,
      memory: memoryLines,
      recentHistory: (refreshedContext.history ?? chatContext.history ?? []).slice(-8).map((entry) => ({
        role: entry.role,
        text: entry.text,
      })),
      projectHistory: getProjectHistory(refreshedContext, repo, 8).map((entry) => ({
        role: entry.role,
        text: entry.text,
      })),
    };
    try {
      const narrated = await this.brain.narrateStatus(facts);
      if (narrated.reply.trim()) return narrated.reply.trim();
    } catch (error) {
      console.error("Status narration failed:", error instanceof Error ? error.message : error);
    }
    const lines = [`CodexWatcher status for ${repo.name}:`, ""];
    lines.push(`State: ${state?.status ?? "no watcher state yet"}`);
    if (state?.lastCycleId) lines.push(`Last cycle: ${state.lastCycleId}`);
    if (state?.resumeNote) lines.push(`Note: ${state.resumeNote}`);
    if (state?.nextWakeAt) lines.push(`Next wake: ${state.nextWakeAt}`);
    if (git) {
      lines.push(`Git: ${git.status ? "changes pending" : "clean"}${git.lastCommit ? `, last commit ${git.lastCommit}` : ""}`);
    }
    if (progressLines.length) {
      lines.push("", "Progress:");
      lines.push(...progressLines.map((line) => `- ${line}`));
    } else {
      lines.push("", "Progress: no progress notes yet.");
    }
    if (memoryLines.length) {
      lines.push("", "Memory:");
      lines.push(...memoryLines.map((line) => `- ${line}`));
    }
    return lines.join("\n");
  }

  private async restoreSleepingProjects(): Promise<void> {
    const repos = await discoverRepos(this.config.workspaceRoots);
    for (const repo of repos) {
      const state = await loadState(repo.path);
      if (state?.status !== "sleeping" || !state.nextWakeAt || !state.activeChatId) continue;
      this.runner.scheduleWake(state.activeChatId, repo.path, repo.name, state.nextWakeAt);
    }
  }

  private isStatusRequest(text: string): boolean {
    const normalized = text.toLowerCase();
    return /\b(status|progress|implemented|completed|done|finish|finished|checkpoint|checkpoints)\b/.test(normalized);
  }

  private isGreeting(text: string): boolean {
    return /^(hi|hello|hey|yo|hola|namaste|sup)[!.\s]*$/i.test(text.trim());
  }

  private isCurrentProjectQuestion(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
      /\b(last|current|selected|assigned)\b.*\b(project|repo|repository)\b/.test(normalized) ||
      /\b(project|repo|repository)\b.*\b(last|current|selected|assigned)\b/.test(normalized)
    );
  }

  private isProjectSelection(text: string, repo: RepoCandidate): boolean {
    if (this.isProjectOnlyReply(text, repo)) return true;
    if (!this.findMentionedProject(text, [repo])) return false;
    const normalized = text.toLowerCase();
    const hasSelectionCue = /\b(ok|okay|yes|yeah|yep|its|it's|it is|use|select|choose|switch|change|that one|this one)\b/.test(
      normalized,
    );
    const hasWorkCue = this.isDevelopmentRequest(text);
    return hasSelectionCue && !hasWorkCue && !this.isStatusRequest(text);
  }

  private isDevelopmentRequest(text: string): boolean {
    const normalized = text.toLowerCase();
    if (/\b(update me|tell me|show me)\b.*\b(status|progress|implemented|completed|done|finished)\b/.test(normalized)) {
      return false;
    }
    return /\b(add|implement|fix|create|update|change|build|write|delete|remove|test|run|work|develop|make|clone)\b/.test(
      normalized,
    );
  }

  private isRepoOnboardingRequest(text: string): boolean {
    const normalized = text.toLowerCase();
    return /\b(clone|checkout|get|pull|download|understand|analyze|analyse|inspect|study)\b/.test(normalized) && !!extractGitUrl(text);
  }

  private isVagueDevelopmentRequest(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .replace(/[.!?]+/g, "")
      .trim();
    return /^(fix|update|change|make|do|work on|implement|add|build|test|run)\s*(it|that|this)?$/.test(normalized);
  }

  private isProjectOnlyReply(text: string, repo: RepoCandidate): boolean {
    const normalized = normalizeProjectText(text);
    return normalized === normalizeProjectText(repo.name) || normalized === normalizeProjectText(repo.id);
  }
}

function normalizeProjectText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function summarizeMarkdown(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^[-*]\s*/, "").replace(/^\[[ x]\]\s*/i, ""))
    .slice(-6);
}
