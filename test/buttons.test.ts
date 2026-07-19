import { describe, expect, it } from "vitest";
import {
  answerKeyboard,
  parseCallback,
  starterKeyboard,
  stopKeyboard,
  truncateLabel,
  votedKeyboard,
} from "../src/buttons";

describe("callback protocol", () => {
  it("round-trips a stop button", () => {
    const data = stopKeyboard("task-abc").inline_keyboard[0]?.[0]?.callback_data ?? "";
    expect(parseCallback(data)).toEqual({ kind: "stop", taskId: "task-abc" });
  });

  it("round-trips feedback buttons", () => {
    const rows = answerKeyboard("msg-1")?.inline_keyboard ?? [];
    expect(parseCallback(rows[0]?.[0]?.callback_data)).toEqual({
      kind: "feedback",
      rating: "like",
      messageId: "msg-1",
    });
    expect(parseCallback(rows[0]?.[1]?.callback_data)).toEqual({
      kind: "feedback",
      rating: "dislike",
      messageId: "msg-1",
    });
  });

  it("round-trips a suggestion index", () => {
    const rows = answerKeyboard("msg-1", ["first?", "second?"])?.inline_keyboard ?? [];
    expect(parseCallback(rows[2]?.[0]?.callback_data)).toEqual({
      kind: "suggestion",
      messageId: "msg-1",
      index: 1,
    });
  });

  it("round-trips a starter question", () => {
    const rows = starterKeyboard(["hello?"])?.inline_keyboard ?? [];
    expect(parseCallback(rows[0]?.[0]?.callback_data)).toEqual({ kind: "starter", index: 0 });
  });

  it("recognises the inert post-vote button", () => {
    expect(parseCallback("fb:x")).toEqual({ kind: "feedback-noop" });
  });

  it("rejects malformed or unknown data", () => {
    expect(parseCallback(undefined)).toBeNull();
    expect(parseCallback("")).toBeNull();
    expect(parseCallback("zz:1")).toBeNull();
    expect(parseCallback("st:")).toBeNull();
    expect(parseCallback("fb:q:msg")).toBeNull();
    expect(parseCallback("sq:msg:notanumber")).toBeNull();
  });

  it("keeps every payload inside Telegram's 64-byte limit", () => {
    const uuid = "c9f1d8a2-4b7e-4d3a-9f10-2b6c8e5a7d41"; // real Dify id shape
    const all = [
      ...(stopKeyboard(uuid).inline_keyboard.flat() ?? []),
      ...(answerKeyboard(uuid, ["a", "b", "c"])?.inline_keyboard.flat() ?? []),
      ...(starterKeyboard(["a"])?.inline_keyboard.flat() ?? []),
    ];
    for (const button of all) {
      expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
    }
  });
});

describe("keyboard shapes", () => {
  it("caps follow-up suggestions at three rows", () => {
    const rows = answerKeyboard("m", ["a", "b", "c", "d", "e"])?.inline_keyboard ?? [];
    expect(rows).toHaveLength(4); // feedback row + 3 suggestions
  });

  it("returns no keyboard without a message id (generic backends)", () => {
    expect(answerKeyboard("")).toBeUndefined();
    expect(starterKeyboard([])).toBeUndefined();
  });

  it("truncates long question labels", () => {
    const label = truncateLabel("What are the three most important things to know about this topic?");
    expect(label.length).toBeLessThanOrEqual(32);
    expect(label.endsWith("…")).toBe(true);
  });

  it("collapses the feedback row after a vote but keeps suggestions", () => {
    const before = answerKeyboard("m", ["follow up?"]);
    const after = votedKeyboard(before, "like");
    expect(after.inline_keyboard[0]).toEqual([{ text: "👍 Noted", callback_data: "fb:x" }]);
    expect(after.inline_keyboard[1]?.[0]?.callback_data).toBe("sq:m:0");
    expect(after.inline_keyboard.flat().filter((b) => b.callback_data.startsWith("fb:l"))).toHaveLength(0);
  });
});
