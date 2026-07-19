import { markdownToTelegramHtml, splitMessage, TG_SAFE_LIMIT } from "./format";
import type { Telegram } from "./telegram";

export const CURSOR = " ▍";
/** Telegram allows roughly one message per second per chat. */
const SEGMENT_PAUSE_MS = 1100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stopMarkup = (taskId: string) => ({
  inline_keyboard: [[{ text: "⏹ Stop", callback_data: `st:${taskId}` }]],
});

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
  private taskId: string | null = null;

  constructor(
    private readonly tg: Telegram,
    private readonly chatId: number,
    private readonly messageId: number,
    private readonly minIntervalMs = 1100,
  ) {}

  /** Text accumulated so far — used to append citations before finalizing. */
  get text(): string {
    return this.full;
  }

  /** Once known, every preview edit carries a Stop button for this generation. */
  setTaskId(taskId: string): void {
    this.taskId = taskId;
  }

  /** Tool/agent progress, shown only until the first token of real text lands. */
  async setStatus(text: string): Promise<void> {
    if (this.full !== "" || this.flushing) return;
    const now = Date.now();
    if (now - this.lastFlushAt < this.minIntervalMs) return;
    if (text === this.lastSent) return;
    this.flushing = true;
    this.lastFlushAt = now;
    this.lastSent = text;
    try {
      await this.tg.editPreview(this.chatId, this.messageId, text, this.markup());
    } finally {
      this.flushing = false;
    }
  }

  /** Dify moderation can replace the whole answer mid-stream. */
  replace(text: string): void {
    this.full = text;
    this.lastSent = "";
  }

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
      await this.tg.editPreview(this.chatId, this.messageId, preview, this.markup());
    } finally {
      this.flushing = false;
    }
  }

  async finalize(overrideText?: string, finalMarkup?: unknown): Promise<void> {
    const raw = (overrideText ?? this.full).trim() || "The backend returned an empty response.";
    const segments = splitMessage(raw);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] ?? "";
      const html = markdownToTelegramHtml(segment);
      const isLast = i === segments.length - 1;
      const markup = isLast ? finalMarkup : undefined;
      if (i === 0) {
        await this.tg.editFinal(this.chatId, this.messageId, html, segment, markup);
      } else {
        // Firing segments back-to-back trips Telegram's per-chat rate limit.
        await sleep(SEGMENT_PAUSE_MS);
        await this.tg.sendFinal(this.chatId, html, segment, markup);
      }
    }
  }

  /**
   * Keep whatever already reached the user: an error after 2000 streamed
   * characters must not wipe what they were reading.
   */
  async fail(message: string): Promise<void> {
    if (this.full.trim() !== "") {
      await this.finalize(`${this.full}\n\n${message}`);
      return;
    }
    await this.tg.editPreview(this.chatId, this.messageId, message.slice(0, TG_SAFE_LIMIT));
  }

  private markup(): unknown {
    return this.taskId ? stopMarkup(this.taskId) : undefined;
  }
}
