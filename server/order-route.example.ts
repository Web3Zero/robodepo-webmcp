/**
 * EXAMPLE FILE — not runnable as-is in this mirror.
 *
 * This is the Next.js route handler that powers the same-origin styled order
 * page at `/agent/order/{orderId}` on the live Robodepo deployment, included
 * here so the styled order readback can be read alongside the server code
 * that produces it. It is a presentation wrapper in front of the store's
 * unchanged `GET /orders/{orderId}`: it fetches that page server-side exactly
 * as a browser would, reads the four values the store rendered, and presents
 * them in Robodepo's own design; it adds nothing, computes nothing and
 * decides nothing. Authority is unchanged: the same run cookie that has
 * always guarded `GET /orders/{orderId}` still guards it here. It depends on
 * Next.js's route-handler conventions and this repository's own
 * `getPurchaseApp()` runtime, neither of which this mirror installs or
 * builds. Treat it as reference, not as something to `npm run` here — the
 * live behaviour it documents runs at
 * https://robodepo.shop/agent/order/{orderId}.
 */

/**
 * `/agent/order/{orderId}` — the order readback, in the site's own design.
 *
 * Same shape as `/approve/{mandateId}`: a same-origin presentation wrapper in
 * front of the store's own `GET /orders/{orderId}`. It asks the purchase
 * service for that page exactly as a browser would, reads the four values the
 * store rendered, and presents them. It adds nothing, computes nothing and
 * decides nothing — every figure on this page came out of the store's own
 * order record on this request.
 *
 * The store's page stays exactly where it is and is linked from here, so the
 * unstyled record remains available and this wrapper can never become the only
 * way to read an order.
 *
 * Authority is unchanged: `GET /orders/{orderId}` requires the run cookie that
 * owns the order, and this route forwards the browser's own headers rather
 * than holding any authority of its own. A refusal upstream is repeated here
 * as a bare status with no body from the store, so the wrapper cannot leak
 * which check refused.
 *
 * Nothing in this route is logged.
 */

import { getPurchaseApp } from "@/server/runtime";

const FORWARDED_REQUEST_HEADERS = [
  "cookie",
  "x-real-ip",
  "x-forwarded-for",
  "accept",
  "user-agent",
] as const;

const ORDER_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
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

type OrderView = {
  title: string;
  variant: string;
  deliveryRegion: string;
  total: string;
};

/**
 * Read the four values out of the order page the service just rendered.
 *
 * Deterministic exception: format conversion. This is a mechanical read of one
 * server-rendered template this repository owns, whose exact shape the
 * contract parity suite asserts. The heading is checked first, so a page that
 * is no longer the one this wrapper knows fails closed with a 502 rather than
 * rendering whatever it found. The extracted strings are already HTML-escaped
 * upstream and are re-emitted verbatim.
 */
export function extractOrderView(html: string): OrderView | null {
  if (!html.includes("<h1>Sandbox order confirmed</h1>")) {
    return null;
  }
  const paragraphs = [...html.matchAll(/<p>([^<]*)<\/p>/g)].map((match) => match[1]);
  if (paragraphs.length < 4) {
    return null;
  }
  const [title, variant, deliveryRegion, total] = paragraphs;
  if (!title || !variant || !deliveryRegion || !total) {
    return null;
  }
  return { title, variant, deliveryRegion, total };
}

/** Ids reach an attribute and a heading, so they are bounded before they do. */
function isSafeOrderId(orderId: string): boolean {
  return /^[A-Za-z0-9_.~-]{1,200}$/.test(orderId);
}

function orderPageHtml(view: OrderView, orderId: string): string {
  const record = `/orders/${orderId}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Order confirmed — Robodepo</title>
<link rel="stylesheet" href="/agent/agent.css">
</head>
<body>
<header class="masthead">
<div class="wordmark">Robodepo</div>
<p class="tagline">For shopping agents, and the people they shop for.</p>
</header>
<main class="order-main">
<p class="eyebrow">Sandbox order</p>
<h1>Order confirmed</h1>

<section class="order-card">
<dl class="handoff">
<dt>Item</dt><dd>${view.title}</dd>
<dt>Variant</dt><dd>${view.variant}</dd>
<dt>Delivery region</dt><dd>${view.deliveryRegion}</dd>
<dt>Total</dt><dd class="handoff-total">${view.total}</dd>
<dt>Order id</dt><dd><code class="order-id">${orderId}</code></dd>
</dl>
<p class="note">Nothing was charged. This is a sandbox order in Stripe test mode; no retailer order or fulfilment happens.</p>
<p class="order-links"><a href="/agent" class="order-back-link">Back to Robodepo agent tools</a></p>
</section>

<footer class="order-footer">
<a href="${record}">Store&#39;s own order record</a>
</footer>
</main>
</body>
</html>
`;
}

function refusalResponse(status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Order unavailable — Robodepo</title>
<link rel="stylesheet" href="/agent/agent.css">
</head>
<body>
<main>
<p class="eyebrow">Sandbox order</p>
<h1>This order cannot be shown</h1>
<p class="lede">Robodepo will not show this order. It may not exist, or it may belong to a different browser: an order can only be read from the browser whose run created it.</p>
<p class="note"><a href="/agent">Back to Robodepo agent tools</a></p>
</main>
</body>
</html>
`;
  return new Response(html, { status, headers: { ...ORDER_PAGE_HEADERS } });
}

async function renderOrder(request: Request, orderId: string): Promise<Response> {
  if (!isSafeOrderId(orderId)) {
    return refusalResponse(404);
  }

  const url = new URL(request.url);
  const upstreamUrl = new URL(`/orders/${encodeURIComponent(orderId)}`, url.origin);

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

  const view = extractOrderView(await upstream.text());
  if (!view) {
    return refusalResponse(502);
  }

  return new Response(orderPageHtml(view, orderId), {
    status: 200,
    headers: { ...ORDER_PAGE_HEADERS },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const { orderId } = await context.params;
  return renderOrder(request, orderId);
}

/** Same handler, so the headers match exactly. */
export async function HEAD(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const { orderId } = await context.params;
  return renderOrder(request, orderId);
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
