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
  /** Message id — needed for feedback and follow-up suggestions. */
  messageId?: string;
  /** Task id — the handle the Stop button cancels. */
  taskId?: string;
  /** Ready-to-show progress line while an agent or chatflow works. */
  status?: string;
  /** Image produced by the app, to be forwarded as a Telegram photo. */
  fileUrl?: string;
  /** Moderation replaced the whole answer. */
  replaceText?: string;
  /** Retrieved document names, appended as citations. */
  sources?: string[];
}

interface DifyRetrieverResource {
  document_name?: string;
}

interface DifyStreamEvent {
  event?: string;
  answer?: string;
  conversation_id?: string;
  message_id?: string;
  task_id?: string;
  message?: string;
  status?: number;
  /** agent_thought */
  tool?: string;
  /** message_file */
  type?: string;
  url?: string;
  /** message_end */
  metadata?: { retriever_resources?: DifyRetrieverResource[] };
  /** node_started (chatflow) */
  data?: { node_type?: string; title?: string };
}

export interface DifyOptions {
  apiUrl: string;
  apiKey: string;
  query: string;
  user: string;
  conversationId?: string | null;
  /** Uploaded image ids to attach to this message. */
  fileIds?: string[];
  fetchFn?: typeof fetch;
}

const defaultFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);

/** Stream a Dify chat-messages response as parsed chunks. */
export async function* streamDifyChat(opts: DifyOptions): AsyncGenerator<DifyChunk> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const files = (opts.fileIds ?? []).map((id) => ({
    type: "image",
    transfer_method: "local_file",
    upload_file_id: id,
  }));
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
      ...(files.length ? { files } : {}),
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
        const ids = {
          ...(ev.conversation_id ? { conversationId: ev.conversation_id } : {}),
          ...(ev.message_id ? { messageId: ev.message_id } : {}),
          ...(ev.task_id ? { taskId: ev.task_id } : {}),
        };
        switch (ev.event) {
          case "message":
          case "agent_message":
            yield { text: ev.answer ?? "", ...ids };
            break;
          case "agent_thought": {
            // `tool` can list several tools separated by ";" — the first is enough.
            const tool = (ev.tool ?? "").split(";")[0]?.trim();
            if (tool) yield { status: `🔧 ${tool}…`, ...ids };
            break;
          }
          case "node_started":
            if (ev.data?.node_type === "tool" && ev.data.title) {
              yield { status: `⚙️ ${ev.data.title}…`, ...ids };
            }
            break;
          case "message_file":
            if (ev.type === "image" && ev.url) yield { fileUrl: ev.url, ...ids };
            break;
          case "message_replace":
            yield { replaceText: ev.answer ?? "", ...ids };
            break;
          case "message_end": {
            const sources = (ev.metadata?.retriever_resources ?? [])
              .map((r) => r.document_name)
              .filter((n): n is string => Boolean(n));
            yield { ...ids, ...(sources.length ? { sources: [...new Set(sources)] } : {}) };
            break;
          }
          case "error":
            throw new DifyError(ev.message ?? "Dify stream error", ev.status ?? 500);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface DifyAppParameters {
  opening_statement?: string;
  suggested_questions?: string[];
  suggested_questions_after_answer?: { enabled?: boolean };
  file_upload?: { image?: { enabled?: boolean } };
  retriever_resource?: { enabled?: boolean };
}

interface DifyClientOptions {
  apiUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

/** Small REST surface next to the stream: parameters, feedback, suggestions, stop. */
export class DifyClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: DifyClientOptions) {
    this.base = opts.apiUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? defaultFetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // FormData must set its own content-type: the boundary is generated by the runtime.
    const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
    const res = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        ...(init.body && !isForm ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DifyError(body.slice(0, 300) || res.statusText, res.status);
    }
    return (await res.json()) as T;
  }

  /** App metadata: name, mode — used to validate the key during /setup. */
  info(): Promise<{ name?: string; mode?: string }> {
    return this.request("/info");
  }

  /** Which features the app has enabled, so the bot adapts without extra config. */
  parameters(): Promise<DifyAppParameters> {
    return this.request("/parameters");
  }

  async suggested(messageId: string, user: string): Promise<string[]> {
    const res = await this.request<{ data?: string[] }>(
      `/messages/${encodeURIComponent(messageId)}/suggested?user=${encodeURIComponent(user)}`,
    );
    return res.data ?? [];
  }

  feedback(messageId: string, rating: "like" | "dislike" | null, user: string): Promise<unknown> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/feedbacks`, {
      method: "POST",
      body: JSON.stringify({ rating, user }),
    });
  }

  stop(taskId: string, user: string): Promise<unknown> {
    return this.request(`/chat-messages/${encodeURIComponent(taskId)}/stop`, {
      method: "POST",
      body: JSON.stringify({ user }),
    });
  }

  /** Upload an image so it can be attached to a chat message. */
  async uploadImage(bytes: ArrayBuffer, user: string, mime = "image/jpeg"): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), "photo.jpg");
    form.append("user", user);
    const res = await this.request<{ id: string }>("/files/upload", { method: "POST", body: form });
    return res.id;
  }
}
