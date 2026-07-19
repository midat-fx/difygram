import { DifyError } from "./dify";

/**
 * Backend errors are for logs, not for chat. Every failure the user can see is
 * mapped to a sentence that tells them (or the bot owner) what to do next.
 */
export function errorToUserText(e: unknown): string {
  if (e instanceof DifyError) {
    if (/provider_quota_exceeded|quota/i.test(e.message)) {
      return (
        "🪫 The AI model behind this bot is out of free credits. " +
        "Bot owner: open Dify → Settings → Model Provider and add your own free Gemini API key — " +
        "the bot comes back instantly and stays free."
      );
    }
    if (e.status === 401 || e.status === 403) {
      return "🔑 The AI backend rejected its API key. Bot owner: check the DIFY_API_KEY secret.";
    }
  }
  if (e instanceof OpenAiAuthError) {
    return "🔑 The AI backend rejected its API key. Bot owner: check the OPENAI_API_KEY secret.";
  }
  if ((e as Error)?.name === "TimeoutError") {
    return "⏱️ The answer took longer than 2 minutes and was cut off. Try a shorter question, or /reset.";
  }
  return "⚠️ Something broke on my side. Try again in a minute, or /reset.";
}

/** Raised by the OpenAI-compatible backend on 401/403 so the mapping above can see it. */
export class OpenAiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiAuthError";
  }
}
