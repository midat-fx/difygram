import { DifyError, streamDifyChat } from "./dify";
import { callGeneric } from "./generic";
import { clearConversation, getConversation, saveConversation } from "./session";
import { StreamingReply } from "./stream";
import { Telegram } from "./telegram";
import type { Env, TgMessage, TgUpdate } from "./types";

const START_TEXT = [
  "Hi! I relay your messages to an AI agent and stream its answer back in real time.",
  "",
  "Just type a question.",
  "/reset — start a fresh conversation",
].join("\n");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/setup") {
      return handleSetup(request, env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("DifyGram is running. See https://github.com/midat-fx/difygram", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const message = update.message;
  if (message?.chat && typeof update.update_id === "number") {
    // Answer Telegram immediately and do the slow work async — otherwise
    // Telegram times out and re-delivers the update. Dedup catches the
    // retries that still slip through (best effort, per-colo cache).
    if (!(await seenBefore(update.update_id))) {
      ctx.waitUntil(
        handleMessage(env, message).catch((e: unknown) =>
          console.error("handleMessage crashed:", (e as Error).stack ?? e),
        ),
      );
    }
  }
  return new Response("ok");
}

async function seenBefore(updateId: number): Promise<boolean> {
  try {
    const cache = caches.default;
    const key = new Request(`https://dedup.difygram.internal/${updateId}`);
    if (await cache.match(key)) return true;
    await cache.put(key, new Response("1", { headers: { "cache-control": "max-age=600" } }));
  } catch {
    // Cache API unavailable (e.g. local dev) — process anyway.
  }
  return false;
}

async function handleMessage(env: Env, message: TgMessage): Promise<void> {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (!text) {
    await tg.sendMessage(chatId, "I can only read text messages for now.");
    return;
  }
  if (text === "/start" || text === "/help") {
    await tg.sendMessage(chatId, START_TEXT);
    return;
  }
  if (text === "/reset") {
    await clearConversation(env.SESSIONS, chatId);
    await tg.sendMessage(chatId, "🔄 Conversation reset — the next message starts from scratch.");
    return;
  }

  await tg.sendChatAction(chatId).catch(() => {});
  const placeholder = await tg.sendMessage(chatId, "💭 …");
  const reply = new StreamingReply(tg, chatId, placeholder.message_id);

  try {
    if ((env.BACKEND_MODE ?? "dify") === "generic") {
      if (!env.GENERIC_WEBHOOK_URL) throw new Error("GENERIC_WEBHOOK_URL is not configured");
      const answer = await callGeneric(
        env.GENERIC_WEBHOOK_URL,
        { chat_id: chatId, user: `tg-${chatId}`, text, source: "telegram" },
        env.GENERIC_AUTH_HEADER,
      );
      await reply.finalize(answer);
      return;
    }

    if (!env.DIFY_API_KEY) throw new Error("DIFY_API_KEY is not configured");
    const previous = await getConversation(env.SESSIONS, chatId);
    let conversationId: string | undefined;

    const run = async (cid: string | null) => {
      for await (const chunk of streamDifyChat({
        apiUrl: env.DIFY_API_URL ?? "https://api.dify.ai/v1",
        apiKey: env.DIFY_API_KEY as string,
        query: text,
        user: `tg-${chatId}`,
        conversationId: cid,
      })) {
        if (chunk.conversationId) conversationId = chunk.conversationId;
        if (chunk.text) await reply.append(chunk.text);
      }
    };

    try {
      await run(previous);
    } catch (e) {
      // Stale conversation id (deleted on the Dify side) — retry fresh once.
      if (e instanceof DifyError && e.status === 404 && previous) {
        await clearConversation(env.SESSIONS, chatId);
        await run(null);
      } else {
        throw e;
      }
    }

    await reply.finalize();
    await saveConversation(env.SESSIONS, chatId, conversationId, previous);
  } catch (e) {
    const detail =
      e instanceof DifyError ? `backend error ${e.status}: ${e.message}` : ((e as Error).message ?? "unexpected error");
    console.error("reply failed:", detail);
    await reply.fail(`⚠️ Sorry, something broke on my side (${detail}). Try again or /reset.`);
  }
}

/** One-visit setup: GET /setup?secret=<WEBHOOK_SECRET> registers the webhook for this deployment. */
async function handleSetup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.WEBHOOK_SECRET || url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return Response.json({ ok: false, error: "Pass ?secret=<WEBHOOK_SECRET>" }, { status: 403 });
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN secret is not set" }, { status: 500 });
  }
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  try {
    await tg.setWebhook(`${url.origin}/webhook`, env.WEBHOOK_SECRET);
    return Response.json({ ok: true, webhook: `${url.origin}/webhook`, next: "Message your bot on Telegram" });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
