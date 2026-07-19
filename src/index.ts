import { DifyError, streamDifyChat } from "./dify";
import { errorToUserText } from "./errors";
import { callGeneric } from "./generic";
import { acquireLock, releaseLock } from "./lock";
import { redactSecrets } from "./redact";
import { clearConversation, getConversation, saveConversation } from "./session";
import { StreamingReply } from "./stream";
import { Telegram } from "./telegram";
import type { Env, TgMessage, TgUpdate } from "./types";

const START_TEXT = [
  "Hi! I relay your messages to an AI agent and stream its answer back in real time.",
  "",
  "Just type a question.",
  "/reset — start a fresh conversation",
  "/help — what I can do",
].join("\n");

const HELP_TEXT = [
  "I connect this chat to an AI backend and stream its answers.",
  "/reset — start a fresh conversation",
  "/help — this message",
].join("\n");

const BUSY_TEXT = "⏳ Still answering your previous message — please wait.";

/** Bot username, resolved once per isolate; used to tell our /commands from other bots'. */
let botUsername: string | null = null;

async function getBotUsername(tg: Telegram): Promise<string | null> {
  if (botUsername !== null) return botUsername;
  try {
    const me = await tg.getMe();
    botUsername = me.username ?? "";
  } catch {
    botUsername = "";
  }
  return botUsername;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/setup") {
      return handleSetup(request, env);
    }
    // In production Static Assets serve the landing page before the Worker is
    // reached; this stays as the dev fallback.
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

  if ((update.message?.chat || update.callback_query) && typeof update.update_id === "number") {
    // Answer Telegram immediately and do the slow work async — otherwise
    // Telegram times out and re-delivers the update. Dedup catches the
    // retries that still slip through (best effort, per-colo cache).
    if (!(await seenBefore(update.update_id))) {
      ctx.waitUntil(
        route(env, update).catch((e: unknown) => console.error("update handling crashed:", redactSecrets(e))),
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
    // Written before handling: at-most-once. A crash mid-handling means the
    // retry is dropped — deliberate, duplicate answers are worse than a rare miss.
    await cache.put(key, new Response("1", { headers: { "cache-control": "max-age=3600" } }));
  } catch {
    // Cache API unavailable (e.g. local dev) — process anyway.
  }
  return false;
}

async function route(env: Env, update: TgUpdate): Promise<void> {
  const message = update.message;
  if (!message?.chat) return;
  await handleMessage(env, message);
}

/** Matches /cmd and /cmd@thisbot, but not /cmd@someotherbot. */
export function parseCommand(text: string, isPrivate: boolean, username: string | null): string | null {
  const m = text.match(/^\/(start|help|reset)(?:@(\w+))?$/);
  if (!m) return null;
  const suffix = m[2];
  if (suffix && !isPrivate && username && suffix.toLowerCase() !== username.toLowerCase()) return null;
  return m[1] ?? null;
}

async function handleMessage(env: Env, message: TgMessage): Promise<void> {
  // Two bots answering each other loops forever; nothing good is upstream of a bot.
  if (message.from?.is_bot) return;

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = message.chat.id;
  const isPrivate = message.chat.type === "private";
  const text = message.text?.trim();

  if (!text) {
    // In groups every join/pin/photo would otherwise get a reply — that's spam.
    if (isPrivate) await tg.sendMessage(chatId, "I can only read text messages for now.");
    return;
  }

  if (text.startsWith("/")) {
    const cmd = parseCommand(text, isPrivate, await getBotUsername(tg));
    if (cmd === "start") {
      await tg.sendMessage(chatId, START_TEXT);
      return;
    }
    if (cmd === "help") {
      await tg.sendMessage(chatId, HELP_TEXT);
      return;
    }
    if (cmd === "reset") {
      if (!(await acquireLock(chatId))) {
        await tg.sendMessage(chatId, BUSY_TEXT);
        return;
      }
      try {
        await clearConversation(env.SESSIONS, chatId);
        await tg.sendMessage(chatId, "🔄 Conversation reset — the next message starts from scratch.");
      } finally {
        await releaseLock(chatId);
      }
      return;
    }
    if (cmd === null && text.match(/^\/\w+(@\w+)?$/)) return; // command for another bot
  }

  if (!(await acquireLock(chatId))) {
    await tg.sendMessage(chatId, BUSY_TEXT);
    return;
  }
  try {
    await generate(env, tg, chatId, text);
  } finally {
    await releaseLock(chatId);
  }
}

async function generate(env: Env, tg: Telegram, chatId: number, text: string): Promise<void> {
  const mode = env.BACKEND_MODE ?? "dify";
  if (mode !== "dify" && mode !== "generic") {
    await tg.sendMessage(chatId, `⚙️ BACKEND_MODE="${mode}" is not supported. Use "dify" or "generic".`);
    return;
  }

  await tg.sendChatAction(chatId).catch(() => {});
  const placeholder = await tg.sendMessage(chatId, "💭 …");
  const reply = new StreamingReply(tg, chatId, placeholder.message_id);

  try {
    if (mode === "generic") {
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
    console.error("reply failed:", redactSecrets(e));
    await reply.fail(errorToUserText(e));
  }
}

/** One-visit setup: GET /setup?secret=<WEBHOOK_SECRET> registers the webhook for this deployment. */
async function handleSetup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.WEBHOOK_SECRET || url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return Response.json({ ok: false, error: "Pass ?secret=<WEBHOOK_SECRET>" }, { status: 403 });
  }
  // A guessable secret means anyone can forge updates: spam into arbitrary
  // chats and burn the owner's model credits.
  if (!isStrongSecret(env.WEBHOOK_SECRET)) {
    return Response.json(
      {
        ok: false,
        error:
          "WEBHOOK_SECRET is too weak: use 16+ random characters " +
          "(e.g. `openssl rand -hex 16`), redeploy, then retry /setup.",
      },
      { status: 400 },
    );
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN secret is not set" }, { status: 500 });
  }
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  try {
    await tg.setWebhook(`${url.origin}/webhook`, env.WEBHOOK_SECRET);
    return Response.json({ ok: true, webhook: `${url.origin}/webhook`, next: "Message your bot on Telegram" });
  } catch (e) {
    return Response.json({ ok: false, error: redactSecrets(e) }, { status: 502 });
  }
}

const PLACEHOLDER_SECRETS = new Set(["change-me-long-random-string", "your-webhook-secret", "secret"]);

export function isStrongSecret(secret: string): boolean {
  return secret.length >= 16 && !PLACEHOLDER_SECRETS.has(secret.toLowerCase());
}
