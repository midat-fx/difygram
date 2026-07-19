import { describe, expect, it, vi } from "vitest";
import { Telegram, TelegramError } from "../src/telegram";

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
const fail = (code: number, description: string, retryAfter?: number) =>
  new Response(
    JSON.stringify({
      ok: false,
      error_code: code,
      description,
      ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}),
    }),
  );

describe("Telegram client", () => {
  it("falls back to plain text when Telegram rejects the markup (400)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fail(400, "can't parse entities"))
      .mockResolvedValueOnce(ok({ message_id: 1 }));
    const tg = new Telegram("t", fetchFn as unknown as typeof fetch);
    await tg.editFinal(1, 2, "<b>broken", "broken");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondBody.parse_mode).toBeUndefined();
    expect(secondBody.text).toBe("broken");
  });

  it("does NOT drop formatting on 429 — it waits and retries", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(fail(429, "Too Many Requests", 1))
        .mockResolvedValueOnce(ok({ message_id: 1 }));
      const tg = new Telegram("t", fetchFn as unknown as typeof fetch);
      const done = tg.editFinal(1, 2, "<b>fine</b>", "fine");
      await vi.runAllTimersAsync();
      await done;
      expect(fetchFn).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string);
      expect(retryBody.parse_mode).toBe("HTML"); // formatting survived
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a final delivery up to three times on 429", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(fail(429, "slow down", 1))
        .mockResolvedValueOnce(fail(429, "slow down", 1))
        .mockResolvedValueOnce(fail(429, "slow down", 1))
        .mockResolvedValueOnce(ok({ message_id: 7 }));
      const tg = new Telegram("t", fetchFn as unknown as typeof fetch);
      const done = tg.sendMessage(1, "hi");
      await vi.runAllTimersAsync();
      await done;
      expect(fetchFn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives previews a single retry only", async () => {
    vi.useFakeTimers();
    try {
      // A fresh Response per call: a body can only be read once.
      const fetchFn = vi.fn().mockImplementation(async () => fail(429, "slow down", 1));
      const tg = new Telegram("t", fetchFn as unknown as typeof fetch);
      const done = tg.editPreview(1, 2, "text"); // swallows the final error by design
      await vi.runAllTimersAsync();
      await done;
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes to callback queries, otherwise buttons never fire", async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok(true));
    const tg = new Telegram("t", fetchFn as unknown as typeof fetch);
    await tg.setWebhook("https://example.workers.dev/webhook", "s3cret");
    const body = JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.allowed_updates).toEqual(["message", "callback_query"]);
  });

  it("redacts the bot token from network failures", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(async () => {
        throw new Error("connect ECONNREFUSED https://api.telegram.org/bot42:SECRET_TOKEN/getMe");
      });
    const tg = new Telegram("42:SECRET_TOKEN", fetchFn as unknown as typeof fetch);
    await expect(tg.getMe()).rejects.toThrow(/bot<redacted>/);
    await expect(tg.getMe()).rejects.not.toThrow(/SECRET_TOKEN/);
  });

  it("surfaces API errors as TelegramError with the code", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fail(403, "bot was blocked by the user"));
    const tg = new Telegram("t", fetchFn as unknown as typeof fetch);
    await expect(tg.sendMessage(1, "hi")).rejects.toBeInstanceOf(TelegramError);
  });
});
