import { answerKeyboard, parseCallback, starterKeyboard, votedKeyboard, type InlineKeyboard } from "./buttons";
import { DifyClient, DifyError, streamDifyChat, type DifyAppParameters } from "./dify";
import { errorToUserText } from "./errors";
import { checkPhoto, checkVoice, largestPhoto, TEXTS, transcribe } from "./media";
import { markdownToTelegramHtml } from "./format";
import { callGeneric } from "./generic";
import { acquireLock, releaseLock } from "./lock";
import { redactSecrets } from "./redact";
import { clearConversation, getConversation, saveConversation } from "./session";
import { recallSuggestions, rememberSuggestions } from "./suggestions";
import { CURSOR, StreamingReply } from "./stream";
import { Telegram } from "./telegram";
import type { Env, TgCallbackQuery, TgMessage, TgUpdate } from "./types";

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

const BUSY_TEXT = "⏳ Still answering your previous message — wait or press ⏹ Stop.";

// Persistent bottom-of-chat button; tapping it sends this exact text, which we
// route to /reset. Coexists with the inline answer buttons (separate layer).
const NEW_CHAT_BUTTON = "🆕 New chat";
const MENU_KEYBOARD = {
  keyboard: [[{ text: NEW_CHAT_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

/** Bot username, resolved once per isolate; used to tell our /commands from other bots'. */
let botUsername: string | null = null;
/** App parameters, cached per isolate — Dify does not change them mid-flight. */
let cachedParams: { at: number; value: DifyAppParameters } | null = null;
const PARAMS_TTL_MS = 10 * 60 * 1000;

async function getBotUsername(tg: Telegram): Promise<string | null> {
  if (botUsername !== null) return botUsername;
  try {
    botUsername = (await tg.getMe()).username ?? "";
  } catch {
    botUsername = "";
  }
  return botUsername;
}

function difyClient(env: Env): DifyClient {
  return new DifyClient({
    apiUrl: env.DIFY_API_URL ?? "https://api.dify.ai/v1",
    apiKey: env.DIFY_API_KEY as string,
  });
}

async function getParams(env: Env): Promise<DifyAppParameters> {
  const now = Date.now();
  if (cachedParams && now - cachedParams.at < PARAMS_TTL_MS) return cachedParams.value;
  try {
    const value = await difyClient(env).parameters();
    cachedParams = { at: now, value };
    return value;
  } catch (e) {
    console.warn("parameters fetch failed:", redactSecrets(e));
    return cachedParams?.value ?? {};
  }
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
  if (update.callback_query) return handleCallback(env, update.callback_query);
  if (update.message?.chat) return handleMessage(env, update.message);
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

  if (message.voice) return handleVoice(env, tg, message);
  if (message.photo) return handlePhoto(env, tg, message);

  const text = message.text?.trim();
  if (!text) {
    // In groups every join/pin/photo would otherwise get a reply — that's spam.
    if (isPrivate) await tg.sendMessage(chatId, "I can only read text messages for now.");
    return;
  }

  if (text === NEW_CHAT_BUTTON) return doReset(env, tg, chatId);

  if (text.startsWith("/")) {
    const cmd = parseCommand(text, isPrivate, await getBotUsername(tg));
    if (cmd === "start") {
      await sendStart(env, tg, chatId);
      return;
    }
    if (cmd === "help") {
      await tg.sendMessage(chatId, HELP_TEXT);
      return;
    }
    if (cmd === "reset") return doReset(env, tg, chatId);
    if (cmd === null && /^\/\w+(@\w+)?$/.test(text)) return; // command for another bot
  }

  await runLocked(env, tg, chatId, text);
}

async function doReset(env: Env, tg: Telegram, chatId: number): Promise<void> {
  if (!(await acquireLock(chatId))) {
    await tg.sendMessage(chatId, BUSY_TEXT);
    return;
  }
  try {
    await clearConversation(env.SESSIONS, chatId);
    await tg.sendMessage(chatId, "🔄 New chat — the next message starts fresh.", { reply_markup: MENU_KEYBOARD });
  } finally {
    await releaseLock(chatId);
  }
}

/** Voice notes: transcribe at the edge, then walk the normal text path. */
async function handleVoice(env: Env, tg: Telegram, message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const voiceEnabled = (env.VOICE_MODE ?? "auto") !== "off" && Boolean(env.AI);
  const check = checkVoice(message, voiceEnabled);
  if (!check.ok) {
    await tg.sendMessage(chatId, TEXTS[check.reason]);
    return;
  }

  if (!(await acquireLock(chatId))) {
    await tg.sendMessage(chatId, BUSY_TEXT);
    return;
  }
  let transcript = "";
  try {
    await tg.sendChatAction(chatId).catch(() => {});
    const file = await tg.getFile(message.voice!.file_id);
    if (!file.file_path) throw new Error("no file_path");
    transcript = await transcribe(env.AI!, await tg.downloadFile(file.file_path));
  } catch (e) {
    console.warn("transcription failed:", redactSecrets(e));
    await releaseLock(chatId);
    await tg.sendMessage(chatId, TEXTS.voiceUnavailable);
    return;
  }

  if (!transcript) {
    await releaseLock(chatId);
    await tg.sendMessage(chatId, TEXTS.voiceEmpty);
    return;
  }

  try {
    // Showing what was heard makes a wrong transcription obvious instead of baffling.
    await tg.sendMessage(chatId, `🎙 “${transcript}”`);
    await generate(env, tg, chatId, transcript);
  } finally {
    await releaseLock(chatId);
  }
}

/** Photos go to Dify as uploaded files; the caption becomes the question. */
async function handlePhoto(env: Env, tg: Telegram, message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const isPrivate = message.chat.type === "private";
  const photo = largestPhoto(message.photo);
  if (!photo) return;

  if ((env.BACKEND_MODE ?? "dify") !== "dify" || !env.DIFY_API_KEY) {
    if (isPrivate) await tg.sendMessage(chatId, "I can only read text messages for now.");
    return;
  }

  const check = checkPhoto(photo);
  if (!check.ok) {
    await tg.sendMessage(chatId, TEXTS[check.reason]);
    return;
  }

  // Dify accepts the upload even when the app has image input switched off — it
  // just never shows the file to the model, and the answer becomes "what image?".
  // Ask the app first and say something useful instead of burning a model call.
  const params = await getParams(env);
  if (params.file_upload?.image?.enabled === false) {
    await tg.sendMessage(chatId, TEXTS.photoNotEnabled);
    return;
  }

  if (!(await acquireLock(chatId))) {
    await tg.sendMessage(chatId, BUSY_TEXT);
    return;
  }
  try {
    await tg.sendChatAction(chatId).catch(() => {});
    const file = await tg.getFile(photo.file_id);
    if (!file.file_path) throw new Error("no file_path");
    // Bytes are passed through rather than handing Dify a Telegram file URL:
    // that URL embeds the bot token and would end up in someone else's storage.
    const bytes = await tg.downloadFile(file.file_path);
    const fileId = await difyClient(env).uploadImage(bytes, `tg-${chatId}`);
    await generate(env, tg, chatId, message.caption?.trim() || "What's in this image?", [fileId]);
  } catch (e) {
    console.error("photo handling failed:", redactSecrets(e));
    const isUploadRejection = e instanceof DifyError && (e.status === 400 || e.status === 403);
    await tg.sendMessage(chatId, isUploadRejection ? TEXTS.photoNotEnabled : errorToUserText(e));
  } finally {
    await releaseLock(chatId);
  }
}

/** Greeting: the app's own opening statement when it has one. */
async function sendStart(env: Env, tg: Telegram, chatId: number): Promise<void> {
  if ((env.BACKEND_MODE ?? "dify") === "dify" && env.DIFY_API_KEY) {
    const params = await getParams(env);
    const opening = params.opening_statement?.trim();
    if (opening) {
      await tg.sendMessage(chatId, opening, {
        reply_markup: starterKeyboard(params.suggested_questions ?? []),
      });
      return;
    }
  }
  // Plain greeting (never edited) is a safe place to set the persistent
  // New-chat button; the opening-statement branch above uses inline starters
  // instead, and the button then shows on the first /reset.
  await tg.sendMessage(chatId, START_TEXT, { reply_markup: MENU_KEYBOARD });
}

async function runLocked(env: Env, tg: Telegram, chatId: number, text: string): Promise<void> {
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

async function handleCallback(env: Env, query: TgCallbackQuery): Promise<void> {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const cb = parseCallback(query.data);
  const chatId = query.message?.chat.id;
  const user = `tg-${chatId}`;

  if (!cb || !chatId) {
    await tg.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  try {
    switch (cb.kind) {
      case "feedback-noop":
        await tg.answerCallbackQuery(query.id);
        return;

      case "stop": {
        // Deliberately outside the generation lock: the whole point is to
        // interrupt the run that currently holds it.
        await tg.answerCallbackQuery(query.id, "Stopped");
        await difyClient(env).stop(cb.taskId, user);
        // Dify stops producing tokens but can hold the SSE connection open until
        // it times out, and that isolate cannot be reached from here. So this
        // handler finishes the message itself: the text Telegram just handed us
        // is exactly what the user sees.
        const partial = (query.message?.text ?? "").replace(CURSOR.trim(), "").trimEnd();
        if (query.message && partial) {
          await tg.editFinal(chatId, query.message.message_id, markdownToTelegramHtml(partial), partial);
        }
        // Free the chat immediately instead of making the user wait out the
        // stranded stream's lock.
        await releaseLock(chatId);
        return;
      }

      case "feedback": {
        await tg.answerCallbackQuery(query.id, "Thanks for the feedback!");
        await difyClient(env).feedback(cb.messageId, cb.rating, user);
        if (query.message) {
          const previous = (query.message as { reply_markup?: InlineKeyboard }).reply_markup;
          await tg.editReplyMarkup(chatId, query.message.message_id, votedKeyboard(previous, cb.rating));
        }
        return;
      }

      case "suggestion": {
        await tg.answerCallbackQuery(query.id);
        // Read back the exact list the buttons were built from: Dify would
        // generate a different set on a second call, and index N would then
        // point at a question the user never saw.
        const cached = await recallSuggestions(cb.messageId);
        const questions = cached ?? (await difyClient(env).suggested(cb.messageId, user));
        const question = questions[cb.index];
        if (!question) return;
        await tg.sendMessage(chatId, question);
        await runLocked(env, tg, chatId, question);
        return;
      }

      case "starter": {
        await tg.answerCallbackQuery(query.id);
        const params = await getParams(env);
        const question = (params.suggested_questions ?? [])[cb.index];
        if (!question) return;
        await tg.sendMessage(chatId, question);
        await runLocked(env, tg, chatId, question);
        return;
      }
    }
  } catch (e) {
    console.error("callback failed:", redactSecrets(e));
    await tg.answerCallbackQuery(query.id).catch(() => {});
  }
}

async function generate(
  env: Env,
  tg: Telegram,
  chatId: number,
  text: string,
  fileIds: string[] = [],
): Promise<void> {
  const mode = env.BACKEND_MODE ?? "dify";
  if (mode !== "dify" && mode !== "generic") {
    await tg.sendMessage(chatId, `⚙️ BACKEND_MODE="${mode}" is not supported. Use "dify" or "generic".`);
    return;
  }

  await tg.sendChatAction(chatId).catch(() => {});
  // No reply keyboard here: a message carrying one can't be edited afterwards,
  // and this placeholder is exactly the message the stream edits.
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
    let messageId = "";
    let sources: string[] = [];
    const images: string[] = [];

    const run = async (cid: string | null) => {
      for await (const chunk of streamDifyChat({
        apiUrl: env.DIFY_API_URL ?? "https://api.dify.ai/v1",
        apiKey: env.DIFY_API_KEY as string,
        query: text,
        user: `tg-${chatId}`,
        conversationId: cid,
        ...(fileIds.length ? { fileIds } : {}),
      })) {
        if (chunk.conversationId) conversationId = chunk.conversationId;
        if (chunk.messageId) messageId = chunk.messageId;
        if (chunk.taskId) reply.setTaskId(chunk.taskId);
        if (chunk.sources) sources = chunk.sources;
        if (chunk.fileUrl) images.push(chunk.fileUrl);
        if (chunk.replaceText !== undefined) reply.replace(chunk.replaceText);
        if (chunk.status) await reply.setStatus(chunk.status);
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

    const citations = env.CITATIONS === "off" ? "" : formatSources(sources);
    const suggestions = messageId ? await followUps(env, messageId, chatId) : [];
    if (messageId && suggestions.length) await rememberSuggestions(messageId, suggestions);
    const keyboard = messageId ? answerKeyboard(messageId, suggestions) : undefined;
    await reply.finalize(citations ? `${reply.text}${citations}` : undefined, keyboard);
    await saveConversation(env.SESSIONS, chatId, conversationId, previous);
    if (images.length) await sendImages(tg, chatId, images, env);
  } catch (e) {
    console.error("reply failed:", redactSecrets(e));
    await reply.fail(errorToUserText(e));
  }
}

export function formatSources(sources: string[]): string {
  const unique = [...new Set(sources)].slice(0, 3);
  return unique.length ? `\n\n📚 Sources: ${unique.join(", ")}` : "";
}

/** Follow-up suggestions are a bonus: a failure here must not cost the answer. */
async function followUps(env: Env, messageId: string, chatId: number): Promise<string[]> {
  const params = await getParams(env);
  if (!params.suggested_questions_after_answer?.enabled) return [];
  try {
    return await difyClient(env).suggested(messageId, `tg-${chatId}`);
  } catch (e) {
    console.warn("suggested fetch failed:", redactSecrets(e));
    return [];
  }
}

async function sendImages(tg: Telegram, chatId: number, urls: string[], env: Env): Promise<void> {
  const origin = new URL(env.DIFY_API_URL ?? "https://api.dify.ai/v1").origin;
  for (const url of urls.slice(0, 5)) {
    try {
      // Absolute-ise relative URLs, then pass the bytes through: Dify's signed
      // links are fussy and a self-hosted instance is invisible to Telegram.
      const absolute = url.startsWith("http") ? url : `${origin}${url}`;
      const res = await fetch(absolute, { headers: { authorization: `Bearer ${env.DIFY_API_KEY}` } });
      if (!res.ok) continue;
      await tg.sendPhoto(chatId, await res.arrayBuffer());
    } catch (e) {
      console.warn("image forward failed:", redactSecrets(e));
    }
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
    // Validating the key here catches the most common onboarding mistake.
    let app: string | undefined;
    if ((env.BACKEND_MODE ?? "dify") === "dify" && env.DIFY_API_KEY) {
      app = (await difyClient(env).info().catch(() => ({}) as { name?: string })).name;
    }
    return Response.json({
      ok: true,
      webhook: `${url.origin}/webhook`,
      ...(app ? { dify_app: app } : {}),
      next: "Message your bot on Telegram",
    });
  } catch (e) {
    return Response.json({ ok: false, error: redactSecrets(e) }, { status: 502 });
  }
}

const PLACEHOLDER_SECRETS = new Set(["change-me-long-random-string", "your-webhook-secret", "secret"]);

export function isStrongSecret(secret: string): boolean {
  return secret.length >= 16 && !PLACEHOLDER_SECRETS.has(secret.toLowerCase());
}
