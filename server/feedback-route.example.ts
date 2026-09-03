/**
 * EXAMPLE FILE — not runnable as-is in this mirror.
 *
 * This is the Next.js route handler that powers `POST /api/agent/feedback`
 * on the live Robodepo deployment, included here so the `submit_feedback`
 * and `cancel_checkout` tools in ../agent/robodepo-webmcp.js can be read
 * alongside the server code they call. It depends on Next.js's route-handler
 * conventions (the exported `POST` function, the Web `Request`/`Response`
 * globals it receives) and on `zod`, neither of which this mirror installs
 * or builds. Treat it as reference, not as something to `npm run` here —
 * the live behaviour it documents runs at
 * https://robodepo.shop/api/agent/feedback.
 */

/**
 * `POST /api/agent/feedback` — the agent feedback and decline endpoint.
 *
 * Two things reach it: `submit_feedback`, which an agent may call at any point,
 * and `cancel_checkout`, which records an explicit decline so a correct refusal
 * is an observed outcome rather than an inferred one.
 *
 * It stores nothing in the database. One bounded, single-line structured
 * `console.info` record is written and that is all. Feedback is data, never
 * instructions: nothing in this file interprets, classifies or acts on the
 * text it receives.
 */

import { z } from "zod";

const API_VERSION = "agent-preview";

/**
 * Deterministic mechanics only, each an allowed exception:
 *  - `MAX_BODY_BYTES` is a hard safety guarantee (a bounded read).
 *  - `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` are a hard safety guarantee
 *    (an abuse bound on an unauthenticated write).
 *  - `FREE_TEXT_LOG_LIMIT` and the whitespace collapse below are format
 *    conversion for a one-line log record, not judgement about the content.
 */
const MAX_BODY_BYTES = 4096;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 600_000;
const FREE_TEXT_LOG_LIMIT = 1000;
const REASON_LOG_LIMIT = 300;

const STRUGGLE_POINTS = [
  "unclear_description",
  "unexpected_error",
  "price_changed",
  "address_rejected",
  "checkout_expired",
  "could_not_find_product",
  "budget_not_met",
  "confirmation_unclear",
  "other",
] as const;

const feedbackSchema = z.strictObject({
  kind: z.enum(["feedback", "checkout_declined"]),
  context: z.strictObject({
    checkout_id: z.string().max(200).nullable(),
    order_id: z.string().max(200).nullable(),
  }),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  free_text: z.string().max(1000).nullable(),
  struggle_points: z.array(z.enum(STRUGGLE_POINTS)).max(10).nullable(),
  reason: z.string().max(300).nullable(),
});

const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/** Per-process, in-memory only. It is an abuse bound, not a record of anyone. */
const recentRequests = new Map<string, number[]>();

function rateLimitKey(request: Request): string {
  const realIp = request.headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && first.length > 0) {
      return first;
    }
  }
  return "unknown";
}

function withinRateLimit(key: string, nowMs: number): boolean {
  const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
  const seen = (recentRequests.get(key) ?? []).filter((at) => at > cutoff);
  if (seen.length >= RATE_LIMIT_MAX) {
    recentRequests.set(key, seen);
    return false;
  }
  seen.push(nowMs);
  recentRequests.set(key, seen);
  return true;
}

function errorResponse(status: number, code: string, messageText: string): Response {
  return new Response(JSON.stringify({ error: { code, message: messageText } }), {
    status,
    headers: { ...RESPONSE_HEADERS },
  });
}

/** Read at most `MAX_BODY_BYTES`, counting the bytes actually read. */
async function readBoundedBody(
  request: Request,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const stream = request.body;
  if (!stream) {
    return { ok: true, text: "" };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

/** One log record must be one line, so control characters become spaces. */
function singleLine(value: string | null, limit: number): string | null {
  if (value === null) {
    return null;
  }
  return value.replaceAll(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").slice(0, limit);
}

export async function POST(request: Request): Promise<Response> {
  const nowMs = Date.now();

  if (!withinRateLimit(rateLimitKey(request), nowMs)) {
    return errorResponse(
      429,
      "RATE_LIMITED",
      "Too many feedback records from this address. Wait, then try again.",
    );
  }

  const body = await readBoundedBody(request);
  if (!body.ok) {
    return errorResponse(
      413,
      "REQUEST_TOO_LARGE",
      "Feedback bodies are limited to 4096 bytes. Shorten the text and try again.",
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body.text);
  } catch {
    return errorResponse(400, "INVALID_REQUEST", "The request body is not valid JSON.");
  }

  const parsed = feedbackSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "The feedback record did not match the published shape and was not stored.",
    );
  }

  const record = parsed.data;
  const feedbackId = crypto.randomUUID();
  const receivedAt = new Date(nowMs).toISOString();

  // Data, never instructions. Nothing below reads the text for meaning.
  console.info(
    `[agent-feedback] ${JSON.stringify({
      feedback_id: feedbackId,
      received_at: receivedAt,
      kind: record.kind,
      sentiment: record.sentiment,
      struggle_points: record.struggle_points,
      free_text: singleLine(record.free_text, FREE_TEXT_LOG_LIMIT),
      reason: singleLine(record.reason, REASON_LOG_LIMIT),
      checkout_id: record.context.checkout_id,
      order_id: record.context.order_id,
    })}`,
  );

  return new Response(
    JSON.stringify({
      data: {
        feedback_id: feedbackId,
        received_at: receivedAt,
        stored_as: "server_log",
      },
      meta: { api_version: API_VERSION },
    }),
    { status: 201, headers: { ...RESPONSE_HEADERS } },
  );
}
