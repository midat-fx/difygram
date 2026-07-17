import { describe, expect, it } from "vitest";
import { SseParser } from "../src/sse";

describe("SseParser", () => {
  it("parses a complete event", () => {
    const p = new SseParser();
    expect(p.feed('data: {"event":"message"}\n\n')).toEqual(['{"event":"message"}']);
  });

  it("buffers events split across chunk boundaries", () => {
    const p = new SseParser();
    expect(p.feed('data: {"answer":"Hel')).toEqual([]);
    expect(p.feed('lo"}\n\ndata: {"a":1}\n\n')).toEqual(['{"answer":"Hello"}', '{"a":1}']);
  });

  it("returns multiple events from one chunk", () => {
    const p = new SseParser();
    expect(p.feed("data: one\n\ndata: two\n\n")).toEqual(["one", "two"]);
  });

  it("normalizes CRLF delimiters", () => {
    const p = new SseParser();
    expect(p.feed("data: x\r\n\r\n")).toEqual(["x"]);
  });

  it("ignores comment and event-name lines", () => {
    const p = new SseParser();
    expect(p.feed(": keep-alive\n\nevent: ping\ndata: pong\n\n")).toEqual(["pong"]);
  });

  it("joins multi-line data fields", () => {
    const p = new SseParser();
    expect(p.feed("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });

  it("handles data without the optional space", () => {
    const p = new SseParser();
    expect(p.feed("data:tight\n\n")).toEqual(["tight"]);
  });
});
