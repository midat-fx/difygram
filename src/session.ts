const KEY_PREFIX = "conv:";
const TTL_SECONDS = 60 * 60 * 24 * 30;

export function getConversation(kv: KVNamespace, chatId: number): Promise<string | null> {
  return kv.get(KEY_PREFIX + chatId);
}

/** Write only when the id actually changed — KV free tier allows 1k writes/day. */
export async function saveConversation(
  kv: KVNamespace,
  chatId: number,
  id: string | undefined,
  previous: string | null,
): Promise<void> {
  if (id && id !== previous) await kv.put(KEY_PREFIX + chatId, id, { expirationTtl: TTL_SECONDS });
}

export function clearConversation(kv: KVNamespace, chatId: number): Promise<void> {
  return kv.delete(KEY_PREFIX + chatId);
}
