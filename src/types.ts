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
}

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
