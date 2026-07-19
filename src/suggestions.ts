/**
 * Follow-up questions, remembered between showing the buttons and tapping one.
 *
 * Dify regenerates its suggestions on every call, so the list is not stable:
 * re-fetching on tap and picking index N can hand back a different question
 * than the label the user actually pressed. The list is therefore cached
 * against the message id.
 *
 * Cache API, not KV: this is high-churn, per-message data, and KV's free tier
 * (1000 writes/day) is reserved for conversation ids.
 */
export interface SuggestionStore {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

const TTL_SECONDS = 60 * 60 * 24;

const key = (messageId: string): Request =>
  new Request(`https://suggestions.difygram.internal/${encodeURIComponent(messageId)}`);

function store(): SuggestionStore | null {
  try {
    return caches.default as unknown as SuggestionStore;
  } catch {
    return null; // Cache API unavailable (local dev).
  }
}

export async function rememberSuggestions(
  messageId: string,
  questions: string[],
  cache = store(),
): Promise<void> {
  if (!cache || !questions.length) return;
  try {
    await cache.put(
      key(messageId),
      new Response(JSON.stringify(questions), {
        headers: { "cache-control": `max-age=${TTL_SECONDS}`, "content-type": "application/json" },
      }),
    );
  } catch {
    // Losing the cache only means falling back to a re-fetch.
  }
}

export async function recallSuggestions(messageId: string, cache = store()): Promise<string[] | null> {
  if (!cache) return null;
  try {
    const hit = await cache.match(key(messageId));
    if (!hit) return null;
    const parsed = (await hit.json()) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}
