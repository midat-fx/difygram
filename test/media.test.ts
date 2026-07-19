import { describe, expect, it, vi } from "vitest";
import { checkPhoto, checkVoice, largestPhoto, toBase64, transcribe, type AiBinding } from "../src/media";
import type { TgMessage } from "../src/types";

const voiceMessage = (duration: number, fileSize?: number): TgMessage => ({
  message_id: 1,
  chat: { id: 1, type: "private" },
  voice: { file_id: "f1", duration, ...(fileSize ? { file_size: fileSize } : {}) },
});

describe("photo guards", () => {
  it("picks the largest size Telegram offers", () => {
    const photo = largestPhoto([
      { file_id: "small", file_size: 1000 },
      { file_id: "large", file_size: 90_000 },
    ]);
    expect(photo?.file_id).toBe("large");
  });

  it("returns null when there is no photo", () => {
    expect(largestPhoto(undefined)).toBeNull();
    expect(largestPhoto([])).toBeNull();
  });

  it("accepts an ordinary photo", () => {
    expect(checkPhoto({ file_id: "f", file_size: 900_000 })).toEqual({ ok: true });
  });

  it("rejects an oversized photo before any download happens", () => {
    expect(checkPhoto({ file_id: "f", file_size: 11 * 1024 * 1024 })).toEqual({
      ok: false,
      reason: "photoTooLarge",
    });
  });
});

describe("voice guards", () => {
  it("accepts a short voice note", () => {
    expect(checkVoice(voiceMessage(12, 50_000), true)).toEqual({ ok: true });
  });

  it("rejects a long one using the duration already in the update", () => {
    expect(checkVoice(voiceMessage(75), true)).toEqual({ ok: false, reason: "voiceTooLong" });
  });

  it("rejects an oversized one", () => {
    expect(checkVoice(voiceMessage(30, 5 * 1024 * 1024), true)).toEqual({
      ok: false,
      reason: "voiceTooLong",
    });
  });

  it("explains politely when voice is disabled in this deployment", () => {
    expect(checkVoice(voiceMessage(10), false)).toEqual({ ok: false, reason: "voiceOff" });
  });
});

describe("transcription", () => {
  it("sends base64 audio to Whisper with the silence filter on", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ text: "  hello there  " }) } as unknown as AiBinding & {
      run: ReturnType<typeof vi.fn>;
    };
    const text = await transcribe(ai, new Uint8Array([1, 2, 3]).buffer);
    expect(text).toBe("hello there");
    const [model, input] = ai.run.mock.calls[0] ?? [];
    expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(input).toMatchObject({ vad_filter: true });
    expect(typeof (input as { audio: string }).audio).toBe("string");
  });

  it("returns an empty string when Whisper heard nothing", async () => {
    const ai = { run: vi.fn().mockResolvedValue({}) } as unknown as AiBinding;
    expect(await transcribe(ai, new ArrayBuffer(0))).toBe("");
  });

  it("encodes large buffers without blowing the argument list", () => {
    const big = new Uint8Array(200_000).fill(65);
    const encoded = toBase64(big.buffer);
    expect(encoded.startsWith("QUFB")).toBe(true);
    expect(encoded.length).toBeGreaterThan(200_000);
  });
});
