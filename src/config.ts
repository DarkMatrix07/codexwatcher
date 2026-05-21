import { readFile } from "node:fs/promises";
import path from "node:path";
import type { KeeperConfig } from "./types.js";
import { loadOpenClawBrainConfig } from "./brain/openclaw-config.js";

const DEFAULT_CONFIG: Omit<KeeperConfig, "workspaceRoots" | "telegram" | "brain"> = {
  codex: {
    cautionThresholdPercent: 70,
    pauseThresholdPercent: 90,
    maxAutoCycles: 10,
    maxRepairCycles: 1,
  },
};

export async function loadConfig(configPath = "codexwatcher.config.json"): Promise<KeeperConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absolutePath, "utf8")) as Partial<KeeperConfig>;
  const openClaw =
    raw.brain?.source === "openclaw"
      ? await loadOpenClawBrainConfig({
          stateDir: raw.brain.openClawStateDir,
          agentId: raw.brain.openClawAgentId,
          modelRef: raw.brain.modelRef,
        })
      : null;
  const config: KeeperConfig = {
    workspaceRoots: raw.workspaceRoots?.map((root) => path.resolve(path.dirname(absolutePath), root)) ?? [],
    telegram: {
      botToken: resolveSecret(raw.telegram?.botToken) || openClaw?.telegramBotToken || "",
      mode: raw.telegram?.mode ?? "polling",
      publicWebhookUrl: raw.telegram?.publicWebhookUrl || process.env.PUBLIC_WEBHOOK_URL,
      port: raw.telegram?.port ?? Number(process.env.PORT ?? 8787),
      allowedChatIds: raw.telegram?.allowedChatIds ?? openClaw?.allowedChatIds,
      webhookSecretToken: resolveSecret(raw.telegram?.webhookSecretToken),
    },
    brain: openClaw?.brain ?? {
      source: raw.brain?.source ?? "direct",
      provider: raw.brain?.provider ?? "custom",
      model: raw.brain?.model ?? "codexwatcher-brain",
      baseUrl: raw.brain?.baseUrl ?? process.env.CODEXWATCHER_BRAIN_BASE_URL ?? "",
      apiKey: resolveSecret(raw.brain?.apiKey ?? "CODEXWATCHER_BRAIN_API_KEY"),
      api: raw.brain?.api ?? "openai-chat-completions",
      authHeader: raw.brain?.authHeader,
      headers: substituteEnv(raw.brain?.headers),
    },
    codex: {
      cautionThresholdPercent:
        raw.codex?.cautionThresholdPercent ?? DEFAULT_CONFIG.codex.cautionThresholdPercent,
      pauseThresholdPercent: raw.codex?.pauseThresholdPercent ?? DEFAULT_CONFIG.codex.pauseThresholdPercent,
      maxAutoCycles: raw.codex?.maxAutoCycles ?? 10,
      maxRepairCycles: raw.codex?.maxRepairCycles ?? 1,
    },
  };
  validateConfig(config);
  return config;
}

function substituteEnv(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      value.replace(/\$\{?([A-Z0-9_]+)\}?/gi, (_, name: string) => process.env[name] ?? ""),
    ]),
  );
}

export function resolveSecret(value: string | undefined): string {
  if (!value) return "";
  const envValue = process.env[value];
  return envValue || value;
}

function validateConfig(config: KeeperConfig): void {
  if (config.workspaceRoots.length === 0) {
    throw new Error("codexwatcher.config.json must include at least one workspace root.");
  }
  if (!config.telegram.botToken) {
    throw new Error("telegram.botToken is required, or set an env var named by telegram.botToken.");
  }
  if (!["webhook", "polling"].includes(config.telegram.mode)) {
    throw new Error("telegram.mode must be webhook or polling.");
  }
  if (config.telegram.mode === "webhook" && !config.telegram.publicWebhookUrl) {
    throw new Error("telegram.publicWebhookUrl or PUBLIC_WEBHOOK_URL is required for webhook mode.");
  }
  if (!config.brain.baseUrl) {
    throw new Error("brain.baseUrl or CODEXWATCHER_BRAIN_BASE_URL is required.");
  }
  if (!config.brain.apiKey && config.brain.authHeader !== false) {
    throw new Error("brain.apiKey is required, or set an env var named by brain.apiKey.");
  }
}
