interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

const isNotModified = (e: unknown): boolean =>
  e instanceof TelegramError && e.code === 400 && e.message.includes("message is not modified");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Telegram {
  // Wrapped instead of a bare `fetch` reference: detaching fetch from
  // globalThis throws "Illegal invocation" inside workerd.
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(method: string, payload: Record<string, unknown>, attempt = 0): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as TgApiResponse<T>;
    if (data.ok && data.result !== undefined) return data.result;
    // Respect Telegram's own back-off hint exactly once, then give up.
    if (data.error_code === 429 && attempt < 1) {
      await sleep(((data.parameters?.retry_after ?? 1) + 0.2) * 1000);
      return this.call(method, payload, attempt + 1);
    }
    throw new TelegramError(data.description ?? `${method} failed`, data.error_code ?? 0);
  }

  sendMessage(chatId: number, text: string): Promise<{ message_id: number }> {
    return this.call("sendMessage", { chat_id: chatId, text });
  }

  sendChatAction(chatId: number, action = "typing"): Promise<boolean> {
    return this.call("sendChatAction", { chat_id: chatId, action });
  }

  /** Streaming preview edit: never throws — a lost frame must not kill the stream. */
  async editPreview(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text });
    } catch (e) {
      if (!isNotModified(e)) console.warn("preview edit failed:", (e as Error).message);
    }
  }

  /** Final edit: try formatted HTML, fall back to plain text if Telegram rejects the markup. */
  async editFinal(chatId: number, messageId: number, html: string, plain: string): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      if (isNotModified(e)) return;
      await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: plain }).catch(
        (e2: unknown) => {
          if (!isNotModified(e2)) throw e2;
        },
      );
    }
  }

  /** Overflow segments beyond the first message. */
  async sendFinal(chatId: number, html: string, plain: string): Promise<void> {
    try {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch {
      await this.call("sendMessage", { chat_id: chatId, text: plain });
    }
  }

  setWebhook(url: string, secretToken: string): Promise<boolean> {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
  }
}
