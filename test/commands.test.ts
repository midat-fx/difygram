import { describe, expect, it } from "vitest";
import { isStrongSecret, parseCommand } from "../src/index";

describe("parseCommand", () => {
  it("recognises plain commands in private chats", () => {
    expect(parseCommand("/start", true, "difygram_demo_bot")).toBe("start");
    expect(parseCommand("/reset", true, "difygram_demo_bot")).toBe("reset");
    expect(parseCommand("/help", true, "difygram_demo_bot")).toBe("help");
  });

  it("recognises /cmd@thisbot — the form Telegram sends in groups", () => {
    expect(parseCommand("/start@difygram_demo_bot", false, "difygram_demo_bot")).toBe("start");
  });

  it("is case-insensitive about the bot username suffix", () => {
    expect(parseCommand("/reset@DifyGram_Demo_Bot", false, "difygram_demo_bot")).toBe("reset");
  });

  it("ignores commands addressed to another bot in a group", () => {
    expect(parseCommand("/reset@some_other_bot", false, "difygram_demo_bot")).toBeNull();
  });

  it("still answers a suffixed command when the username is unknown", () => {
    expect(parseCommand("/start@whoever", false, null)).toBe("start");
  });

  it("returns null for anything that is not a known command", () => {
    expect(parseCommand("/unknown", true, "difygram_demo_bot")).toBeNull();
    expect(parseCommand("start", true, "difygram_demo_bot")).toBeNull();
    expect(parseCommand("/start now", true, "difygram_demo_bot")).toBeNull();
  });
});

describe("isStrongSecret", () => {
  it("rejects short secrets", () => {
    expect(isStrongSecret("short")).toBe(false);
  });

  it("rejects the placeholder from the docs", () => {
    expect(isStrongSecret("change-me-long-random-string")).toBe(false);
  });

  it("accepts a real random secret", () => {
    expect(isStrongSecret("f3a91c0b7d24e5a86bb1c2d3e4f50617")).toBe(true);
  });
});
