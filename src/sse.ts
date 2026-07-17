/**
 * Incremental Server-Sent Events parser.
 * Feed it raw text chunks as they arrive; it returns the `data:` payloads of
 * every complete event, buffering partial events across chunk boundaries.
 */
export class SseParser {
  private buf = "";

  feed(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n/g, "\n");
    const payloads: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const rawEvent = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
    }
    return payloads;
  }
}
