# VPS Setup

This guide installs CodexWatcher as a systemd service without touching unrelated services.

## 1. Prepare App Directory

```bash
mkdir -p /opt/codexwatcher /etc/codexwatcher /root/codexwatcher-workspaces
cd /opt/codexwatcher
git clone https://github.com/DarkMatrix07/codexwatcher.git .
npm ci
npm run check
npm run harness
```

## 2. Configure Secrets

```bash
cp deploy/codexwatcher.env.example /etc/codexwatcher/codexwatcher.env
chmod 600 /etc/codexwatcher/codexwatcher.env
nano /etc/codexwatcher/codexwatcher.env
```

Set:

```text
TELEGRAM_BOT_TOKEN=...
CUSTOM_CLAW_API_KEY=...
```

## 3. Configure CodexWatcher

```bash
cp deploy/codexwatcher.config.vps.example.json /etc/codexwatcher/codexwatcher.config.json
nano /etc/codexwatcher/codexwatcher.config.json
```

Set:

- `workspaceRoots` to folders containing project repos.
- `telegram.allowedChatIds` to the Telegram user ids allowed to control the bot.
- `telegram.mode` to `polling` first. Switch to `webhook` later after the domain/reverse proxy is ready.
- `brain.baseUrl` to the brain endpoint reachable from the VPS.

## 4. Authenticate Codex

```bash
npm i -g @openai/codex@latest
codex login --device-auth
node /opt/codexwatcher/dist/cli.js usage
```

The usage command must return OAuth usage before starting the daemon.

## 5. Install Service

```bash
cp /opt/codexwatcher/deploy/systemd/codexwatcher.service /etc/systemd/system/codexwatcher.service
systemctl daemon-reload
systemctl enable codexwatcher
systemctl start codexwatcher
systemctl status codexwatcher --no-pager
```

Logs:

```bash
journalctl -u codexwatcher -f
```

Stop safely:

```bash
systemctl stop codexwatcher
```

## 6. Update Deployment

```bash
cd /opt/codexwatcher
git pull --ff-only
npm ci
npm run check
npm run harness
systemctl restart codexwatcher
```

## Current Root-Based VPS Layout

For the current MVP VPS where the app lives at `/root/codexwatcher`, either move it to `/opt/codexwatcher` or edit the service:

```ini
WorkingDirectory=/root/codexwatcher
ExecStart=/usr/bin/node /root/codexwatcher/dist/cli.js start --config /root/codexwatcher/codexwatcher.config.json
EnvironmentFile=/root/codexwatcher/.env
```

Run `systemctl cat codexwatcher` after editing to confirm systemd is using the expected paths.
