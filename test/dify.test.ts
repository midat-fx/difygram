import { describe, expect, it, vi } from "vitest";
import { streamDifyChat, type DifyChunk } from "../src/dify";
import { formatSources } from "../src/index";

function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(new Blob([body]).stream(), { status: 200 });
}

async function collect(events: object[]): Promise<DifyChunk[]> {
  const fetchFn = vi.fn().mockResolvedValue(sseResponse(events));
  const out: DifyChunk[] = [];
  for await (const chunk of streamDifyChat({
    apiUrl: "https://api.dify.ai/v1",
    apiKey: "app-test",
    query: "hi",
    user: "tg-1",
    fetchFn: fetchFn as unknown as typeof fetch,
  })) {
    out.push(chunk);
  }
  return out;
}

describe("Dify stream parsing", () => {
  it("carries message_id and task_id — the handles buttons need", async () => {
    const chunks = await collect([
      { event: "message", answer: "Hel", conversation_id: "c1", message_id: "m1", task_id: "t1" },
      { event: "message", answer: "lo", conversation_id: "c1", message_id: "m1", task_id: "t1" },
    ]);
    expect(chunks[0]).toMatchObject({ text: "Hel", conversationId: "c1", messageId: "m1", taskId: "t1" });
  });

  it("turns agent_thought into a ready-to-show status line", async () => {
    const chunks = await collect([{ event: "agent_thought", tool: "web_search;calculator", task_id: "t1" }]);
    expect(chunks[0]?.status).toBe("🔧 web_search…");
  });

  it("ignores an agent_thought without a tool", async () => {
    expect(await collect([{ event: "agent_thought", tool: "" }])).toHaveLength(0);
  });

  it("reports chatflow tool nodes, but not other node types", async () => {
    const chunks = await collect([
      { event: "node_started", data: { node_type: "llm", title: "Answer" } },
      { event: "node_started", data: { node_type: "tool", title: "Search the web" } },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.status).toBe("⚙️ Search the web…");
  });

  it("passes through generated images", async () => {
    const chunks = await collect([
      { event: "message_file", type: "image", url: "/files/abc/preview.png" },
      { event: "message_file", type: "audio", url: "/files/x.mp3" },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.fileUrl).toBe("/files/abc/preview.png");
  });

  it("surfaces a moderation replacement", async () => {
    const chunks = await collect([{ event: "message_replace", answer: "[redacted by moderation]" }]);
    expect(chunks[0]?.replaceText).toBe("[redacted by moderation]");
  });

  it("collects unique retriever sources from message_end", async () => {
    const chunks = await collect([
      {
        event: "message_end",
        conversation_id: "c1",
        metadata: {
          retriever_resources: [
            { document_name: "handbook.pdf" },
            { document_name: "handbook.pdf" },
            { document_name: "policy.md" },
          ],
        },
      },
    ]);
    expect(chunks[0]?.sources).toEqual(["handbook.pdf", "policy.md"]);
  });

  it("ignores unknown events instead of breaking the stream", async () => {
    const chunks = await collect([
      { event: "workflow_started" },
      { event: "ping" },
      { event: "message", answer: "ok", message_id: "m1" },
    ]);
    expect(chunks).toHaveLength(1);
  });

  it("attaches uploaded image ids to the request body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([{ event: "message_end" }]));
    const gen = streamDifyChat({
      apiUrl: "https://api.dify.ai/v1",
      apiKey: "app-test",
      query: "what is this?",
      user: "tg-1",
      fileIds: ["file-9"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    for await (const _ of gen) void _;
    const body = JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.files).toEqual([{ type: "image", transfer_method: "local_file", upload_file_id: "file-9" }]);
  });
});

describe("formatSources", () => {
  it("appends up to three unique documents", () => {
    expect(formatSources(["a.pdf", "a.pdf", "b.md", "c.txt", "d.doc"])).toBe("\n\n📚 Sources: a.pdf, b.md, c.txt");
  });

  it("adds nothing when the app returned no sources", () => {
    expect(formatSources([])).toBe("");
  });
});
