export interface Env {
  SESSIONS: KVNamespace;
  /** BotFather token. Secret. */
  TELEGRAM_BOT_TOKEN: string;
  /** Random string; protects /webhook and /setup. Secret. */
  WEBHOOK_SECRET: string;
  /** "dify" (default) or "generic". */
  BACKEND_MODE?: string;
  /** Dify API base, default https://api.dify.ai/v1 (works for self-hosted too). */
  DIFY_API_URL?: string;
  /** Dify app API key. Secret. Required in "dify" mode. */
  DIFY_API_KEY?: string;
  /** Any HTTP endpoint (n8n / Flowise / your own). Required in "generic" mode. */
  GENERIC_WEBHOOK_URL?: string;
  /** Optional Authorization header value for the generic backend, e.g. "Bearer xyz". Secret. */
  GENERIC_AUTH_HEADER?: string;
  /** "on" (default) or "off" — append 📚 Sources from Dify's retriever metadata. */
  CITATIONS?: string;
  /** "auto" (default) or "off" — transcribe voice notes with Workers AI. */
  VOICE_MODE?: string;
  /** Workers AI binding; present only when the deployment enables voice. */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<{ text?: string }> };
}

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

export interface TgVoice {
  file_id: string;
  duration: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  document?: { file_id: string };
  message_thread_id?: number;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
