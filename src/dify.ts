import { SseParser } from "./sse";

export class DifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DifyError";
  }
}

export interface DifyChunk {
  /** Incremental answer text (may be empty for meta events). */
  text?: string;
  /** Conversation id once Dify assigns one — persist it to keep dialog memory. */
  conversationId?: string;
}

interface DifyStreamEvent {
  event?: string;
  answer?: string;
  conversation_id?: string;
  message?: string;
  status?: number;
}

export interface DifyOptions {
  apiUrl: string;
  apiKey: string;
  query: string;
  user: string;
  conversationId?: string | null;
  fetchFn?: typeof fetch;
}

/** Stream a Dify chat-messages response as parsed chunks. */
export async function* streamDifyChat(opts: DifyOptions): AsyncGenerator<DifyChunk> {
  const fetchFn = opts.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const res = await fetchFn(`${opts.apiUrl.replace(/\/+$/, "")}/chat-messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      inputs: {},
      query: opts.query,
      response_mode: "streaming",
      user: opts.user,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new DifyError(body.slice(0, 300) || res.statusText, res.status);
  }

  const parser = new SseParser();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of parser.feed(value)) {
        let ev: DifyStreamEvent;
        try {
          ev = JSON.parse(payload) as DifyStreamEvent;
        } catch {
          continue; // keep-alive or malformed frame
        }
        switch (ev.event) {
          case "message":
          case "agent_message":
            yield { text: ev.answer ?? "", conversationId: ev.conversation_id };
            break;
          case "message_end":
            yield { conversationId: ev.conversation_id };
            break;
          case "error":
            throw new DifyError(ev.message ?? "Dify stream error", ev.status ?? 500);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
