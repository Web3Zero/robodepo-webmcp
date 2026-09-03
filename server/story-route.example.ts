/**
 * EXAMPLE FILE — not runnable as-is in this mirror.
 *
 * This is the Next.js route handler that powers `GET /agent/story.md` on
 * the live Robodepo deployment, included here so the long-form write-up in
 * ../docs/story.md (a verbatim copy of docs/agent/story.md in the main
 * Robodepo repository) can be read alongside the server code that serves
 * it. It reads that file from disk at request time rather than importing
 * it, so the story can be edited without a rebuild. It depends on Next.js's
 * route-handler conventions (the exported `GET` function, the Web
 * `Request`/`Response` globals it receives) and Node's `node:fs/promises`
 * and `node:path`, and on this repository's own working directory layout,
 * none of which this mirror installs or builds. Treat it as reference, not
 * as something to `npm run` here — the live behaviour it documents runs at
 * https://robodepo.shop/agent/story.md.
 */

/**
 * `GET /agent/story.md` — the long-form write-up, served as Markdown.
 *
 * The prose lives in `docs/agent/story.md` so it can be edited without
 * touching code and copied verbatim into the public MIT repository. This
 * handler reads that file at request time rather than importing it, so a
 * rewrite of the story needs no rebuild.
 *
 * It is deliberately NOT under `public/`. Next refuses to start a request for
 * a path that has both a public file and a route — "A conflicting public file
 * and page file was found for path /agent/story.md" — and answers 500, so a
 * file at `public/agent/story.md` would not shadow this route, it would break
 * it. `docs/` is outside the served tree, so this route owns the URL and can
 * put `noindex` on it; a copy under `public/` would also have been reachable
 * at a second URL with no such header.
 *
 * `noindex`, like `/agent`, `/agent/tools.json` and the trust manifest: the
 * frozen public discovery window gains no new indexed URL. It is cacheable
 * because it is a static document with no run state in it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Written as one literal, not assembled from parts. A path the bundler cannot
 * resolve statically makes it trace the entire project into the build output —
 * measured here as 10,566 files, which in this repository would mean sweeping
 * private evaluation evidence into a deployment. Keep it a literal.
 */
export const STORY_FILE_PATH = "docs/agent/story.md";

const STORY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/markdown; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

const MISSING_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

/** The path is fixed by this module; nothing from the request reaches it. */
export function storyFilePath(): string {
  return join(process.cwd(), STORY_FILE_PATH);
}

async function storyResponse(): Promise<Response> {
  let markdown: string;
  try {
    markdown = await readFile(storyFilePath(), "utf8");
  } catch {
    // Absent or unreadable. Say so plainly and do not cache the absence.
    return new Response("The story is not published yet.\n", {
      status: 404,
      headers: { ...MISSING_HEADERS },
    });
  }
  return new Response(markdown, { status: 200, headers: { ...STORY_HEADERS } });
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
  return storyResponse();
}

/** Same body, so the headers match exactly; Next strips it before the wire. */
export async function HEAD(): Promise<Response> {
  return storyResponse();
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
