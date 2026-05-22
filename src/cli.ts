#!/usr/bin/env node
import { copyFile, access } from "node:fs/promises";
import path from "node:path";
import { CodexKeeperApp } from "./app.js";
import { loadConfig } from "./config.js";
import { checkCodexUsage } from "./codex/usage.js";
import { runCoreHarness } from "./harness/core-harness.js";
import { discoverRepos } from "./workspace/workspace.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const configPath = readFlag(args, "--config") ?? "codexwatcher.config.json";
  switch (command) {
    case "init":
      await initConfig();
      break;
    case "start": {
      const config = await loadConfig(configPath);
      await new CodexKeeperApp(config).start();
      break;
    }
    case "dev-message": {
      const config = await loadConfig(configPath);
      const message = args.filter((arg) => arg !== "--config" && arg !== configPath).join(" ");
      if (!message) throw new Error('Usage: codexwatcher dev-message "message"');
      await new CodexKeeperApp(config).handleDevMessage(message);
      break;
    }
    case "usage":
      console.log(JSON.stringify(await checkCodexUsage(), null, 2));
      break;
    case "repos": {
      const config = await loadConfig(configPath);
      console.log(JSON.stringify(await discoverRepos(config.workspaceRoots), null, 2));
      break;
    }
    case "harness":
      await runCoreHarness();
      break;
    default:
      printHelp();
  }
}

async function initConfig(): Promise<void> {
  const target = path.resolve("codexwatcher.config.json");
  try {
    await access(target);
    console.log("codexwatcher.config.json already exists.");
    return;
  } catch {
    await copyFile(path.resolve("codexwatcher.config.example.json"), target);
    console.log("Created codexwatcher.config.json from codexwatcher.config.example.json.");
  }
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`CodexWatcher

Commands:
  init                         Create codexwatcher.config.json
  start [--config path]         Start Telegram webhook/polling runtime
  dev-message "text"            Simulate a Telegram message locally
  usage                         Print Codex usage
  repos [--config path]         List discovered git repos
  harness                       Run deterministic core workflow harness
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
