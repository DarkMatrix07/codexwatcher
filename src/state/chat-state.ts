import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ChatPendingClarification = {
  action: "status";
  createdAt: number;
  originalText?: string;
};

export type ChatHistoryEntry = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

export type ChatContext = {
  chatId: number;
  activeProjectId?: string;
  pending?: ChatPendingClarification;
  history?: ChatHistoryEntry[];
  updatedAt: string;
};

const STATE_DIR = ".codexwatcher";
const STATE_FILE = "chat-state.json";

export async function loadChatContext(chatId: number): Promise<ChatContext> {
  const all = await loadAllChatContexts();
  return (
    all[String(chatId)] ?? {
      chatId,
      updatedAt: new Date().toISOString(),
    }
  );
}

export async function saveChatContext(context: ChatContext): Promise<void> {
  const all = await loadAllChatContexts();
  all[String(context.chatId)] = {
    ...context,
    history: context.history?.slice(-20),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(stateDir(), { recursive: true });
  await writeFile(statePath(), JSON.stringify(all, null, 2), "utf8");
}

export function freshPending(pending: ChatPendingClarification | undefined): ChatPendingClarification | undefined {
  if (!pending) return undefined;
  return Date.now() - pending.createdAt <= 10 * 60_000 ? pending : undefined;
}

export async function appendChatHistory(
  chatId: number,
  entry: Omit<ChatHistoryEntry, "timestamp">,
): Promise<ChatContext> {
  const context = await loadChatContext(chatId);
  const next: ChatContext = {
    ...context,
    history: [
      ...(context.history ?? []),
      {
        ...entry,
        text: entry.text.slice(0, 2000),
        timestamp: new Date().toISOString(),
      },
    ].slice(-20),
  };
  await saveChatContext(next);
  return next;
}

async function loadAllChatContexts(): Promise<Record<string, ChatContext>> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as Record<string, ChatContext>;
  } catch {
    return {};
  }
}

function stateDir(): string {
  return path.join(process.cwd(), STATE_DIR);
}

function statePath(): string {
  return path.join(stateDir(), STATE_FILE);
}
