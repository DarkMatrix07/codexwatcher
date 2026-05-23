import http from "node:http";
import type { KeeperConfig, NormalizedMessage } from "../types.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    caption?: string;
    document?: { file_id: string; file_name?: string };
  };
};

export class TelegramClient {
  private offset = 0;

  constructor(private readonly config: KeeperConfig["telegram"]) {}

  async sendMessage(chatId: number, text: string): Promise<void> {
    for (const chunk of splitTelegramText(text)) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
  }

  async setWebhook(): Promise<void> {
    if (!this.config.publicWebhookUrl) throw new Error("publicWebhookUrl is required for webhook mode.");
    await this.call("setWebhook", {
      url: this.config.publicWebhookUrl,
      ...(this.config.webhookSecretToken ? { secret_token: this.config.webhookSecretToken } : {}),
    });
  }

  async startPolling(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<void> {
    for (;;) {
      try {
        const updates = (await this.call("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message"],
        })) as TelegramUpdate[];
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const message = await this.normalize(update);
          if (message) await onMessage(message);
        }
      } catch (error) {
        console.error("Telegram polling failed:", error instanceof Error ? error.message : error);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  async startWebhook(onMessage: (message: NormalizedMessage) => Promise<void>): Promise<void> {
    await this.setWebhook();
    const port = this.config.port ?? 8787;
    const server = http.createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(200);
        response.end("CodexWatcher");
        return;
      }
      if (
        this.config.webhookSecretToken &&
        request.headers["x-telegram-bot-api-secret-token"] !== this.config.webhookSecretToken
      ) {
        response.writeHead(401);
        response.end("Unauthorized");
        return;
      }
      let body = "";
      let tooLarge = false;
      request.on("data", (chunk) => {
        body += String(chunk);
        if (body.length > 1024 * 1024) {
          tooLarge = true;
          request.destroy();
        }
      });
      request.on("end", () => {
        if (tooLarge) {
          response.writeHead(413);
          response.end("Payload too large");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        void (async () => {
          try {
            const message = await this.normalize(JSON.parse(body) as TelegramUpdate);
            if (message) await onMessage(message);
          } catch (error) {
            console.error("Telegram webhook handling failed:", error instanceof Error ? error.message : error);
          }
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(port, resolve));
    console.log(`Telegram webhook listening on port ${port}`);
  }

  private async normalize(update: TelegramUpdate): Promise<NormalizedMessage | null> {
    const source = update.message;
    if (!source) return null;
    const text = source.text ?? source.caption ?? "";
    if (!this.isAllowedChat(source.chat.id)) {
      return {
        chatId: source.chat.id,
        text,
        raw: update,
      };
    }
    let fileText: string | undefined;
    let fileName = source.document?.file_name;
    if (source.document?.file_id) {
      fileText = await this.downloadTextFile(source.document.file_id);
    }
    return {
      chatId: source.chat.id,
      text,
      fileName,
      fileText,
      raw: update,
    };
  }

  private async downloadTextFile(fileId: string): Promise<string> {
    const file = (await this.call("getFile", { file_id: fileId })) as { file_path: string };
    const url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 512_000) throw new Error("Telegram document is too large for MVP task upload.");
    return text;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!payload.ok) {
      throw new Error(`Telegram ${method} failed: ${payload.description ?? response.statusText}`);
    }
    return payload.result;
  }

  private isAllowedChat(chatId: number): boolean {
    const allowed = this.config.allowedChatIds;
    return this.config.allowAllChatsUnsafe === true || allowed?.includes(chatId) === true;
  }
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 3900) {
    chunks.push(text.slice(i, i + 3900));
  }
  return chunks.length ? chunks : [""];
}
