import { describe, expect, it } from "vitest";
import { recallSuggestions, rememberSuggestions, type SuggestionStore } from "../src/suggestions";

function memoryStore(): SuggestionStore {
  const map = new Map<string, Response>();
  return {
    async match(key) {
      const hit = map.get(key.url);
      return hit ? hit.clone() : undefined;
    },
    async put(key, response) {
      map.set(key.url, response);
    },
  };
}

describe("suggestion cache", () => {
  it("returns exactly the list the buttons were built from", async () => {
    const store = memoryStore();
    const questions = ["What flag is this?", "What hex codes?", "Why these colors?"];
    await rememberSuggestions("msg-1", questions, store);
    // Dify would answer a fresh call with a different set — the cache is what
    // keeps button label and sent question in sync.
    expect(await recallSuggestions("msg-1", store)).toEqual(questions);
  });

  it("keeps lists of different messages apart", async () => {
    const store = memoryStore();
    await rememberSuggestions("msg-1", ["a"], store);
    await rememberSuggestions("msg-2", ["b"], store);
    expect(await recallSuggestions("msg-2", store)).toEqual(["b"]);
  });

  it("misses for an unknown message so the caller can re-fetch", async () => {
    expect(await recallSuggestions("never-seen", memoryStore())).toBeNull();
  });

  it("stores nothing when there are no suggestions", async () => {
    const store = memoryStore();
    await rememberSuggestions("msg-1", [], store);
    expect(await recallSuggestions("msg-1", store)).toBeNull();
  });

  it("degrades quietly when the Cache API is unavailable", async () => {
    await rememberSuggestions("msg-1", ["a"], null);
    expect(await recallSuggestions("msg-1", null)).toBeNull();
  });
});
