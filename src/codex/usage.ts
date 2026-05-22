import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexUsage } from "../types.js";

type CodexAuth = {
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  account_id?: string;
  accountId?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
};

export async function checkCodexUsage(): Promise<CodexUsage> {
  const fixture = usageViaFixture();
  if (fixture) return fixture;
  const oauth = await usageViaOAuth();
  if (oauth.source !== "unavailable") return oauth;
  const cli = await usageViaCliRpc().catch((error) => unavailable(error));
  if (cli.source !== "unavailable") return cli;
  return {
    source: "unavailable",
    primaryUsedPercent: null,
    primaryResetAt: null,
    secondaryUsedPercent: null,
    secondaryResetAt: null,
    creditsBalance: null,
    plan: null,
    error: `${oauth.error ?? ""} ${cli.error ?? ""}`.trim() || "Codex usage unavailable.",
  };
}

function usageViaFixture(): CodexUsage | null {
  const raw = process.env.CODEXWATCHER_USAGE_FIXTURE;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CodexUsage>;
    return {
      source: parsed.source ?? "oauth",
      primaryUsedPercent: parsed.primaryUsedPercent ?? null,
      primaryResetAt: parsed.primaryResetAt ?? null,
      secondaryUsedPercent: parsed.secondaryUsedPercent ?? null,
      secondaryResetAt: parsed.secondaryResetAt ?? null,
      creditsBalance: parsed.creditsBalance ?? null,
      plan: parsed.plan ?? "fixture",
      error: parsed.error,
    };
  } catch (error) {
    return unavailable(error);
  }
}

async function usageViaOAuth(): Promise<CodexUsage> {
  try {
    const authPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json");
    const auth = JSON.parse(await readFile(authPath, "utf8")) as CodexAuth;
    const token = auth.access_token ?? auth.accessToken ?? auth.tokens?.access_token;
    if (!token) throw new Error("No access token in auth.json.");
    const accountId = auth.account_id ?? auth.accountId ?? auth.tokens?.account_id;
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(accountId
          ? { "ChatGPT-Account-Id": String(accountId) }
          : {}),
      },
    });
    if (!response.ok) throw new Error(`OAuth usage HTTP ${response.status}`);
    const body = (await response.json()) as CodexUsageResponse;
    return mapUsageResponse(body, "oauth");
  } catch (error) {
    return unavailable(error);
  }
}

type CodexUsageResponse = {
  plan_type?: string;
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
    secondary_window?: { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
  };
  credits?: { balance?: number | string | null };
};

function mapUsageResponse(body: CodexUsageResponse, source: "oauth" | "cli"): CodexUsage {
  return {
    source,
    primaryUsedPercent: numberOrNull(body.rate_limit?.primary_window?.used_percent),
    primaryResetAt: epochOrNull(body.rate_limit?.primary_window?.reset_at),
    secondaryUsedPercent: numberOrNull(body.rate_limit?.secondary_window?.used_percent),
    secondaryResetAt: epochOrNull(body.rate_limit?.secondary_window?.reset_at),
    creditsBalance: numberOrNull(body.credits?.balance),
    plan: body.plan_type ?? null,
  };
}

async function usageViaCliRpc(): Promise<CodexUsage> {
  return await new Promise((resolve) => {
    const child = spawn("codex", ["-s", "read-only", "-a", "untrusted", "app-server"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(unavailable(new Error("Codex app-server usage check timed out.")));
    }, 30_000);
    const rl = createInterface({ input: child.stdout });
    let id = 1;
    const pending = new Map<number, (value: unknown) => void>();
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)?.(msg.result ?? msg.error);
          pending.delete(msg.id);
        }
      } catch {
        // Ignore non-JSON startup chatter.
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve(unavailable(error));
    });
    const request = (method: string, params: unknown = {}) => {
      const requestId = id++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      return new Promise<unknown>((done) => pending.set(requestId, done));
    };
    void (async () => {
      try {
        await request("initialize", { clientInfo: { name: "codexwatcher", version: "0.1.0" } });
        const account = (await request("account/read")) as Record<string, unknown>;
        const limits = (await request("account/rateLimits/read")) as Record<string, unknown>;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve(mapRpcUsage(limits, account));
      } catch (error) {
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve(unavailable(error));
      }
    })();
  });
}

function mapRpcUsage(limits: Record<string, unknown>, account: Record<string, unknown>): CodexUsage {
  const root = (limits.rateLimits ?? limits.rate_limits ?? limits) as Record<string, unknown>;
  const primary = (root.primaryWindow ?? root.primary_window) as Record<string, unknown> | undefined;
  const secondary = (root.secondaryWindow ?? root.secondary_window) as Record<string, unknown> | undefined;
  return {
    source: "cli",
    primaryUsedPercent: numberOrNull(primary?.usedPercent ?? primary?.used_percent),
    primaryResetAt: epochOrNull(primary?.resetAt ?? primary?.reset_at),
    secondaryUsedPercent: numberOrNull(secondary?.usedPercent ?? secondary?.used_percent),
    secondaryResetAt: epochOrNull(secondary?.resetAt ?? secondary?.reset_at),
    creditsBalance: numberOrNull((root.credits as Record<string, unknown> | undefined)?.balance),
    plan: String(account.planType ?? account.plan_type ?? root.planType ?? root.plan_type ?? "") || null,
  };
}

function unavailable(error: unknown): CodexUsage {
  return {
    source: "unavailable",
    primaryUsedPercent: null,
    primaryResetAt: null,
    secondaryUsedPercent: null,
    secondaryResetAt: null,
    creditsBalance: null,
    plan: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function epochOrNull(value: unknown): string | null {
  const n = numberOrNull(value);
  if (n === null) return null;
  return new Date(n * 1000).toISOString();
}
