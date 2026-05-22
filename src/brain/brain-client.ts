import type { AgentReview, BrainIntent, BrainPlan, KeeperConfig } from "../types.js";

type BrainMessage = {
  role: "system" | "user";
  content: string;
};

export class BrainClient {
  constructor(private readonly config: KeeperConfig["brain"]) {}

  async interpret(input: {
    messageText: string;
    fileText?: string;
    repos: Array<{ name: string; path: string }>;
    activeProject?: string;
    recentHistory?: Array<{ role: "user" | "assistant"; text: string }>;
  }): Promise<BrainIntent> {
    return await this.completeJson<BrainIntent>([
      {
        role: "system",
        content:
          "You are CodexWatcher's conversation brain. Interpret Telegram messages naturally. Return only JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Classify intent and extract projectHint/taskText. Use activeProject and recentHistory to resolve references like 'that', 'there', or 'continue it'. Ask clarification when project or task is unclear.",
          allowedActions: ["clarify", "start_development", "status", "pause", "resume", "chat"],
          input,
          schema: {
            reply: "string",
            action: "clarify | start_development | status | pause | resume | chat",
            projectHint: "optional string",
            taskText: "optional string",
            needsClarification: "optional boolean",
            clarificationQuestion: "optional string",
          },
        }),
      },
    ]);
  }

  async plan(input: {
    task: string;
    taskFile: string;
    progress: string;
    memory: string;
    gitStatus: string;
    quotaMode: "work" | "caution";
  }): Promise<BrainPlan> {
    return await this.completeJson<BrainPlan>([
      {
        role: "system",
        content:
          "You are CodexWatcher's planning brain. Create a tiny implementation plan and one bounded next Codex task. Return only JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instructions:
            "Break work into small tasks. If quotaMode is caution, choose a very small task and include resume-safety language. Do not tell Codex to avoid .keeper files; CodexWatcher requires .keeper progress, memory, and report files. When a user says to edit only a file like README.md, treat that as applying to project source files outside .keeper.",
          input,
          schema: {
            reply: "string",
            tasks: [{ title: "string", description: "string", status: "pending | in_progress | completed" }],
            nextTask: { title: "string", prompt: "string" },
          },
        }),
      },
    ]);
  }

  async review(input: {
    taskTitle: string;
    codexReport: unknown;
    gitStatus: string;
    gitDiff: string;
    progress: string;
    memory: string;
  }): Promise<AgentReview> {
    return await this.completeJson<AgentReview>([
      {
        role: "system",
        content:
          "You are CodexWatcher's reviewer. Do not trust Codex claims. Decide if the task is complete from evidence. Return only JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instructions:
            "taskComplete requires Codex report evidence plus git/progress consistency. .keeper changes are expected CodexWatcher metadata and should not block completion by themselves. Focus on whether project/source files outside .keeper match the task and whether required .keeper progress/report evidence exists. If incomplete, choose ask_codex_to_fix.",
          input,
          schema: {
            taskComplete: "boolean",
            evidence: ["string"],
            missingItems: ["string"],
            nextAction: "commit_and_continue | ask_codex_to_fix | ask_user | sleep",
            reply: "string",
          },
        }),
      },
    ]);
  }

  async narrateStatus(input: {
    userMessage: string;
    projectName: string;
    state: string;
    lastCycleId?: string;
    resumeNote?: string;
    nextWakeAt?: string;
    gitSummary?: string;
    progress: string[];
    memory: string[];
    recentHistory: Array<{ role: "user" | "assistant"; text: string }>;
    projectHistory: Array<{ role: "user" | "assistant"; text: string }>;
  }): Promise<{ reply: string }> {
    return await this.completeJson<{ reply: string }>([
      {
        role: "system",
        content:
          "You are CodexWatcher's Telegram voice. Turn project status facts into a concise, natural update. Return only JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          instructions:
            "Write a friendly but compact Telegram message answering the current user message. Use projectHistory and recentHistory to resolve references and avoid repeating the previous wording. Use memory for resume/blocked/stopped context and progress for completed work. Do not use emojis. Do not invent facts, do not mention internal schemas, and keep it under 900 characters. Vary the wording naturally based on the user's wording: if they ask what is implemented, lead with implemented work; if they ask status, lead with current state. Include the project name and only the most useful facts.",
          input,
          schema: {
            reply: "string",
          },
        }),
      },
    ]);
  }

  private async completeJson<T>(messages: BrainMessage[]): Promise<T> {
    if (this.config.api === "anthropic-messages") {
      return await this.completeAnthropicMessages<T>(messages);
    }
    if (this.config.baseUrl.replace(/\/$/, "").endsWith("/responses")) {
      return await this.completeOpenAIResponses<T>(messages);
    }
    const url = normalizeBrainUrl(this.config.baseUrl);
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) {
      throw new Error(`Brain request failed: HTTP ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; output_text?: string; content?: string };
    const text = payload.output_text ?? payload.content ?? payload.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Brain response did not include text content.");
    }
    return JSON.parse(extractJson(text)) as T;
  }

  private async completeAnthropicMessages<T>(messages: BrainMessage[]): Promise<T> {
    const system = messages.find((message) => message.role === "system")?.content;
    const userMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: "user", content: message.content }));
    const response = await fetchWithTimeout(normalizeAnthropicUrl(this.config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...this.authHeaders(),
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 4096,
        temperature: 0.2,
        ...(system ? { system } : {}),
        messages: userMessages,
      }),
    });
    if (!response.ok) {
      throw new Error(`Brain request failed: HTTP ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      completion?: string;
      text?: string;
    };
    const text =
      payload.content?.find((part) => part.type === "text" || typeof part.text === "string")?.text ??
      payload.completion ??
      payload.text;
    if (!text) {
      throw new Error("Brain response did not include text content.");
    }
    return JSON.parse(extractJson(text)) as T;
  }

  private async completeOpenAIResponses<T>(messages: BrainMessage[]): Promise<T> {
    const input = messages.map((message) => ({
      role: message.role === "system" ? "system" : "user",
      content: message.content,
    }));
    const response = await fetchWithTimeout(normalizeResponsesUrl(this.config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify({
        model: this.config.model,
        input,
        temperature: 0.2,
        text: { format: { type: "json_object" } },
      }),
    });
    if (!response.ok) {
      throw new Error(`Brain request failed: HTTP ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((part) => part.text)?.text;
    if (!text) throw new Error("Brain response did not include text content.");
    return JSON.parse(extractJson(text)) as T;
  }

  private authHeaders(): Record<string, string> {
    const configured = this.config.headers ?? {};
    if (this.config.authHeader === false) {
      return configured;
    }
    return {
      authorization: `Bearer ${this.config.apiKey}`,
      ...configured,
    };
  }
}

function normalizeBrainUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions") || trimmed.endsWith("/responses")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function normalizeAnthropicUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const last = trimmed.lastIndexOf("}");
    if (last >= 0) return trimmed.slice(0, last + 1);
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  throw new Error("Could not extract JSON from brain response.");
}

function normalizeResponsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/responses")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/responses`;
  return `${trimmed}/v1/responses`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
