import { describe, expect, it } from "vitest";
import { DifyError } from "../src/dify";
import { errorToUserText, OpenAiAuthError } from "../src/errors";
import { redactSecrets } from "../src/redact";

describe("errorToUserText", () => {
  it("explains exhausted model credits and how the owner fixes it", () => {
    const text = errorToUserText(new DifyError('{"code":"provider_quota_exceeded"}', 400));
    expect(text).toContain("out of free credits");
    expect(text).toContain("Model Provider");
  });

  it("treats exhausted sandbox credits (Model is not configured) as a credits problem", () => {
    const text = errorToUserText(new DifyError("Model is not configured", 400));
    expect(text).toContain("out of free credits");
  });

  it("reports a rejected Dify key", () => {
    expect(errorToUserText(new DifyError("unauthorized", 401))).toContain("DIFY_API_KEY");
  });

  it("reports a rejected OpenAI-compatible key", () => {
    expect(errorToUserText(new OpenAiAuthError("401"))).toContain("OPENAI_API_KEY");
  });

  it("explains a timeout", () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    expect(errorToUserText(e)).toContain("longer than 2 minutes");
  });

  it("never leaks the raw backend payload", () => {
    const raw = '{"message":"internal db error at 10.0.0.4","trace":"secret-trace"}';
    const text = errorToUserText(new DifyError(raw, 500));
    expect(text).toBe("⚠️ Something broke on my side. Try again in a minute, or /reset.");
    expect(text).not.toContain("secret-trace");
  });
});

describe("redactSecrets", () => {
  it("strips the bot token out of an API URL", () => {
    const msg = "fetch failed: https://api.telegram.org/bot8844983352:AAGQtl381xUQQ8Qg/getFile";
    expect(redactSecrets(msg)).toBe("fetch failed: https://api.telegram.org/bot<redacted>/getFile");
  });

  it("handles Error objects and keeps the rest of the stack", () => {
    const e = new Error("https://api.telegram.org/bot123:ABC-def_456/sendMessage exploded");
    const out = redactSecrets(e);
    expect(out).toContain("bot<redacted>");
    expect(out).not.toContain("ABC-def_456");
    expect(out).toContain("exploded");
  });

  it("leaves clean text alone", () => {
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide");
  });
});
