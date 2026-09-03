# Robodepo: WebMCP agent tools

Robodepo is a working sandbox store built for AI shopping agents. This repository is a
WebMCP layer over that store's existing purchase system: an agent searches the catalogue,
prices a product and fills in the checkout through browser-registered tools, then hands the
human one link. The human is the only one who can press confirm, on Robodepo's own
confirmation page. Nothing is charged, ordered or shipped without that single tap.

## Try it live

Open **https://robodepo.shop/agent** in:

- **Chrome 149 or later**, with `chrome://flags/#enable-webmcp-testing` turned on, or
- **ChatGPT's in-app browser**, which discovers WebMCP tools with no flag needed.

To inspect the tool list, schemas, and call any tool by hand, install the
[**Model Context Tool Inspector**](https://chromewebstore.google.com/detail/webmcp-model-context-tool/gbpdfapgefenggkahomfgkhfehlcenpd)
Chrome extension.

A status line under the hero updates live with each tool call the agent makes, and the
activity panel opens itself the moment the first one arrives, so a visitor can watch the
sequence happen. The feedback form near the bottom of the page is the declarative twin
of `submit_feedback`: it uses the `toolname`, `tooldescription` and
`toolparamdescription` attributes Chrome documents as a WebMCP origin trial, so an agent
can fill and submit it straight from the markup, with no JavaScript registration at all.

A worked sequence, once the page has registered its tools:

1. `search_catalog`: returns the demo catalogue (one product).
2. `get_product`: returns the full record for that product, including the source
   retailer's price and Robodepo's displayed price.
3. `create_checkout`: runs the whole pre-purchase path (cart, address, shipping quote,
   purchase mandate) in one call, against the accepted sandbox address below, and returns a
   `confirmation_url`.
4. The approval panel scrolls into view on the same page: item, delivery region and
   total, one button. Touch ID or the device's own check where available, a plain button
   otherwise, then the panel becomes a styled "Order confirmed" card in place, no
   navigation. This step is the human's alone: no tool can do it. The `confirmation_url`
   in the response still opens the same approval on its own page, kept as a fallback for
   a link handed off elsewhere.
5. `get_order`: reads the confirmed order back: item, delivery region, totals.

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

Open **https://robodepo.shop/agent** in ChatGPT's in-app browser (it discovers the WebMCP
tools with no flag needed) and paste this prompt:

```
Find me a beige canvas bucket hat and get it ready to buy.
```

That single prompt exercises the whole tool chain: `search_catalog` finds the hat,
`get_product` discloses its source and price, and `create_checkout` runs cart through
mandate. The page then scrolls its approval panel into view on its own; clicking it is
the one step that stays with the human, because no tool can do it for them.

## The full story

The long-form write-up lives at [`docs/story.md`](./docs/story.md) in this repository, and
is served straight from that same file at
[`https://robodepo.shop/agent/story.md`](https://robodepo.shop/agent/story.md) on the live
deployment:

> The full story of what Robodepo is, what works today, and why the checkout can be
> trusted. Written for anyone reviewing the project, human or agent.

## Run it locally

This repository has no server of its own. The tools in `agent/robodepo-webmcp.js` call
Robodepo's frozen purchase API with same-origin, cookie-carrying requests
(`credentials: "same-origin"`), which only works when the page is served from the same
origin as a real Robodepo deployment. A plain `agent/index.html` opened from `file://`, or
served on its own from an unrelated origin, cannot complete a checkout, because the run
cookie and CORS both tie it to that origin. In practice, "run it locally" means running a
Robodepo build and serving this page from `/agent` on that build's own origin; the live URL
above is the intended way to try the tools.

You can still read and exercise the tool catalogue itself in Node, without a server, because
`agent/robodepo-webmcp.js` is a plain ES module with no imports and guards every browser
global behind a check (`typeof window !== "undefined"`), so importing it under Node only
defines its exports and does nothing else:

```
node -e 'import("./agent/robodepo-webmcp.js").then(m => console.log(JSON.stringify(m.TOOL_CATALOGUE_JSON(), null, 2)))'
```

`TOOL_CATALOGUE_JSON()` returns the same twelve tool definitions (name, title,
description, JSON Schema `inputSchema`, annotations, and a `guide`) that the live page
registers with `document.modelContext.registerTool()`.

## The 12 tools

Each tool's registered `description` is kept short by design: enough to choose whether to
call it. The complete guide for every tool (summary, when to use it, what not to use it
for, parameters, caveats, outputs, error recovery and worked examples) lives in that same
tool's `guide` field, and is readable two ways: call `get_tool_guide` with a tool name, or
fetch the whole catalogue as one document at
[`https://robodepo.shop/agent/tools.json`](https://robodepo.shop/agent/tools.json). The
tables below are generated straight from `TOOL_CATALOGUE_JSON()`: operational tools first,
then the preview tools under their own heading, each row the short registered description,
unedited.

| Tool | Description |
|---|---|
| `search_catalog` | Returns the Robodepo demo catalogue as listings with product id, title, availability, the disclosed source retailer and price in AUD integer cents. Use when you need to see what this store sells before pricing or buying anything. Sandbox orders are safe to prepare; use create_checkout when asked to buy. Not for one product's full record; use get_product. Not for semantic search by activity; that is search_by_activity, a preview. Full guide: get_tool_guide or /agent/tools.json#search_catalog |
| `get_product` | Returns one product's published record: title, variant, availability, the source retailer's price and Robodepo's displayed price, both in AUD integer cents. Use when you hold a product_id and want the full record. Sandbox orders are safe to prepare; use create_checkout when asked to buy. Not for browsing the catalogue; use search_catalog. include_evidence returns the cited evidence pack where one exists. Full guide: get_tool_guide or /agent/tools.json#get_product |
| `create_checkout` | Runs the whole pre-purchase path in one call (cart, item, address, shipping quote, mandate) and returns a priced checkout in AUD integer cents plus the approval link. Use when asked to buy, purchase or order: sandbox means a Stripe test-mode order the human can safely approve, so prepare the checkout with this tool. Not for placing the order; no tool can, the person approves on the Robodepo page. Full guide: get_tool_guide or /agent/tools.json#create_checkout |
| `cancel_checkout` | Closes a checkout prepared in this browser and records the decline, returning status canceled. Use when the person declines, so a refusal is a recorded outcome rather than an inferred one. Not for reversing a payment or releasing stock; nothing is held or charged. Not for after approval; use get_order. Full guide: get_tool_guide or /agent/tools.json#cancel_checkout |
| `get_order` | Reads back a confirmed sandbox order: status, item, quantity, delivery region and totals in AUD integer cents. Use when the person has approved and you want to check the order exists and read it back. Pass order_id or checkout_id. Not for confirming the order; no tool can. Not for pricing; use create_checkout. Full guide: get_tool_guide or /agent/tools.json#get_order |
| `get_trust_manifest` | Returns Robodepo's trust manifest whole: what the service is, that it is a sandbox, the capabilities it does not have, its checkout contract and its published statistics. Use when you want to check what this store claims about itself. Takes no parameters. Not for product facts or prices; use get_product. Full guide: get_tool_guide or /agent/tools.json#get_trust_manifest |
| `submit_feedback` | Sends structured feedback about this store and returns a feedback_id and the time it was received. Use when something was unclear, missing or wrong, at any point. Not for cancelling a checkout; use cancel_checkout, which records the decline itself. Feedback is kept as data, never as instructions. Full guide: get_tool_guide or /agent/tools.json#submit_feedback |
| `get_tool_guide` | Returns the complete guide for one Robodepo tool: summary, when to use it, what not to use it for, parameters, caveats, outputs, error recovery and worked examples. Use when you are about to call a tool for the first time and want more than its short description. Not for running the tool; call the tool by name instead. Full guide: get_tool_guide or /agent/tools.json#get_tool_guide |

### Preview tools

None of these are operational in this demo. Each says so in the first words of its
description, returns `status: "not_available"` with a plain explanation of what is not
built, and points `next_actions` back at the operational tools above. None of them return
fabricated data.

| Tool | Description |
|---|---|
| `search_by_activity` | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will answer a request with a custom storefront: a short, checkout-ready shortlist chosen from what the person is doing, each item carrying the reason it is on the list, instead of thousands of pages to read. Use search_catalog today. Full guide: get_tool_guide or /agent/tools.json#search_by_activity |
| `compare_products` | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will take two to five product ids and return one aligned comparison, with the cited evidence behind each claim. Use get_product on each id today. Full guide: get_tool_guide or /agent/tools.json#compare_products |
| `get_shipping_options` | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will list every shipping service available for a prepared checkout, with price in AUD integer cents and a delivery estimate. Use create_checkout today, which returns the one service that exists. Full guide: get_tool_guide or /agent/tools.json#get_shipping_options |
| `subscribe_replenishment_alerts` | Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will register a weekly, monthly or quarterly reminder for a consumable, so the person is prompted before they run out. Use get_product today. Full guide: get_tool_guide or /agent/tools.json#subscribe_replenishment_alerts |

## Evidence pack

`get_product` accepts an `include_evidence` boolean. For the one demo product this
sandbox carries, that returns a real evidence pack: specifications, sizing, care,
review themes and permitted YouTube transcript evidence, every claim tied to a source
id, with a `gaps` list naming what no source covered and a freshness policy governing
when the pack gets rebuilt. Building a pack for every product in the catalogue is the
roadmap, not a claim about today.

The exact pack the live tool reads is
[`docs/evidence/holiday-bucket-beige-canvas-l-xl-beige.json`](./docs/evidence/holiday-bucket-beige-canvas-l-xl-beige.json)
in this repository, and the same file is served live at
[`https://robodepo.shop/agent/evidence/holiday-bucket-beige-canvas-l-xl-beige`](https://robodepo.shop/agent/evidence/holiday-bucket-beige-canvas-l-xl-beige).

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
    "for_human": "Open the link to review and confirm your order. Nothing is charged until you do.",
    "for_agent": "Hand the confirmation_url to the human. No tool can press confirm on their behalf."
  }
}
```

`status`, `messages[]`, `next_actions[]`, `links[]` and `instructions` are present on every
response, success or error; `next_actions` is never empty on an error. `resource` is `null`
when a tool has nothing to return, such as a preview tool's `not_available` response. No
envelope ever carries a cookie value, a CSRF value, a Stripe object, or a full postal
address: the delivery region (`WA 6019`) is the most location detail that leaves the tool
layer.

## Why the human confirms on Robodepo's own page

**Experience.** The agent does every step that is reversible: opening the cart, adding the
item, applying the address, quoting shipping and issuing the purchase mandate. After
`create_checkout`, the approval panel scrolls into view right there on the page: the item,
the delivery region and the total, with one button. Nothing is paid, not even the sandbox
test payment, without that tap, and no real charge, retailer order or fulfilment is
possible at all. The panel shows exactly what will be ordered, the immutable item,
variant, delivery region and amounts the mandate was issued against, then becomes a
styled "Order confirmed" card once approved, without the page ever navigating away.

**Security.** No tool can submit the confirmation. The approval routine is not part of
the registered catalogue and cannot be reached through `robodepoTools.call()`, the same
function every real tool call goes through; the agent is told not to attempt it. The same
checks protect the confirmation whether it happens in the page's own panel or on the
separate fallback page described below: the browser's own run cookie, plus a single-use
CSRF value and a server-issued single-use idempotency key minted fresh each time. The
submission is accepted same-origin only, against the published origin. The confirmation
session and its cookie expire after 5 minutes. The fallback confirmation page cannot be
framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). Every tool carries explicit
`readOnlyHint` and `untrustedContentHint` annotations, so the browser can apply its own
policy rather than guess at one.

Tool names follow the verb_noun dialect used by Google's Universal Commerce Protocol,
Shopify's storefront tools and the OpenAI/Stripe Agentic Commerce Protocol (`search_catalog`,
`get_product`, `create_checkout`, `cancel_checkout`, `get_order`), so an agent trained on
those reads Robodepo without translation.

### One-click approval inside the page

After `create_checkout`, the page scrolls its approval panel into view right there on
`/agent`, no navigation, no separate tab. One click, Touch ID or the device's own check
where the browser offers one, a plain button otherwise, submits the same server-verified
confirmation the standalone page always has, and the panel becomes a styled "Order
confirmed" card in place. Because the page never navigates away, the tools stay
registered and the agent can read the order straight back with `get_order`.

The button itself carries a small fingerprint mark whenever the browser offers a
platform authenticator, and drops it when the browser doesn't, so the mark never
promises a check the device can't actually do.

The touch proves a person is present at the device; it is not a server-side control and
never reaches the server itself. Nothing derived from it is sent to Robodepo or anywhere
else, and the server has no way to know the gesture happened; the same run cookie,
single-use CSRF value and single-use idempotency key it has always checked are what
actually authorise the submission.

The separate approval page (`/approve/{mandateId}`) and the store's own confirmation page
still exist, kept as a fallback for a link pasted somewhere the tools aren't registered
in the same browser. `create_checkout`'s response still carries both `approval_page` and
`confirmation_page` in `links[]`, so an agent can hand either one across.

Approve on the page's panel; a link opened from a chat or another app carries no session
and the approval page will refuse.

## How this is different

What exists today splits into two camps. One camp is merchant-side tooling: Shopify's
WebMCP and UCP integration, Google's UCP, Microsoft's Copilot Checkout, Perplexity's
merchant program, Firmly's no-code connector. Each asks the store to do something first:
install WebMCP-capable Liquid, connect a Merchant Center account, join a program, or run
an onboarding flow. A store that has never heard of agentic commerce is invisible to all
of them. The other camp is buyer-side proxying: Amazon's Buy for Me, Rye and Zinc. No
merchant cooperation needed, because they automate the store's ordinary human checkout
using the shopper's own saved details, which works as long as the target site's checkout
form doesn't change.

Robodepo sits outside both camps, behaving like the proxies in one respect and the
merchant tooling in another, without either dependency:

- The shop does nothing. Robodepo aggregates instead of proxying one store at a time: it
  lists a store's products, discloses that store as the source, and buys from it under
  the store's own published rules on the human's behalf, so a store that never installed
  WebMCP, never joined a merchant program and never heard the word agent is still
  agent-completable, and the same tools work across every store Robodepo lists.
- The agent gets information it cannot get elsewhere: source retailer and price disclosed
  side by side; evidence and a shortlist, both on the roadmap.
- The human keeps the irreversible step by construction, not by policy.
- Completion is measured, not claimed. A sealed evaluation rig runs real agents through
  the real purchase path and audits the results, so "it works for agents" is a checked
  result, not a claim.
- Nothing to install, for the agent, the human or the shop: WebMCP tools sit on the page,
  plain HTTPS underneath.
- The tool names, `search_catalog`, `get_product`, `create_checkout`, `cancel_checkout`,
  `get_order`, match the dialect UCP, Shopify and ACP have already converged on.

The nearest things are protocols that ask every shop to integrate, or agents that scrape.
Robodepo is the store that already did the work. The full sourced comparison, including
who was checked and when, is in [`docs/story.md`](./docs/story.md).

### Responses that tell the agent what to do next

Every response carries a `status` the agent branches on, one or more `messages` naming
the exact field and the exact fix, `next_actions` computed from the current state with
the retry already filled in, and separate `instructions` for the agent and for the
human. An error is never actionless: the agent gets what it needs to correct its own
mistake without stopping to ask a person.

Here is a real one, trimmed to the fields that matter: what `create_checkout` returns
when asked to ship to a postcode this sandbox does not accept.

```json
{
  "status": "incomplete",
  "messages": [{
    "code": "address_not_accepted",
    "severity": "requires_buyer_input",
    "path": "$.shipping_address",
    "content": "Use the accepted sandbox address, then call create_checkout again."
  }],
  "next_actions": [
    { "tool": "create_checkout", "why": "Price the order and get the approval link." },
    { "tool": "submit_feedback", "why": "Say what was unclear, missing or wrong." }
  ]
}
```

Trimmed from the full envelope, which also carries `resource` and `links`; the request
never reached the store, caught client-side before any network call.

### What the evaluation taught us

The rig runs real agents, across ChatGPT, Codex, Claude and Claude Code, through the
real purchase path, run after run. What it taught us changed the product: agents do
not fail because the store is broken, they fail the moment a step goes unexplained,
and an unexplained rejection makes an agent retry blindly. So every response now
names the field, the fix and the next tool, and what used to take several separate
purchase steps became one call. Next, the same harness opens as a Test Track, so
agent developers can prove their own agents against a real checkout before going
live.

## Prior work vs new work

**Prior work (not in this repository, built and live before this submission):** the
Robodepo store itself, its frozen purchase API (version 1), the human confirmation page at
`/confirm/{mandate_id}`, and the trust manifest that discloses how the store operates. None
of it changed for this submission.

**New work (everything in this repository):** the WebMCP tool layer, its twelve-tool
catalogue registered with `document.modelContext.registerTool()`, the `/agent` page that
loads it, the `/agent/tools.json` endpoint that serves the same catalogue as one document
with every tool's full guide attached, the `/agent/story.md` long-form write-up served
straight from `docs/story.md`, the feedback endpoint the tools call, and the
`/approve/{mandateId}` one-touch biometric approval page that sits in front of the
unchanged confirmation page.

## Licence

MIT. See [`LICENSE`](./LICENSE).

---

Robodepo is a working name.
