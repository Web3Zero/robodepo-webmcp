/**
 * EXAMPLE FILE — not runnable as-is in this mirror.
 *
 * This is the Next.js route handler that powers the same-origin approval
 * page at `/approve/{mandateId}` on the live Robodepo deployment, included
 * here so the biometric gesture in ../agent/approve.js can be read
 * alongside the server code it hands off to. It is a presentation wrapper
 * in front of the store's unchanged `GET /confirm/{mandateId}`: it fetches
 * that page server-side exactly as a browser would, carries its single-use
 * `csrf` value and server-issued `idempotency_key` into an identical form,
 * and copies its confirmation cookie back to the browser verbatim — every
 * check the purchase contract describes still runs, unchanged, in the same
 * place. It depends on Next.js's route-handler conventions and on this
 * repository's own `getPurchaseApp()` runtime, neither of which this
 * mirror installs or builds. Treat it as reference, not as something to
 * `npm run` here — the live behaviour it documents runs at
 * https://robodepo.shop/approve/{mandateId}.
 */

/**
 * `/approve/{mandateId}` — the thumbprint mandate page.
 *
 * What this is, precisely: a same-origin **presentation wrapper** in front of
 * the existing `GET /confirm/{mandateId}`. It asks the purchase service for
 * that page exactly as a browser would, carries the page's own single-use
 * `csrf` value and server-issued `idempotency_key` into an identical form, and
 * copies the `__Host-robodepo_confirmation` cookie back to the browser
 * verbatim. The form still posts to `POST /api/v1/mandates/{id}/confirm`.
 *
 * What this is **not**: a new server-side authority. Every check the contract
 * describes still runs, unchanged and in the same place — the run cookie, the
 * confirmation cookie, the single-use CSRF value, the server-issued single-use
 * idempotency key, the same-origin requirement and the five-minute session.
 * The biometric step added by `/agent/approve.js` is a client-side user
 * verification gesture in front of those checks. The server never sees it, no
 * credential leaves the browser, and nothing about the mandate's authority
 * depends on it. `/confirm/{mandateId}` remains untouched and is linked from
 * this page as the plain alternative.
 *
 * Consequences worth stating in the code rather than only in a report:
 *  - Rendering this page mints a **new** confirmation session, exactly as
 *    reloading `/confirm` does, and supersedes any previously issued CSRF
 *    value and key. Opening both pages invalidates whichever was opened first.
 *  - It spends one unit of the published `confirmation.read` budget (10 per
 *    15 minutes per run and mandate), the same as a reload.
 *  - Unlike `/confirm`, this page runs script (`/agent/approve.js`, same
 *    origin, no inline script permitted by its CSP). That is a real widening
 *    of the confirmation page's attack surface and is recorded as such.
 *
 * Nothing in this route is logged. It handles a live CSRF value and a live
 * idempotency key, and neither may ever reach a log line.
 */

import { getPurchaseApp } from "@/server/runtime";

/** Only these travel inward, so the upstream sees what a browser would send. */
const FORWARDED_REQUEST_HEADERS = [
  "cookie",
  "x-real-ip",
  "x-forwarded-for",
  "accept",
  "user-agent",
] as const;

const APPROVAL_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export const APPROVAL_SCRIPT_PATH = "/agent/approve.js";

type ConfirmationView = {
  title: string;
  variant: string;
  deliveryRegion: string;
  total: string;
  csrf: string;
  idempotencyKey: string;
  formAction: string;
};

/**
 * Read the six values out of the confirmation page the service just rendered.
 *
 * Deterministic exception: **format conversion**. This is not judgement about
 * meaning — it is a mechanical read of one server-rendered template this
 * repository owns, whose exact shape is asserted by the contract parity suite.
 * Every field is then checked against a strict charset before it is re-emitted,
 * so a change upstream fails closed with a 502 rather than rendering something
 * unexpected into a form that carries live confirmation authority.
 *
 * The extracted strings are already HTML-escaped by the upstream page, so they
 * are re-emitted verbatim: the browser decodes them back to the originals and
 * posts exactly the values the server issued.
 */
export function extractConfirmationView(html: string): ConfirmationView | null {
  const paragraphs = [...html.matchAll(/<p>([^<]*)<\/p>/g)].map((match) => match[1]);
  const action = html.match(/<form method="post" action="([^"]+)">/)?.[1];
  const csrf = html.match(/<input type="hidden" name="csrf" value="([^"]*)">/)?.[1];
  const key = html.match(
    /<input type="hidden" name="idempotency_key" value="([^"]*)">/,
  )?.[1];

  if (paragraphs.length < 4 || !action || !csrf || !key) {
    return null;
  }
  // The action is re-emitted into an attribute, so it is bounded to the one
  // route it can legitimately be. A hard safety guarantee, not a heuristic.
  if (!/^\/api\/v1\/mandates\/[A-Za-z0-9_.~-]{1,200}\/confirm$/.test(action)) {
    return null;
  }
  // `csrf` is base64url and the issued key is `human-` plus base64url, so both
  // are confined to the base64url alphabet. Anything else fails closed.
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(csrf) || !/^[A-Za-z0-9_-]{1,200}$/.test(key)) {
    return null;
  }

  return {
    title: paragraphs[0],
    variant: paragraphs[1],
    deliveryRegion: paragraphs[2],
    total: paragraphs[3],
    csrf,
    idempotencyKey: key,
    formAction: action,
  };
}

function approvalPageHtml(view: ConfirmationView, mandateId: string): string {
  const plainConfirmationPath = `/confirm/${encodeURIComponent(mandateId)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Approve sandbox purchase — Robodepo (working name)</title>
<link rel="stylesheet" href="/agent/agent.css">
</head>
<body>
<main>
<p class="eyebrow">Public validation sandbox</p>
<h1>Approve sandbox purchase</h1>

<section>
<dl class="handoff">
<dt>Item</dt><dd>${view.title}</dd>
<dt>Variant</dt><dd>${view.variant}</dd>
<dt>Delivery region</dt><dd>${view.deliveryRegion}</dd>
<dt>Amount</dt><dd>${view.total}</dd>
</dl>
<form method="post" action="${view.formAction}" id="approve-form">
<input type="hidden" name="csrf" value="${view.csrf}">
<input type="hidden" name="idempotency_key" value="${view.idempotencyKey}">
<button type="submit" id="approve-button">Approve with fingerprint or face</button>
</form>
<p id="approve-status"></p>
<p class="note">Sandbox only. No real charge. The approval gesture is checked by your browser; Robodepo&#39;s server then verifies the same one-time confirmation it always has.</p>
<p class="note"><a href="${plainConfirmationPath}">Use the plain confirmation page instead</a></p>
</section>
</main>
<script type="module" src="${APPROVAL_SCRIPT_PATH}"></script>
</body>
</html>
`;
}

/**
 * A refusal page with no upstream body and no detail. The purchase service's
 * own error envelope stays where it is; repeating it here would tell a caller
 * which of the ownership, state or expiry checks refused, which the contract
 * deliberately does not do.
 */
function refusalResponse(status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Approval unavailable — Robodepo (working name)</title>
<link rel="stylesheet" href="/agent/agent.css">
</head>
<body>
<main>
<h1>This purchase cannot be approved</h1>
<p class="lede">Robodepo will not show an approval page for this checkout. It may have expired, already been used, or belong to a different browser. Nothing was ordered and nothing was charged.</p>
<p class="note">Ask the agent to prepare a new checkout.</p>
</main>
</body>
</html>
`;
  return new Response(html, { status, headers: { ...APPROVAL_PAGE_HEADERS } });
}

async function renderApproval(request: Request, mandateId: string): Promise<Response> {
  // Same origin as the incoming request, path replaced. Nothing from the URL
  // beyond the mandate id reaches the upstream request.
  const url = new URL(request.url);
  const upstreamUrl = new URL(
    `/confirm/${encodeURIComponent(mandateId)}`,
    url.origin,
  );

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  const upstream = await getPurchaseApp().handle(
    new Request(upstreamUrl, { method: "GET", headers }),
  );

  if (upstream.status !== 200) {
    return refusalResponse(upstream.status);
  }

  const view = extractConfirmationView(await upstream.text());
  if (!view) {
    // The upstream page is no longer the shape this wrapper knows. Fail closed
    // rather than render a form whose values were not understood.
    return refusalResponse(502);
  }

  const response = new Response(approvalPageHtml(view, mandateId), {
    status: 200,
    headers: { ...APPROVAL_PAGE_HEADERS },
  });

  // The confirmation cookie is the authority the form's POST needs. It is
  // copied verbatim and never read, parsed or stored here.
  const cookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [upstream.headers.get("set-cookie")].filter(
          (value): value is string => typeof value === "string",
        );
  for (const cookie of cookies) {
    response.headers.append("set-cookie", cookie);
  }

  return response;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ mandateId: string }> },
): Promise<Response> {
  const { mandateId } = await context.params;
  return renderApproval(request, mandateId);
}

/** Same handler, so the headers and the minted session match exactly. */
export async function HEAD(
  request: Request,
  context: { params: Promise<{ mandateId: string }> },
): Promise<Response> {
  const { mandateId } = await context.params;
  return renderApproval(request, mandateId);
}
