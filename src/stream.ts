import { markdownToTelegramHtml, splitMessage, TG_SAFE_LIMIT } from "./format";
import type { Telegram } from "./telegram";

const CURSOR = " ▍";

/**
 * Accumulates streamed chunks and renders them into ONE Telegram message via
 * throttled edits (ChatGPT-style live typing). On finalize the full text gets
 * a markdown→HTML pass and, if it outgrew one message, overflow segments are
 * sent as follow-up messages.
 */
export class StreamingReply {
  private full = "";
  private lastFlushAt = 0;
  private lastSent = "";
  private flushing = false;

  constructor(
    private readonly tg: Telegram,
    private readonly chatId: number,
    private readonly messageId: number,
    private readonly minIntervalMs = 1100,
  ) {}

  async append(text: string): Promise<void> {
    this.full += text;
    const now = Date.now();
    if (this.flushing || now - this.lastFlushAt < this.minIntervalMs) return;
    // Past one message worth of text: stop live edits, deliver the rest on finalize.
    if (this.full.length > TG_SAFE_LIMIT - CURSOR.length) return;
    const preview = this.full.trimEnd() + CURSOR;
    if (preview === this.lastSent || this.full.trim() === "") return;
    this.flushing = true;
    this.lastFlushAt = now;
    this.lastSent = preview;
    try {
      await this.tg.editPreview(this.chatId, this.messageId, preview);
    } finally {
      this.flushing = false;
    }
  }

  async finalize(overrideText?: string): Promise<void> {
    const raw = (overrideText ?? this.full).trim() || "The backend returned an empty response.";
    const segments = splitMessage(raw);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] ?? "";
      const html = markdownToTelegramHtml(segment);
      if (i === 0) await this.tg.editFinal(this.chatId, this.messageId, html, segment);
      else await this.tg.sendFinal(this.chatId, html, segment);
    }
  }

  async fail(message: string): Promise<void> {
    await this.tg.editPreview(this.chatId, this.messageId, message.slice(0, TG_SAFE_LIMIT));
  }
}
