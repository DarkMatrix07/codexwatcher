import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOpenClawBrainConfig } from "../brain/openclaw-config.js";

test("loads OpenClaw brain provider from state dir", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codexwatcher-openclaw-"));
  await mkdir(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      env: { CUSTOM_CLAW_API_KEY: "secret" },
      agents: { defaults: { model: { primary: "customclaw/gpt-5.5" } } },
      models: {
        providers: {
          customclaw: {
            baseUrl: "http://example.local:3000",
            api: "anthropic-messages",
            authHeader: false,
            headers: { Authorization: "Bearer ${CUSTOM_CLAW_API_KEY}" },
          },
        },
      },
      channels: { telegram: { botToken: "telegram-token" } },
      commands: { ownerAllowFrom: ["telegram:12345"] },
    }),
  );
  await writeFile(path.join(stateDir, "agents", "main", "agent", "models.json"), JSON.stringify({ providers: {} }));
  const loaded = await loadOpenClawBrainConfig({ stateDir });
  assert.equal(loaded.brain.provider, "customclaw");
  assert.equal(loaded.brain.model, "gpt-5.5");
  assert.equal(loaded.brain.baseUrl, "http://example.local:3000");
  assert.equal(loaded.brain.api, "anthropic-messages");
  assert.equal(loaded.brain.apiKey, "secret");
  assert.equal(loaded.brain.headers?.Authorization, "Bearer secret");
  assert.equal(loaded.telegramBotToken, "telegram-token");
  assert.deepEqual(loaded.allowedChatIds, [12345]);
});
