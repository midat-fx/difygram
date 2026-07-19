/** Telegram hard limit is 4096 chars; we cut earlier to leave room for formatting. */
export const TG_SAFE_LIMIT = 3900;

/** Placeholder delimiter for extracted code spans; NUL never occurs in chat text. */
const HOLE = "\u0000";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert common markdown (what LLMs actually emit) to Telegram-flavored HTML.
 * Telegram's HTML parse mode is far more forgiving than MarkdownV2, where a
 * single unescaped `.` makes the whole edit fail with a 400.
 */
export function markdownToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const html = `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
    return `${HOLE}B${blocks.push(html) - 1}${HOLE}`;
  });

  const inline: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    return `${HOLE}I${inline.push(`<code>${escapeHtml(code)}</code>`) - 1}${HOLE}`;
  });

  text = escapeHtml(text);

  // A quote inside the URL would close href="" early and break the whole message.
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, href: string) => `<a href="${href.replace(/"/g, "&quot;")}">${label}</a>`,
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/(?<=^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, "<i>$1</i>");
  text = text.replace(/(?<=^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "<i>$1</i>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  text = text.replace(/\u0000I(\d+)\u0000/g, (_m, i: string) => inline[Number(i)] ?? "");
  text = text.replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? "");
  return text.trim();
}

/**
 * Split long text into Telegram-sized parts, preferring paragraph, then line,
 * then word boundaries. Split the raw markdown BEFORE converting to HTML so
 * tags are never cut in half.
 */
export function splitMessage(text: string, limit = TG_SAFE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
