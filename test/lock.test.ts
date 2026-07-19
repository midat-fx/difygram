import { beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock, type LockStore } from "../src/lock";

function memoryStore(): LockStore & { size(): number } {
  const map = new Map<string, Response>();
  return {
    async match(key) {
      return map.get(key.url);
    },
    async put(key, response) {
      map.set(key.url, response);
    },
    async delete(key) {
      return map.delete(key.url);
    },
    size: () => map.size,
  };
}

describe("per-chat lock", () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
  });

  it("grants the lock when the chat is idle", async () => {
    expect(await acquireLock(1, store)).toBe(true);
  });

  it("refuses a second holder while the first is working", async () => {
    await acquireLock(1, store);
    expect(await acquireLock(1, store)).toBe(false);
  });

  it("lets a different chat through", async () => {
    await acquireLock(1, store);
    expect(await acquireLock(2, store)).toBe(true);
  });

  it("grants the lock again after release", async () => {
    await acquireLock(1, store);
    await releaseLock(1, store);
    expect(await acquireLock(1, store)).toBe(true);
  });

  it("runs unlocked when the Cache API is unavailable", async () => {
    expect(await acquireLock(1, null)).toBe(true);
    await releaseLock(1, null); // must not throw
  });
});
