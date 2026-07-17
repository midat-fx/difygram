/**
 * Generic backend: POST the user message to any HTTP endpoint (n8n webhook,
 * Flowise, your own server) and pull a human-readable reply out of whatever
 * shape it returns.
 */

const REPLY_KEYS = ["reply", "answer", "output", "text", "message", "result", "response", "content"] as const;

function coerce(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => coerce(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of REPLY_KEYS) {
      const found = coerce(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return "";
}

/** Accepts plain text, {"reply": "..."} and friends, or n8n-style [{"output": "..."}]. */
export function extractReply(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    return coerce(JSON.parse(trimmed)) || trimmed;
  } catch {
    return trimmed;
  }
}

export interface GenericPayload {
  chat_id: number;
  user: string;
  text: string;
  source: "telegram";
}

export async function callGeneric(
  url: string,
  payload: GenericPayload,
  authHeader?: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Backend responded ${res.status}: ${body.slice(0, 200)}`);
  return extractReply(body);
}
