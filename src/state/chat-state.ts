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
  projectId?: string;
};

export type ChatProjectMemory = {
  projectId: string;
  projectName: string;
  lastSelectedAt: string;
  history: ChatHistoryEntry[];
};

export type ChatContext = {
  chatId: number;
  activeProjectId?: string;
  pending?: ChatPendingClarification;
  history?: ChatHistoryEntry[];
  projects?: Record<string, ChatProjectMemory>;
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
    projects: trimProjectMemories(context.projects),
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

export async function rememberActiveProject(
  chatId: number,
  project: { id?: string; name: string },
): Promise<ChatContext> {
  const projectId = project.id ?? project.name;
  const context = await loadChatContext(chatId);
  const existing = context.projects?.[projectId];
  const next: ChatContext = {
    ...context,
    activeProjectId: projectId,
    pending: undefined,
    projects: {
      ...(context.projects ?? {}),
      [projectId]: {
        projectId,
        projectName: project.name,
        lastSelectedAt: new Date().toISOString(),
        history: existing?.history ?? [],
      },
    },
  };
  await saveChatContext(next);
  return next;
}

export async function appendProjectChatHistory(
  chatId: number,
  project: { id?: string; name: string },
  entry: Omit<ChatHistoryEntry, "timestamp" | "projectId">,
): Promise<ChatContext> {
  const projectId = project.id ?? project.name;
  const context = await loadChatContext(chatId);
  const existing = context.projects?.[projectId];
  const stamped: ChatHistoryEntry = {
    ...entry,
    projectId,
    text: entry.text.slice(0, 2000),
    timestamp: new Date().toISOString(),
  };
  const next: ChatContext = {
    ...context,
    activeProjectId: projectId,
    projects: {
      ...(context.projects ?? {}),
      [projectId]: {
        projectId,
        projectName: project.name,
        lastSelectedAt: existing?.lastSelectedAt ?? new Date().toISOString(),
        history: [...(existing?.history ?? []), stamped].slice(-20),
      },
    },
  };
  await saveChatContext(next);
  return next;
}

export function getProjectHistory(
  context: ChatContext,
  project: { id?: string; name: string },
  limit = 8,
): ChatHistoryEntry[] {
  const projectId = project.id ?? project.name;
  return context.projects?.[projectId]?.history.slice(-limit) ?? [];
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

function trimProjectMemories(
  projects: Record<string, ChatProjectMemory> | undefined,
): Record<string, ChatProjectMemory> | undefined {
  if (!projects) return undefined;
  const entries = Object.entries(projects)
    .sort((a, b) => Date.parse(b[1].lastSelectedAt) - Date.parse(a[1].lastSelectedAt))
    .slice(0, 50)
    .map(([key, value]) => [
      key,
      {
        ...value,
        history: value.history.slice(-20),
      },
    ]);
  return Object.fromEntries(entries) as Record<string, ChatProjectMemory>;
}
