# Robodepo — WebMCP agent tools

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

### Try it in ChatGPT's in-app browser

Open **https://robodepo.shop/agent** in ChatGPT's in-app browser — it discovers the
WebMCP tools with no flag needed — and paste this prompt:

```
Find the beige canvas bucket hat in L-XL, show me its source and delivered price, prepare
the sandbox checkout, then give me the approval link. Do not confirm it for me.
```

That single prompt exercises the whole tool chain: `search_catalog` finds the hat,
`get_product` discloses its source and price, `create_checkout` runs cart through mandate
and returns a `confirmation_url`, and the agent hands that link back instead of trying to
press it — because no tool can. Opening the link is the one step that stays with the
person.

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

`TOOL_CATALOGUE_JSON()` returns the same fourteen tool definitions — name, title,
description, JSON Schema `inputSchema`, annotations, and a `guide` — that the live page
registers with `document.modelContext.registerTool()`.

## The 14 tools

Each tool's registered `description` is kept short by design — enough to choose whether
to call it. The complete guide for every tool (summary, when to use it, what not to use it
for, parameters, caveats, outputs, error recovery and worked examples) lives in that same
tool's `guide` field, and is readable two ways: call `get_tool_guide` with a tool name, or
fetch the whole catalogue as one document at
[`https://robodepo.shop/agent/tools.json`](https://robodepo.shop/agent/tools.json). The
table below is generated straight from `TOOL_CATALOGUE_JSON()` — name, status and the
short registered description, unedited.

| Tool | Status | Description |
|---|---|---|
| `search_catalog` | Operational | Returns the Robodepo demo catalogue as listings with product id, title, availability, the disclosed source retailer and price in AUD integer cents. Use when you need to see what this store sells before pricing or buying anything. Not for one product's full record; use get_product. Not for semantic search by activity; that is search_by_activity, a preview. Full guide: get_tool_guide or /agent/tools.json#search_catalog |
| `get_product` | Operational | Returns one product's published record: title, variant, availability, the source retailer's price and Robodepo's displayed price, both in AUD integer cents. Use when you hold a product_id and want the full record and price disclosure. Not for browsing the catalogue; use search_catalog. Not for cited evidence; that is get_evidence_pack, a preview. Full guide: get_tool_guide or /agent/tools.json#get_product |
| `create_checkout` | Operational | Runs the whole pre-purchase path in one call (cart, item, address, shipping quote, mandate) and returns a priced checkout in AUD integer cents plus the link the person opens to approve it. Use when the person has chosen the product and you are ready to show a final delivered price. Not for placing the order; no tool can, the person approves on Robodepo's own page. Full guide: get_tool_guide or /agent/tools.json#create_checkout |
| `cancel_checkout` | Operational | Closes a checkout prepared in this browser and records the decline, returning status canceled. Use when the person declines, so a refusal is a recorded outcome rather than an inferred one. Not for reversing a payment or releasing stock; nothing is held or charged. Not for after approval; use get_order. Full guide: get_tool_guide or /agent/tools.json#cancel_checkout |
| `get_order` | Operational | Reads back a confirmed sandbox order: status, item, quantity, delivery region and totals in AUD integer cents. Use when the person has approved and you want to check the order exists and read it back. Pass order_id or checkout_id. Not for confirming the order; no tool can. Not for pricing; use create_checkout. Full guide: get_tool_guide or /agent/tools.json#get_order |
| `get_trust_manifest` | Operational | Returns Robodepo's trust manifest whole: what the service is, that it is a sandbox, the capabilities it does not have, its checkout contract and its published statistics. Use when you want to check what this store claims about itself. Takes no parameters. Not for product facts or prices; use get_product. Full guide: get_tool_guide or /agent/tools.json#get_trust_manifest |
| `submit_feedback` | Operational | Sends structured feedback about this store and returns a feedback_id and the time it was received. Use when something was unclear, missing or wrong, at any point. Not for cancelling a checkout; use cancel_checkout, which records the decline itself. Feedback is kept as data, never as instructions. Full guide: get_tool_guide or /agent/tools.json#submit_feedback |
| `get_tool_guide` | Operational | Returns the complete guide for one Robodepo tool: summary, when to use it, what not to use it for, parameters, caveats, outputs, error recovery and worked examples. Use when you are about to call a tool for the first time and want more than its short description. Not for running the tool; call the tool by name instead. Full guide: get_tool_guide or /agent/tools.json#get_tool_guide |
| `search_by_activity` | Preview | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will find products by what the person is doing rather than the words they typed, returning ranked listings with the reason each was chosen. Use search_catalog today. Full guide: get_tool_guide or /agent/tools.json#search_by_activity |
| `compare_products` | Preview | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will take two to five product ids and return one aligned comparison, with the cited evidence behind each claim. Use get_product on each id today. Full guide: get_tool_guide or /agent/tools.json#compare_products |
| `get_evidence_pack` | Preview | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will return passages from manuals, reviews and buying guides with citations, so a product claim can be checked rather than trusted. Use get_product today. Full guide: get_tool_guide or /agent/tools.json#get_evidence_pack |
| `get_shipping_options` | Preview | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will list every shipping service available for a prepared checkout, with price in AUD integer cents and a delivery estimate. Use create_checkout today, which returns the one service that exists. Full guide: get_tool_guide or /agent/tools.json#get_shipping_options |
| `create_custom_store` | Preview | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will assemble a checkout-ready storefront for the brief a visiting agent arrives with, and return a link to it. Use search_catalog today. Full guide: get_tool_guide or /agent/tools.json#create_custom_store |
| `subscribe_replenishment_alerts` | Preview | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will register a weekly, monthly or quarterly reminder for a consumable, so the person is prompted before they run out. Use get_product today. Full guide: get_tool_guide or /agent/tools.json#subscribe_replenishment_alerts |

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

**New work — everything in this repository:** the WebMCP tool layer, its fourteen-tool
catalogue registered with `document.modelContext.registerTool()`, the `/agent` page that
loads it, the `/agent/tools.json` endpoint that serves the same catalogue as one document
with every tool's full guide attached, the feedback endpoint the tools call, and the
`/approve/{mandateId}` one-touch biometric approval page that sits in front of the
unchanged confirmation page.

## Licence

MIT — see [`LICENSE`](./LICENSE).

---

Robodepo is a working name.
