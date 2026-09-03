/**
 * EXAMPLE FILE — not runnable as-is in this mirror.
 *
 * This is the Next.js route handler that powers `GET /agent/tools.json` on
 * the live Robodepo deployment, included here so the full per-tool `guide`
 * field returned by `TOOL_CATALOGUE_JSON()` in ../agent/robodepo-webmcp.js
 * can be read alongside the server code that serves it as one document. It
 * imports the catalogue straight from that same browser module, so there is
 * one source of truth and no generated copy that can drift. It depends on
 * Next.js's route-handler conventions (the exported `GET` function, the Web
 * `Request`/`Response` globals it receives), neither of which this mirror
 * installs or builds. Treat it as reference, not as something to `npm run`
 * here — the live behaviour it documents runs at
 * https://robodepo.shop/agent/tools.json.
 */

/**
 * `/agent/tools.json` — the tool catalogue as one document.
 *
 * A plain HTTP mirror of what `document.modelContext` is handed on `/agent`,
 * plus the full `guide` for every tool. An agent that would rather read one
 * document than call `get_tool_guide` fourteen times reads this instead; the
 * public MIT mirror repository and the README print the same thing.
 *
 * It imports the catalogue straight from the browser module, so there is one
 * source of truth and no generated copy that can drift. That module guards
 * every browser global, so importing it on the server does nothing but define
 * its exports.
 *
 * `noindex`, like `/agent` and the trust manifest: the frozen public discovery
 * window gains no new indexed URL. Unlike `/agent` this is cacheable, because
 * it is a static document with no run state in it at all.
 */

import { TOOL_CATALOGUE_JSON } from "../../../../public/agent/robodepo-webmcp.js";

const CATALOGUE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

function catalogueResponse(): Response {
  const tools = TOOL_CATALOGUE_JSON();
  return new Response(
    JSON.stringify(
      { generated_at: new Date().toISOString(), count: tools.length, tools },
      null,
      2,
    ),
    { status: 200, headers: { ...CATALOGUE_HEADERS } },
  );
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: "GET, HEAD",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(): Promise<Response> {
  return catalogueResponse();
}

/** Same body, so the headers match exactly; Next strips it before the wire. */
export async function HEAD(): Promise<Response> {
  return catalogueResponse();
}

export async function POST(): Promise<Response> {
  return methodNotAllowed();
}

export async function PUT(): Promise<Response> {
  return methodNotAllowed();
}

export async function PATCH(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
