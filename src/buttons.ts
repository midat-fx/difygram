/**
 * Inline-button protocol.
 *
 * Telegram caps callback_data at 64 bytes, so nothing but ids and indexes goes
 * in there: `st:<task_id>` (39B), `fb:l:<message_id>` (41B), `sq:<message_id>:<idx>` (41B),
 * `ss:<idx>` (5B). Question text is re-fetched on tap instead of being carried.
 */
export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export type Callback =
  | { kind: "stop"; taskId: string }
  | { kind: "feedback"; rating: "like" | "dislike"; messageId: string }
  | { kind: "feedback-noop" }
  | { kind: "suggestion"; messageId: string; index: number }
  | { kind: "starter"; index: number };

export function parseCallback(data: string | undefined): Callback | null {
  if (!data) return null;
  const [prefix, ...rest] = data.split(":");
  switch (prefix) {
    case "st":
      return rest[0] ? { kind: "stop", taskId: rest.join(":") } : null;
    case "fb": {
      const [flag, ...idParts] = rest;
      if (flag === "x") return { kind: "feedback-noop" };
      const messageId = idParts.join(":");
      if (!messageId || (flag !== "l" && flag !== "d")) return null;
      return { kind: "feedback", rating: flag === "l" ? "like" : "dislike", messageId };
    }
    case "sq": {
      const index = Number(rest.at(-1));
      const messageId = rest.slice(0, -1).join(":");
      if (!messageId || !Number.isInteger(index) || index < 0) return null;
      return { kind: "suggestion", messageId, index };
    }
    case "ss": {
      const index = Number(rest[0]);
      return Number.isInteger(index) && index >= 0 ? { kind: "starter", index } : null;
    }
    default:
      return null;
  }
}

const MAX_LABEL = 32;

/** Button labels have to fit on a phone screen. */
export function truncateLabel(text: string, max = MAX_LABEL): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function stopKeyboard(taskId: string): InlineKeyboard {
  return { inline_keyboard: [[{ text: "⏹ Stop", callback_data: `st:${taskId}` }]] };
}

/** Feedback row plus one row per follow-up suggestion. */
export function answerKeyboard(messageId: string, suggestions: string[] = []): InlineKeyboard | undefined {
  if (!messageId) return undefined;
  const rows: InlineButton[][] = [
    [
      { text: "👍", callback_data: `fb:l:${messageId}` },
      { text: "👎", callback_data: `fb:d:${messageId}` },
    ],
  ];
  suggestions.slice(0, 3).forEach((q, i) => {
    rows.push([{ text: truncateLabel(q), callback_data: `sq:${messageId}:${i}` }]);
  });
  return { inline_keyboard: rows };
}

/** Starter questions shown with the opening statement — no message id exists yet. */
export function starterKeyboard(questions: string[]): InlineKeyboard | undefined {
  const rows = questions
    .slice(0, 3)
    .map((q, i) => [{ text: truncateLabel(q), callback_data: `ss:${i}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** After a vote the row collapses to a single, inert confirmation. */
export function votedKeyboard(previous: InlineKeyboard | undefined, rating: "like" | "dislike"): InlineKeyboard {
  const kept = (previous?.inline_keyboard ?? []).filter((row) => !row.some((b) => b.callback_data.startsWith("fb:")));
  return {
    inline_keyboard: [[{ text: rating === "like" ? "👍 Noted" : "👎 Noted", callback_data: "fb:x" }], ...kept],
  };
}
