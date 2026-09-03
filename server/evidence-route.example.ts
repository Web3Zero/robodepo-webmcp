/**
 * EXAMPLE FILE — not runnable as-is in this mirror.
 *
 * This is the Next.js route handler that powers `GET /agent/evidence/{productId}`
 * on the live Robodepo deployment, included here so the evidence pack in
 * ../docs/evidence/holiday-bucket-beige-canvas-l-xl-beige.json (a verbatim
 * copy of docs/agent/evidence/holiday-bucket-beige-canvas-l-xl-beige.json in
 * the main Robodepo repository) can be read alongside the server code that
 * serves it and the `get_product` tool's `include_evidence` option that
 * reads it. Only one product has a pack and its file path is a single
 * literal for the reasons the route's own header comment explains; every
 * other product id is refused before any filesystem call happens. It
 * depends on Next.js's route-handler conventions and Node's
 * `node:fs/promises` and `node:path`, neither of which this mirror installs
 * or builds. Treat it as reference, not as something to `npm run` here —
 * the live behaviour it documents runs at
 * https://robodepo.shop/agent/evidence/holiday-bucket-beige-canvas-l-xl-beige.
 */

/**
 * `GET /agent/evidence/{productId}` — the cited evidence pack for one product.
 *
 * Robodepo publishes no product claim it cannot source, so this pack is a
 * document of citations rather than a summary: an empty section means no
 * source was found, not that the answer is no, and `gaps[]` names what is
 * missing on purpose.
 *
 * Only the tracer product has a pack, and its file path is a single literal.
 * That is deliberate on two counts. A path assembled from the request would
 * be a traversal surface; a path assembled at all — even from a safe map —
 * makes Turbopack trace the whole project into the build output, which in
 * this repository would sweep private evaluation evidence into a deployment.
 * One literal, one product, everything else refused before any filesystem
 * call happens.
 *
 * `noindex`, like `/agent`, `/agent/tools.json` and `/agent/story.md`: the
 * frozen public discovery window gains no new indexed URL.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The only product with a pack, and the only path this route can read. */
export const EVIDENCE_PRODUCT_ID = "holiday-bucket-beige-canvas-l-xl-beige";
export const EVIDENCE_FILE_PATH = "docs/agent/evidence/holiday-bucket-beige-canvas-l-xl-beige.json";

const EVIDENCE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

const REFUSAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

export function evidenceFilePath(): string {
  return join(process.cwd(), EVIDENCE_FILE_PATH);
}

/** Absent id, unknown id and unreadable file are one answer, never three. */
function notFound(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "EVIDENCE_NOT_FOUND",
        message: "No evidence pack is published for that product.",
      },
    }),
    { status: 404, headers: { ...REFUSAL_HEADERS } },
  );
}

async function evidenceResponse(productId: string): Promise<Response> {
  if (productId !== EVIDENCE_PRODUCT_ID) {
    return notFound();
  }
  let pack: string;
  try {
    pack = await readFile(evidenceFilePath(), "utf8");
  } catch {
    return notFound();
  }
  return new Response(pack, { status: 200, headers: { ...EVIDENCE_HEADERS } });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ productId: string }> },
): Promise<Response> {
  const { productId } = await context.params;
  return evidenceResponse(productId);
}

/** Same handler, so the headers match exactly. */
export async function HEAD(
  _request: Request,
  context: { params: Promise<{ productId: string }> },
): Promise<Response> {
  const { productId } = await context.params;
  return evidenceResponse(productId);
}
