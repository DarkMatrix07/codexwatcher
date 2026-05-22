export type TelegramMode = "webhook" | "polling";

export type KeeperConfig = {
  workspaceRoots: string[];
  telegram: {
    botToken: string;
    mode: TelegramMode;
    publicWebhookUrl?: string;
    port?: number;
    allowedChatIds?: number[];
    webhookSecretToken?: string;
  };
  brain: {
    source?: "direct" | "openclaw";
    api?: "openai-chat-completions" | "anthropic-messages";
    openClawStateDir?: string;
    openClawAgentId?: string;
    modelRef?: string;
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    authHeader?: boolean;
    headers?: Record<string, string>;
  };
  codex: {
    cautionThresholdPercent: number;
    pauseThresholdPercent: number;
    maxAutoCycles: number;
    maxRepairCycles: number;
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  };
};

export type KeeperState = {
  projectId: string;
  repoPath: string;
  activeChatId?: number;
  status: "idle" | "planning" | "working" | "sleeping" | "blocked" | "paused";
  currentTask?: string;
  codexSessionId?: string;
  lastCycleId?: string;
  lastKnownUsagePercent?: number;
  nextWakeAt?: string;
  resumeNote?: string;
  updatedAt: string;
};

export type NormalizedMessage = {
  chatId: number;
  text: string;
  fileName?: string;
  fileText?: string;
  raw: unknown;
};

export type BrainIntent = {
  reply: string;
  action: "clarify" | "start_development" | "status" | "pause" | "resume" | "chat";
  projectHint?: string;
  taskText?: string;
  needsClarification?: boolean;
  clarificationQuestion?: string;
};

export type BrainPlan = {
  reply: string;
  tasks: Array<{
    title: string;
    description: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  nextTask?: {
    title: string;
    prompt: string;
  };
};

export type CodexUsage = {
  source: "oauth" | "cli" | "unavailable";
  primaryUsedPercent: number | null;
  primaryResetAt: string | null;
  secondaryUsedPercent: number | null;
  secondaryResetAt: string | null;
  creditsBalance: number | null;
  plan: string | null;
  error?: string;
};

export type QuotaDecision =
  | { mode: "work"; usage: CodexUsage }
  | { mode: "caution"; usage: CodexUsage; note: string }
  | { mode: "sleep"; usage: CodexUsage; wakeAt: string | null; note: string };

export type CodexReport = {
  cycleId: string;
  taskTitle: string;
  status: "completed" | "partial" | "blocked" | "failed";
  summary: string;
  filesChanged: string[];
  testsRun: Array<{
    command: string;
    status: "passed" | "failed" | "skipped";
    outputSummary: string;
  }>;
  commitHash: string | null;
  remainingWork: string[];
  blockers: string[];
  nextSuggestedTask: string | null;
};

export type AgentReview = {
  taskComplete: boolean;
  evidence: string[];
  missingItems: string[];
  nextAction: "commit_and_continue" | "ask_codex_to_fix" | "ask_user" | "sleep";
  reply: string;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
