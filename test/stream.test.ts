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
      expect(tg.editPreview).toHaveBeenLastCalledWith(1, 10, "Hello world! ▍", undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a Stop button on previews once the task id is known", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    reply.setTaskId("task-42");
    await reply.append("Hello");
    expect(tg.editPreview).toHaveBeenLastCalledWith(1, 10, "Hello ▍", {
      inline_keyboard: [[{ text: "⏹ Stop", callback_data: "st:task-42" }]],
    });
  });

  it("shows a status line only while the answer is still empty", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    await reply.setStatus("🔧 web_search…");
    expect(tg.editPreview).toHaveBeenCalledTimes(1);
    await reply.append("answer");
    await reply.setStatus("🔧 another_tool…");
    // Status edits stop once real text has arrived.
    expect(tg.editPreview).toHaveBeenCalledTimes(2);
    expect(tg.editPreview).toHaveBeenLastCalledWith(1, 10, "answer ▍", undefined);
  });

  it("replace() swaps the accumulated answer (Dify moderation)", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    await reply.append("original text");
    reply.replace("moderated");
    await reply.finalize();
    expect(tg.editFinal).toHaveBeenCalledWith(1, 10, "moderated", "moderated", undefined);
  });

  it("finalizes a short answer into a single formatted edit", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    await reply.append("**done**");
    await reply.finalize();
    expect(tg.editFinal).toHaveBeenCalledWith(1, 10, "<b>done</b>", "**done**", undefined);
    expect(tg.sendFinal).not.toHaveBeenCalled();
  });

  it("attaches the final markup only to the last segment", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    const markup = { inline_keyboard: [[{ text: "👍", callback_data: "fb:l:1" }]] };
    const long = ("paragraph ".repeat(80) + "\n\n").repeat(8);
    vi.useFakeTimers();
    try {
      const done = reply.finalize(long, markup);
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(tg.editFinal.mock.calls[0]?.[4]).toBeUndefined();
    const lastSend = tg.sendFinal.mock.calls.at(-1);
    expect(lastSend?.[3]).toEqual(markup);
  });

  it("sends overflow segments as follow-up messages", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    const long = ("paragraph ".repeat(80) + "\n\n").repeat(8); // ~6.5k chars
    vi.useFakeTimers();
    try {
      const done = reply.finalize(long);
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(tg.editFinal).toHaveBeenCalledTimes(1);
    expect(tg.sendFinal.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("paces overflow segments to stay under the per-chat rate limit", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    const long = ("paragraph ".repeat(80) + "\n\n").repeat(8);
    vi.useFakeTimers();
    try {
      const done = reply.finalize(long);
      await Promise.resolve();
      await Promise.resolve();
      // The first segment goes out immediately; the next one waits.
      expect(tg.sendFinal).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      await done;
      expect(tg.sendFinal.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the partial answer when the stream fails mid-way", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    await reply.append("half an answer");
    await reply.fail("⚠️ Something broke on my side.");
    const [, , html] = tg.editFinal.mock.calls[0] ?? [];
    expect(html).toContain("half an answer");
    expect(html).toContain("Something broke");
  });

  it("shows only the error when nothing was streamed yet", async () => {
    const tg = fakeTg();
    const reply = new StreamingReply(tg, 1, 10, 0);
    await reply.fail("⚠️ Something broke on my side.");
    expect(tg.editFinal).not.toHaveBeenCalled();
    expect(tg.editPreview).toHaveBeenCalledWith(1, 10, "⚠️ Something broke on my side.");
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
      undefined,
    );
  });
});
