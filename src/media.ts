import type { TgMessage, TgPhotoSize } from "./types";

/** Telegram compresses photos, but a caller can still push a large one. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Voice notes: long ones are slow to transcribe and rarely intentional. */
export const MAX_VOICE_SECONDS = 60;
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;

export const TEXTS = {
  photoTooLarge: "📎 That image is too large — 10 MB max, please.",
  photoNotEnabled:
    "📎 Image input isn't enabled in this Dify app. Enable it: app → Features → Image Upload (and use a vision-capable model).",
  voiceTooLong: "🎙️ Voice notes up to 60 seconds, please.",
  voiceOff: "🎙️ Voice input is off in this deployment. See README → Configuration.",
  voiceUnavailable: "🎙️ I couldn't transcribe that one — please type your question.",
  voiceEmpty: "🎙️ I couldn't hear anything in that voice note.",
} as const;

/** Telegram sends several sizes; the last one is the largest. */
export function largestPhoto(photos: TgPhotoSize[] | undefined): TgPhotoSize | null {
  if (!photos?.length) return null;
  return photos[photos.length - 1] ?? null;
}

export type MediaCheck = { ok: true } | { ok: false; reason: keyof typeof TEXTS };

export function checkPhoto(photo: TgPhotoSize): MediaCheck {
  if ((photo.file_size ?? 0) > MAX_PHOTO_BYTES) return { ok: false, reason: "photoTooLarge" };
  return { ok: true };
}

export function checkVoice(message: TgMessage, voiceEnabled: boolean): MediaCheck {
  if (!voiceEnabled) return { ok: false, reason: "voiceOff" };
  const voice = message.voice;
  if (!voice) return { ok: false, reason: "voiceUnavailable" };
  // Both checks run before the download: the update already carries the numbers.
  if (voice.duration > MAX_VOICE_SECONDS) return { ok: false, reason: "voiceTooLong" };
  if ((voice.file_size ?? 0) > MAX_VOICE_BYTES) return { ok: false, reason: "voiceTooLong" };
  return { ok: true };
}

/** btoa() needs a binary string, and a 200 KB argument list would overflow. */
export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface WhisperResult {
  text?: string;
}

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<WhisperResult>;
}

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * Transcribe at the edge. Language is left to auto-detect (Russian and Kazakh
 * both work); vad_filter keeps Whisper from hallucinating over silence.
 */
export async function transcribe(ai: AiBinding, bytes: ArrayBuffer): Promise<string> {
  const res = await ai.run(WHISPER_MODEL, { audio: toBase64(bytes), vad_filter: true });
  return (res.text ?? "").trim();
}
