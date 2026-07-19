import { redactSecrets } from "./redact";

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

/** Previews are disposable; final deliveries are not, so they get more retries. */
const PREVIEW_RETRIES = 1;
const FINAL_RETRIES = 3;

export class Telegram {
  // Wrapped instead of a bare `fetch` reference: detaching fetch from
  // globalThis throws "Illegal invocation" inside workerd.
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    maxRetries = PREVIEW_RETRIES,
    attempt = 0,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // Network errors carry the request URL — and the URL carries the token.
      throw new Error(redactSecrets(e));
    }
    const data = (await res.json()) as TgApiResponse<T>;
    if (data.ok && data.result !== undefined) return data.result;
    if (data.error_code === 429 && attempt < maxRetries) {
      await sleep(((data.parameters?.retry_after ?? 1) + 0.2) * 1000);
      return this.call(method, payload, maxRetries, attempt + 1);
    }
    throw new TelegramError(data.description ?? `${method} failed`, data.error_code ?? 0);
  }

  /** Multipart variant for media. The runtime sets content-type + boundary. */
  private async callForm<T>(method: string, form: FormData, maxRetries = FINAL_RETRIES, attempt = 0): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        body: form,
      });
    } catch (e) {
      throw new Error(redactSecrets(e));
    }
    const data = (await res.json()) as TgApiResponse<T>;
    if (data.ok && data.result !== undefined) return data.result;
    if (data.error_code === 429 && attempt < maxRetries) {
      await sleep(((data.parameters?.retry_after ?? 1) + 0.2) * 1000);
      return this.callForm(method, form, maxRetries, attempt + 1);
    }
    throw new TelegramError(data.description ?? `${method} failed`, data.error_code ?? 0);
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<{ message_id: number }> {
    return this.call("sendMessage", { chat_id: chatId, text, ...extra }, FINAL_RETRIES);
  }

  sendChatAction(chatId: number, action = "typing"): Promise<boolean> {
    return this.call("sendChatAction", { chat_id: chatId, action });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async editReplyMarkup(chatId: number, messageId: number, markup: unknown): Promise<void> {
    try {
      await this.call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: markup ?? { inline_keyboard: [] },
      });
    } catch (e) {
      if (!isNotModified(e)) console.warn("markup edit failed:", redactSecrets(e));
    }
  }

  getFile(fileId: string): Promise<{ file_path?: string }> {
    return this.call("getFile", { file_id: fileId }, FINAL_RETRIES);
  }

  /** The only place a file URL (which embeds the token) is constructed. */
  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    } catch (e) {
      throw new Error(redactSecrets(e));
    }
    if (!res.ok) throw new TelegramError(`file download failed (${res.status})`, res.status);
    return res.arrayBuffer();
  }

  sendPhoto(chatId: number, bytes: ArrayBuffer, extra: Record<string, string> = {}): Promise<{ message_id: number }> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([bytes]), "image.jpg");
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return this.callForm("sendPhoto", form);
  }

  /** Streaming preview edit: never throws — a lost frame must not kill the stream. */
  async editPreview(chatId: number, messageId: number, text: string, markup?: unknown): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(markup ? { reply_markup: markup } : {}),
      });
    } catch (e) {
      if (!isNotModified(e)) console.warn("preview edit failed:", redactSecrets(e));
    }
  }

  /**
   * Final edit: try formatted HTML, fall back to plain text only when Telegram
   * rejects the *markup* (400). A 429 means "slow down", not "bad HTML" — the
   * retry ladder above handles it, and dropping formatting there would be wrong.
   */
  async editFinal(chatId: number, messageId: number, html: string, plain: string, markup?: unknown): Promise<void> {
    try {
      await this.call(
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(markup ? { reply_markup: markup } : {}),
        },
        FINAL_RETRIES,
      );
    } catch (e) {
      if (isNotModified(e)) return;
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
      await this.call(
        "editMessageText",
        { chat_id: chatId, message_id: messageId, text: plain, ...(markup ? { reply_markup: markup } : {}) },
        FINAL_RETRIES,
      ).catch((e2: unknown) => {
        if (!isNotModified(e2)) throw e2;
      });
    }
  }

  /** Overflow segments beyond the first message. */
  async sendFinal(chatId: number, html: string, plain: string, markup?: unknown): Promise<void> {
    try {
      await this.call(
        "sendMessage",
        {
          chat_id: chatId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(markup ? { reply_markup: markup } : {}),
        },
        FINAL_RETRIES,
      );
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
      await this.call(
        "sendMessage",
        { chat_id: chatId, text: plain, ...(markup ? { reply_markup: markup } : {}) },
        FINAL_RETRIES,
      );
    }
  }

  getMe(): Promise<{ id: number; username?: string }> {
    return this.call("getMe", {}, FINAL_RETRIES);
  }

  setWebhook(url: string, secretToken: string): Promise<boolean> {
    return this.call(
      "setWebhook",
      {
        url,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      },
      FINAL_RETRIES,
    );
  }
}
