# Robodepo (working name) — WebMCP agent tools

Robodepo is a working sandbox store built for AI shopping agents. This repository is a
WebMCP layer over that store's existing purchase system: an agent searches the catalogue,
prices a product and fills in the checkout through browser-registered tools, then hands the
person one link. The person is the only one who can press confirm, on Robodepo's own
confirmation page — nothing is charged, ordered or shipped without that single tap.

## Try it live

Open **https://robodepo.shop/agent** in:

- **Chrome 149 or later**, with `chrome://flags/#enable-webmcp-testing` turned on, or
- **ChatGPT's in-app browser**, which discovers WebMCP tools with no flag needed.

To inspect the tool list, schemas, and call any tool by hand, install the
[**Model Context Tool Inspector**](https://chromewebstore.google.com/detail/webmcp-model-context-tool/gbpdfapgefenggkahomfgkhfehlcenpd)
Chrome extension.

A worked sequence, once the page has registered its tools:

1. `search_catalog` — returns the demo catalogue (one product).
2. `get_product` — returns the full record for that product, including the source
   retailer's price and Robodepo's displayed price.
3. `create_checkout` — runs the whole pre-purchase path (cart, address, shipping quote,
   purchase mandate) in one call, against the accepted sandbox address below, and returns a
   `confirmation_url`.
4. Open that `confirmation_url` — it now points at the approval page — touch the sensor
   (fingerprint or face; devices with no biometric get the plain single button instead),
   and land on the order page. This step is the person's alone — no tool can do it.
5. `get_order` — reads the confirmed order back: item, delivery region, totals.

The only address the sandbox accepts, exactly as shown, field for field:

```
recipient_name: Sandbox Buyer
line1:          10 Example Street
line2:          (null)
suburb:         Wembley Downs
state:          WA
postcode:       6019
country:        AU
```

Any other address is refused before any request is sent. Cart creation (`create_checkout`)
is rate limited to 10 attempts per address per hour. Nothing here is a real transaction: it
runs in Stripe test mode, so there is no real charge, no source-retailer order and no
fulfilment.

## Run it locally

This repository has no server of its own. The tools in `agent/robodepo-webmcp.js` call
Robodepo's frozen purchase API with same-origin, cookie-carrying requests
(`credentials: "same-origin"`), which only works when the page is served from the same
origin as a real Robodepo deployment — a plain `agent/index.html` opened from `file://`, or
served on its own from an unrelated origin, cannot complete a checkout, because the run
cookie and CORS both tie it to that origin. In practice, "run it locally" means running a
Robodepo build and serving this page from `/agent` on that build's own origin — the live URL
above is the intended way to try the tools.

You can still read and exercise the tool catalogue itself in Node, without a server, because
`agent/robodepo-webmcp.js` is a plain ES module with no imports and guards every browser
global behind a check (`typeof window !== "undefined"`), so importing it under Node only
defines its exports and does nothing else:

```
node -e 'import("./agent/robodepo-webmcp.js").then(m => console.log(JSON.stringify(m.TOOL_CATALOGUE_JSON(), null, 2)))'
```

`TOOL_CATALOGUE_JSON()` returns the same thirteen tool definitions — name, title,
description, JSON Schema `inputSchema`, and annotations — that the live page registers with
`document.modelContext.registerTool()`.

## The 13 tools

| Tool | Kind | What it does |
|---|---|---|
| `search_catalog` | Operational | Returns the Robodepo demo catalogue as listings, each with its product id, title, variant, availability, the disclosed source retailer, and the displayed price. |
| `get_product` | Operational | Returns every published field for one product: title, variant, availability, the source retailer's price and Robodepo's displayed price, plus the source disclosure. |
| `create_checkout` | Operational | Runs the entire pre-purchase path in one call — cart, item, address, shipping quote and purchase mandate — and returns a priced checkout with a `confirmation_url` the person opens to place the sandbox order. |
| `cancel_checkout` | Operational | Marks a checkout prepared in this browser as declined, records the decline with Robodepo, and returns `status: "canceled"` so a correct refusal is a recorded outcome rather than something inferred from silence. |
| `get_order` | Operational | Reads a confirmed sandbox order and returns its status, item, quantity, delivery region and totals. |
| `get_trust_manifest` | Operational | Fetches Robodepo's machine-readable trust manifest and returns it whole: what the service is, that it is a sandbox, which capabilities it does not have, how its checkout contract works, and what statistics it publishes. |
| `submit_feedback` | Operational | Sends structured feedback about this store to Robodepo and returns an acknowledgement with a `feedback_id` and the time it was received. |
| `search_by_activity` | Preview | Meant to find products by what the person is doing rather than by words they typed — "something to keep the sun off on a boat" — and to return ranked listings with the reasoning that put each one there. |
| `compare_products` | Preview | Meant to take two to five product ids and return one aligned comparison — shared attributes, where they differ, and the cited evidence behind each claim. |
| `get_evidence_pack` | Preview | Meant to return the evidence behind a product — passages from manuals, reviews and buying guides, each with its citation — so a claim can be checked rather than trusted. |
| `get_shipping_options` | Preview | Meant to list the shipping services available for a prepared checkout — service name, price and delivery estimate — so the person can pick one. |
| `create_custom_store` | Preview | Meant to assemble a storefront for the brief a visiting agent arrives with — a narrowed selection, priced and ready to buy through the same checkout path — and return a link to it. |
| `subscribe_replenishment_alerts` | Preview | Meant to register a repeating reminder for a consumable — weekly, monthly or quarterly — so the person is prompted before they run out, and to return the subscription id. |

Every preview tool says so in the first words of its description, returns
`status: "not_available"` with a plain explanation of what is not built, and points
`next_actions` back at the operational tools above. None of them return fabricated data.

## Response envelope

Every tool answers with the same shape:

```json
{
  "status": "ok",
  "resource": {
    "type": "checkout",
    "checkout_id": "chk_9f2a1c7b",
    "confirmation_url": "https://robodepo.shop/confirm/mnd_7e0d21f4",
    "totals": {
      "items_cents": 11385,
      "shipping_cents": 1200,
      "total_cents": 12585,
      "currency": "AUD",
      "formatted_total": "A$125.85"
    },
    "expires_at": "2026-09-03T05:15:00Z",
    "delivery_region": "WA 6019",
    "source_retailer": "Lack of Color",
    "price_may_differ": true
  },
  "messages": [],
  "next_actions": ["get_order", "cancel_checkout"],
  "links": [
    { "rel": "confirmation_page", "href": "https://robodepo.shop/confirm/mnd_7e0d21f4" }
  ],
  "instructions": {
    "for_human": "Open the link to review and confirm your order — nothing is charged until you do.",
    "for_agent": "Hand the confirmation_url to the person. No tool can press confirm on their behalf."
  }
}
```

`status`, `messages[]`, `next_actions[]`, `links[]` and `instructions` are present on every
response, success or error; `next_actions` is never empty on an error. `resource` is `null`
when a tool has nothing to return, such as a preview tool's `not_available` response. No
envelope ever carries a cookie value, a CSRF value, a Stripe object, or a full postal
address — the delivery region (`WA 6019`) is the most location detail that leaves the tool
layer.

## Why the person confirms on Robodepo's own page

**Experience.** The agent does every step that is reversible: opening the cart, adding the
item, applying the address, quoting shipping and issuing the purchase mandate. The person
sees the item, the delivery region and the total on one page, with one button. Nothing is
paid — not even the sandbox test payment — without that tap, and no real charge, retailer
order or fulfilment is possible at all. The page shows exactly what will be ordered: the
immutable item, variant, delivery region and amounts the mandate was issued against.

**Security.** There is no tool that can submit the confirmation — this catalogue has no
`complete_checkout`, and the agent is told not to submit that form. The confirmation page
requires the browser's own run cookie, and the submission additionally requires a
single-use CSRF value and a server-issued single-use idempotency key, both minted by that
page. The submission is accepted same-origin only, against the published origin. The
confirmation session and its cookie expire after 5 minutes. The confirmation page cannot be
framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). Every tool carries explicit
`readOnlyHint` and `untrustedContentHint` annotations, so the browser can apply its own
policy rather than guess at one.

Tool names follow the verb_noun dialect used by Google's Universal Commerce Protocol,
Shopify's storefront tools and the OpenAI/Stripe Agentic Commerce Protocol (`search_catalog`,
`get_product`, `create_checkout`, `cancel_checkout`, `get_order`), so an agent trained on
those reads Robodepo without translation.

### One-touch approval

`create_checkout`'s `confirmation_url` now points at a same-origin approval page
(`/approve/{mandateId}`) in front of the unchanged confirmation page, and `links[]` carries
both `approval_page` and `confirmation_page` so an agent or a person can reach either. The
approval page shows the same item, variant, delivery region and total, then asks the
browser for a platform biometric (Touch ID, a fingerprint or face unlock, Windows Hello) —
a passkey-style user-verification gesture — before submitting the store's own confirmation
form with the server's unchanged single-use `csrf` value and idempotency key. A device with
no platform authenticator falls back to the plain single button, exactly as
`/confirm/{mandateId}` has always worked.

This gesture proves a person is present at the device; it is not a server-side control. The
credential it creates is discarded immediately — nothing derived from it is sent to
Robodepo or anywhere else, and the server has no way to know the gesture happened. Every
check that actually protects the purchase is unchanged and still runs server-side: the run
cookie, the confirmation cookie, the single-use CSRF value, the single-use idempotency key,
the same-origin requirement and the five-minute confirmation session.

## Prior work vs new work

**Prior work — not in this repository, built and live before this submission:** the
Robodepo store itself, its frozen purchase API (version 1), the human confirmation page at
`/confirm/{mandate_id}`, and the trust manifest that discloses how the store operates. None
of it changed for this submission.

**New work — everything in this repository:** the WebMCP tool layer, its thirteen-tool
catalogue registered with `document.modelContext.registerTool()`, the `/agent` page that
loads it, the feedback endpoint the tools call, and the `/approve/{mandateId}` one-touch
biometric approval page that sits in front of the unchanged confirmation page.

## Licence

MIT — see [`LICENSE`](./LICENSE).

---

Robodepo is a working name.
