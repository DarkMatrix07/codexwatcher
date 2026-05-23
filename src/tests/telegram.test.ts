import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../telegram/telegram.js";
import type { KeeperConfig, NormalizedMessage } from "../types.js";

test("telegram normalization rejects oversized uploads before download", async () => {
  const message = await normalize({
    update_id: 1,
    message: {
      chat: { id: 123 },
      caption: "task",
      document: { file_id: "file", file_name: "task.md", mime_type: "text/markdown", file_size: 600_000 },
    },
  });
  assert.equal(message?.fileText, undefined);
  assert.match(message?.fileError ?? "", /too large/);
});

test("telegram normalization rejects non-text task uploads", async () => {
  const message = await normalize({
    update_id: 1,
    message: {
      chat: { id: 123 },
      caption: "task",
      document: { file_id: "file", file_name: "mockup.png", mime_type: "image/png", file_size: 100 },
    },
  });
  assert.equal(message?.fileText, undefined);
  assert.match(message?.fileError ?? "", /text task files/);
});

async function normalize(update: unknown): Promise<NormalizedMessage | null> {
  const client = new TelegramClient({
    botToken: "fake",
    mode: "polling",
    allowedChatIds: [123],
  } satisfies KeeperConfig["telegram"]);
  return await (client as unknown as { normalize(update: unknown): Promise<NormalizedMessage | null> }).normalize(update);
}
