import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KeeperConfig } from "../types.js";

type OpenClawConfig = {
  env?: Record<string, string>;
  agents?: { defaults?: { model?: { primary?: string } } };
  models?: { providers?: Record<string, OpenClawProviderConfig> };
  channels?: { telegram?: { botToken?: string } };
  commands?: { ownerAllowFrom?: string[] };
};

type OpenClawModels = {
  providers?: Record<string, OpenClawProviderConfig>;
};

type OpenClawProviderConfig = {
  baseUrl?: string;
  apiKey?: string | { source?: string; id?: string };
  api?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: Array<{ id?: string; name?: string }>;
};

export async function loadOpenClawBrainConfig(params: {
  stateDir?: string;
  agentId?: string;
  modelRef?: string;
}): Promise<{
  brain: KeeperConfig["brain"];
  telegramBotToken?: string;
  allowedChatIds?: number[];
}> {
  const stateDir = path.resolve(params.stateDir ?? path.join(os.homedir(), ".openclaw"));
  const agentId = params.agentId ?? "main";
  const openClawPath = path.join(stateDir, "openclaw.json");
  const agentModelsPath = path.join(stateDir, "agents", agentId, "agent", "models.json");
  const openClaw = JSON.parse(await readFile(openClawPath, "utf8")) as OpenClawConfig;
  const agentModels = await readJsonIfExists<OpenClawModels>(agentModelsPath);
  const modelRef = params.modelRef ?? openClaw.agents?.defaults?.model?.primary;
  if (!modelRef) {
    throw new Error("OpenClaw config does not define agents.defaults.model.primary.");
  }
  const [providerId, modelId] = splitModelRef(modelRef);
  const globalProvider = openClaw.models?.providers?.[providerId];
  const agentProvider = agentModels?.providers?.[providerId];
  const provider =
    globalProvider || agentProvider
      ? {
          ...(globalProvider ?? {}),
          ...(agentProvider ?? {}),
          headers: {
            ...(globalProvider?.headers ?? {}),
            ...(agentProvider?.headers ?? {}),
          },
        }
      : undefined;
  if (!provider) {
    throw new Error(`OpenClaw provider "${providerId}" was not found.`);
  }
  if (!provider.baseUrl) {
    throw new Error(`OpenClaw provider "${providerId}" does not define baseUrl.`);
  }
  const env = normalizeEnv({ ...(openClaw.env ?? {}), ...process.env });
  const headers = substituteEnv(provider.headers ?? {}, env);
  const apiKey = resolveOpenClawApiKey(provider, env);
  return {
    brain: {
      source: "openclaw",
      provider: providerId,
      model: modelId,
      modelRef,
      baseUrl: provider.baseUrl,
      apiKey,
      api: normalizeOpenClawApi(provider.api),
      authHeader: provider.authHeader,
      headers,
      openClawStateDir: stateDir,
      openClawAgentId: agentId,
    },
    telegramBotToken: openClaw.channels?.telegram?.botToken,
    allowedChatIds: parseTelegramOwnerIds(openClaw.commands?.ownerAllowFrom),
  };
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function splitModelRef(modelRef: string): [string, string] {
  const [provider, ...rest] = modelRef.split("/");
  const model = rest.join("/");
  if (!provider || !model) throw new Error(`Invalid OpenClaw model ref "${modelRef}".`);
  return [provider, model];
}

function resolveOpenClawApiKey(provider: OpenClawProviderConfig, env: Record<string, string>): string {
  if (typeof provider.apiKey === "string") {
    return substituteEnvValue(provider.apiKey, env);
  }
  if (provider.apiKey?.source === "env" && provider.apiKey.id) {
    return env[provider.apiKey.id] ?? process.env[provider.apiKey.id] ?? "";
  }
  const authorization = provider.headers?.Authorization ?? provider.headers?.authorization;
  const substituted = authorization ? substituteEnvValue(authorization, env) : "";
  const bearer = substituted.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? "";
}

function substituteEnv(headers: Record<string, string>, env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, substituteEnvValue(value, env)]));
}

function normalizeEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function substituteEnvValue(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{?([A-Z0-9_]+)\}?/gi, (_, name: string) => env[name] ?? process.env[name] ?? "");
}

function normalizeOpenClawApi(api: string | undefined): KeeperConfig["brain"]["api"] {
  if (api === "anthropic-messages") return "anthropic-messages";
  return "openai-chat-completions";
}

function parseTelegramOwnerIds(values: string[] | undefined): number[] | undefined {
  const ids = values
    ?.map((value) => value.match(/^telegram:(\d+)$/)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .filter(Number.isFinite);
  return ids?.length ? ids : undefined;
}
