import { describe, expect, it } from "vitest";
import { extractReply } from "../src/generic";

describe("extractReply", () => {
  it("passes plain text through", () => {
    expect(extractReply("just text")).toBe("just text");
  });

  it("reads the common reply keys", () => {
    expect(extractReply('{"reply":"hi"}')).toBe("hi");
    expect(extractReply('{"answer":"yes"}')).toBe("yes");
    expect(extractReply('{"output":"done"}')).toBe("done");
  });

  it("handles the n8n respond-to-webhook array shape", () => {
    expect(extractReply('[{"output":"from n8n"}]')).toBe("from n8n");
  });

  it("digs into nested objects", () => {
    expect(extractReply('{"result":{"text":"deep"}}')).toBe("deep");
  });

  it("joins arrays of strings", () => {
    expect(extractReply('["a","b"]')).toBe("a\nb");
  });

  it("returns raw body when JSON has no known keys", () => {
    expect(extractReply('{"weird":"shape"}')).toBe('{"weird":"shape"}');
  });

  it("returns raw body for invalid JSON", () => {
    expect(extractReply("{broken")).toBe("{broken");
  });

  it("returns empty string for empty body", () => {
    expect(extractReply("   ")).toBe("");
  });
});
