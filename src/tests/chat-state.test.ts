import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendChatHistory,
  appendProjectChatHistory,
  getProjectHistory,
  loadChatContext,
  rememberActiveProject,
  saveChatContext,
} from "../state/chat-state.js";

test("chat state stores active project and scoped memory", async () => {
  await withTempCwd(async () => {
    await rememberActiveProject(123, { id: "demo-clean-flow", name: "demo-clean-flow" });
    await appendChatHistory(123, { role: "user", text: "status" });
    await appendProjectChatHistory(123, { id: "demo-clean-flow", name: "demo-clean-flow" }, { role: "user", text: "status" });

    let context = await loadChatContext(123);
    assert.equal(context.activeProjectId, "demo-clean-flow");
    assert.equal(context.history?.at(-1)?.text, "status");
    assert.equal(getProjectHistory(context, { id: "demo-clean-flow", name: "demo-clean-flow" }).at(-1)?.text, "status");

    await rememberActiveProject(123, { id: "demo", name: "demo" });
    for (let index = 0; index < 25; index += 1) {
      await appendChatHistory(123, { role: "user", text: `global ${index}` });
      await appendProjectChatHistory(123, { id: "demo", name: "demo" }, { role: "assistant", text: `project ${index}` });
    }

    context = await loadChatContext(123);
    assert.equal(context.history?.length, 20);
    assert.equal(getProjectHistory(context, { id: "demo", name: "demo" }, 20).length, 20);
    assert.equal(context.history?.[0].text, "global 5");
    assert.equal(getProjectHistory(context, { id: "demo", name: "demo" }, 20)[0].text, "project 5");

    await saveChatContext({
      chatId: 456,
      updatedAt: new Date().toISOString(),
      projects: Object.fromEntries(
        Array.from({ length: 55 }, (_, index) => [
          `project-${index}`,
          {
            projectId: `project-${index}`,
            projectName: `project-${index}`,
            lastSelectedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            history: [],
          },
        ]),
      ),
    });

    context = await loadChatContext(456);
    assert.equal(Object.keys(context.projects ?? {}).length, 50);
    assert.equal(context.projects?.["project-54"]?.projectName, "project-54");
    assert.equal(context.projects?.["project-0"], undefined);
  });
});

async function withTempCwd(run: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const temp = await mkdtemp(path.join(os.tmpdir(), "codexwatcher-chat-state-"));
  process.chdir(temp);
  try {
    await run();
  } finally {
    process.chdir(previous);
    await rm(temp, { recursive: true, force: true });
  }
}
