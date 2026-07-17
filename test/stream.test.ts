import { describe, expect, it, vi } from "vitest";
import { StreamingReply } from "../src/stream";
import type { Telegram } from "../src/telegram";

function fakeTg() {
  return {
    editPreview: vi.fn().mockResolvedValue(undefined),
    editFinal: vi.fn().mockResolvedValue(undefined),
    sendFinal: vi.fn().mockResolvedValue(undefined),
  } as unknown as Telegram & {
    editPreview: ReturnType<typeof vi.fn>;
    editFinal: ReturnType<typeof vi.fn>;
    sendFinal: ReturnType<typeof vi.fn>;
  };
}

describe("StreamingReply", () => {
  it("throttles preview edits to the configured interval", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 1000);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      await reply.append("Hello");
      vi.setSystemTime(1_000_200); // +200ms — inside the throttle window
      await reply.append(" world");
      expect(tg.editPreview).toHaveBeenCalledTimes(1);
      vi.setSystemTime(1_001_300); // +1.3s — window reopened
      await reply.append("!");
      expect(tg.editPreview).toHaveBeenCalledTimes(2);
      expect(tg.editPreview).toHaveBeenLastCalledWith(1, 10, "Hello world! ▍");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes a short answer into a single formatted edit", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    await reply.append("**done**");
    await reply.finalize();
    expect(tg.editFinal).toHaveBeenCalledWith(1, 10, "<b>done</b>", "**done**");
    expect(tg.sendFinal).not.toHaveBeenCalled();
  });

  it("sends overflow segments as follow-up messages", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    const long = ("paragraph ".repeat(80) + "\n\n").repeat(8); // ~6.5k chars
    await reply.finalize(long);
    expect(tg.editFinal).toHaveBeenCalledTimes(1);
    expect(tg.sendFinal.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("replaces an empty answer with a friendly notice", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    await reply.finalize();
    expect(tg.editFinal).toHaveBeenCalledWith(
      1,
      10,
      "The backend returned an empty response.",
      "The backend returned an empty response.",
    );
  });
});
