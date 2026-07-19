/**
 * Telegram API URLs embed the bot token, and network errors happily carry the
 * URL into `message`/`stack`. Everything that reaches console.* or a thrown
 * message goes through here first.
 */
export function redactSecrets(input: unknown): string {
  const text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? (input.stack ?? input.message)
        : String(input);
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}
