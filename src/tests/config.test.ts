import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveSecret } from "../config.js";

test("resolveSecret reads env var references", () => {
  process.env.TEST_CODEXWATCHER_SECRET = "actual";
  assert.equal(resolveSecret("TEST_CODEXWATCHER_SECRET"), "actual");
});

test("resolveSecret keeps literal values", () => {
  assert.equal(resolveSecret("literal-value"), "literal-value");
});

test("loadConfig requires an explicit chat allowlist by default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codexwatcher-config-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      workspaceRoots: [dir],
      telegram: { botToken: "fake", mode: "polling" },
      brain: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:9", apiKey: "fake" },
    }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(configPath), /allowedChatIds/);
});

test("loadConfig allows explicit unsafe chat mode for local testing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codexwatcher-config-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      workspaceRoots: [dir],
      telegram: { botToken: "fake", mode: "polling", allowAllChatsUnsafe: true },
      brain: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:9", apiKey: "fake" },
    }),
    "utf8",
  );
  const loaded = await loadConfig(configPath);
  assert.equal(loaded.telegram.allowAllChatsUnsafe, true);
});
