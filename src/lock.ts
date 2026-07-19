/**
 * Per-chat generation lock.
 *
 * Without it a second message sent while the first is still streaming reads the
 * conversation id before the first stream saved it: Dify opens a second
 * conversation, the memory forks, and two streams fight over the same chat's
 * rate limit.
 *
 * Cache API rather than KV: KV is eventually consistent (up to 60s) and its
 * free tier allows only 1000 writes/day, which we reserve for conversation ids.
 * Guarantees are best-effort per colo — acceptable, because Telegram delivers a
 * chat's updates from stable data centres and a miss only interleaves edits.
 */
export interface LockStore {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
  delete(key: Request): Promise<boolean>;
}

const LOCK_TTL_SECONDS = 180;

const lockKey = (chatId: number | string): Request =>
  new Request(`https://lock.difygram.internal/${chatId}`);

function store(): LockStore | null {
  try {
    return caches.default as unknown as LockStore;
  } catch {
    return null; // Cache API unavailable (local dev) — run without locking.
  }
}

/** Returns true when the lock was taken, false when someone else holds it. */
export async function acquireLock(chatId: number | string, cache = store()): Promise<boolean> {
  if (!cache) return true;
  const key = lockKey(chatId);
  try {
    if (await cache.match(key)) return false;
    await cache.put(key, new Response("1", { headers: { "cache-control": `max-age=${LOCK_TTL_SECONDS}` } }));
    return true;
  } catch {
    return true;
  }
}

export async function releaseLock(chatId: number | string, cache = store()): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(lockKey(chatId));
  } catch {
    // A stale lock expires on its own after LOCK_TTL_SECONDS.
  }
}
