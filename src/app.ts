import { BrainClient } from "./brain/brain-client.js";
import { CycleRunner } from "./cycle/cycle-runner.js";
import { TelegramClient } from "./telegram/telegram.js";
import type { KeeperConfig, NormalizedMessage } from "./types.js";
import { discoverRepos, resolveRepoFromHint, type RepoCandidate } from "./workspace/workspace.js";
import { loadState, saveState } from "./state/keeper-files.js";

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
    const activeProject = await this.findActiveProject(message.chatId, repos);
    const mentionedProject = this.findMentionedProject(message.text, repos);
    const intent = await this.brain.interpret({
      messageText: message.text,
      fileText: message.fileText,
      repos: repos.map((repo) => ({ name: repo.name, path: repo.path })),
      activeProject: activeProject?.name,
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
      await this.reply(message.chatId, "Paused. I will wait until you ask me to continue.");
      return;
    }
    if (intent.action !== "start_development" && intent.action !== "resume") {
      await this.reply(message.chatId, intent.reply);
      return;
    }
    if (intent.action === "start_development" && repos.length > 1 && !mentionedProject) {
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
      return;
    }
    await this.telegram.sendMessage(chatId, text);
  }

  private async findActiveProject(
    chatId: number,
    repos: Array<{ name: string; path: string }>,
  ): Promise<{ name: string; path: string } | null> {
    let latest: ({ name: string; path: string } & { updatedAt: string }) | null = null;
    for (const repo of repos) {
      const state = await loadState(repo.path);
      if (state?.activeChatId !== chatId) continue;
      if (!latest || state.updatedAt > latest.updatedAt) {
        latest = { ...repo, updatedAt: state.updatedAt };
      }
    }
    return latest ? { name: latest.name, path: latest.path } : null;
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
    return !allowed?.length || allowed.includes(chatId);
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

  private async restoreSleepingProjects(): Promise<void> {
    const repos = await discoverRepos(this.config.workspaceRoots);
    for (const repo of repos) {
      const state = await loadState(repo.path);
      if (state?.status !== "sleeping" || !state.nextWakeAt || !state.activeChatId) continue;
      this.runner.scheduleWake(state.activeChatId, repo.path, repo.name, state.nextWakeAt);
    }
  }
}

function normalizeProjectText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
