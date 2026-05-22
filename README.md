# CodexWatcher

CodexWatcher is a quota-aware Codex development runner controlled through Telegram.

It accepts normal Telegram messages, resolves a project from configured workspace roots, asks a custom LLM brain to plan the next small task, runs Codex with `codex exec` / `codex exec resume`, requires Codex to write a structured report, reviews the result, commits safe progress, and sleeps when Codex usage is near the configured limit.

By default the example config uses `brain.source: "openclaw"`, which reads the active provider/model/base URL/API credential from `~/.openclaw/openclaw.json` plus `~/.openclaw/agents/main/agent/models.json`.

## MVP Commands

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js start --config codexwatcher.config.json
node dist/cli.js dev-message "Use the ecommerce project and implement task.md"
node dist/cli.js usage
npm run harness
```

`npm run harness` runs deterministic core workflow scenarios with mock Codex and fixture usage:

- quota sleep
- ambiguous work clarification
- missing Codex report
- failed validation gate
- resume with `codex exec resume <sessionId>`

## VPS Codex Login

```bash
npm i -g @openai/codex@latest
codex login --device-auth
```

For systemd deployment, see [docs/VPS.md](docs/VPS.md).

## Project State

Each project gets a `.keeper` folder:

- `task.md`
- `plan.md`
- `progress.md`
- `memory.md`
- `prompts.md`
- `responses.md`
- `state.json`
- `cycles/<id>/prompt.md`
- `cycles/<id>/codex-output.log`
- `cycles/<id>/codex-report.json`
- `cycles/<id>/agent-review.json`
