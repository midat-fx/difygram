import { describe, expect, it } from "vitest";
import { escapeHtml, markdownToTelegramHtml, splitMessage } from "../src/format";

describe("escapeHtml", () => {
  it("escapes the three HTML-significant characters", () => {
    expect(escapeHtml('a < b & c > "d"')).toBe('a &lt; b &amp; c &gt; "d"');
  });
});

describe("markdownToTelegramHtml", () => {
  it("converts bold, italic and strikethrough", () => {
    expect(markdownToTelegramHtml("**bold** and *ital* and ~~gone~~")).toBe(
      "<b>bold</b> and <i>ital</i> and <s>gone</s>",
    );
  });

  it("keeps snake_case untouched while converting _italic_", () => {
    expect(markdownToTelegramHtml("use user_id here _really_")).toBe("use user_id here <i>really</i>");
  });

  it("converts inline code and escapes HTML inside it", () => {
    expect(markdownToTelegramHtml("run `a < b` now")).toBe("run <code>a &lt; b</code> now");
  });

  it("converts fenced code blocks with language", () => {
    expect(markdownToTelegramHtml('```ts\nconst x = "<y>";\n```')).toBe(
      '<pre><code class="language-ts">const x = "&lt;y&gt;";</code></pre>',
    );
  });

  it("does not format markdown inside code blocks", () => {
    expect(markdownToTelegramHtml("```\n**not bold**\n```")).toBe("<pre><code>**not bold**</code></pre>");
  });

  it("escapes quotes inside a link URL so href never closes early", () => {
    const out = markdownToTelegramHtml('[click](https://x.dev/a"onmouseover="x)');
    expect(out).toBe('<a href="https://x.dev/a&quot;onmouseover=&quot;x">click</a>');
  });

  it("converts links and headings", () => {
    expect(markdownToTelegramHtml("## Title\n[site](https://x.dev)")).toBe(
      '<b>Title</b>\n<a href="https://x.dev">site</a>',
    );
  });

  it("turns list markers into bullets", () => {
    expect(markdownToTelegramHtml("- one\n- two")).toBe("• one\n• two");
  });

  it("escapes raw HTML in plain text", () => {
    expect(markdownToTelegramHtml("a <script> & b")).toBe("a &lt;script&gt; &amp; b");
  });
});

describe("splitMessage", () => {
  it("returns short text as a single part", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits on paragraph boundaries first", () => {
    const text = "a".repeat(60) + "\n\n" + "b".repeat(60);
    const parts = splitMessage(text, 100);
    expect(parts).toEqual(["a".repeat(60), "b".repeat(60)]);
  });

  it("falls back to a hard cut when there is no whitespace", () => {
    const text = "x".repeat(250);
    const parts = splitMessage(text, 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(parts.join("")).toBe(text);
  });

  it("never returns a part above the limit", () => {
    const text = ("word ".repeat(50) + "\n\n").repeat(20);
    for (const part of splitMessage(text, 200)) {
      expect(part.length).toBeLessThanOrEqual(200);
    }
  });
});
