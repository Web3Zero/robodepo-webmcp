# Robodepo (a working name)

The full story of what Robodepo is, what works today, and why the checkout can be trusted. Written for anyone reviewing the project, human or agent.

## The problem

Agents cannot reliably complete checkout. Send a shopping agent onto the open web and it will search, compare, and sometimes get as far as filling in a cart. Then it stalls. Pages are built for human eyes and hands: forms with hidden assumptions, checkout flows with steps a person fills in without thinking and an agent has to guess at. The result is an agent that can do almost everything except the one thing that matters: finish the purchase.

Robodepo was built to close that specific gap: not a better search engine or catalogue, but a store where an agent can go from a plain-English request to a prepared order, with a person confirming the one step that should never be automated.

## What Robodepo is

Robodepo is a store built for agents from the ground up: the same purchase system serves the website and the tools, so a person and an agent see the same facts and go through the same checkout logic.

It is being built as the mall for agents: the destination is billions of products from millions of stores, reachable through one consistent set of tools, not a different scraped page for every retailer. That is the destination, not a claim about today's catalogue. What exists right now is one demo product, run all the way through the real purchase path, deliberately, so that path can be measured and trusted before the catalogue grows. Get the till right first. The mall comes after.

## What works today at /agent

Open `/agent` in a WebMCP-aware browser and it registers a catalogue of tools directly with the page: no install, nothing to configure. Eight tools work end to end today:

- **`search_catalog`** finds products, honest that relevance judgement is the agent's own call, not a keyword filter pretending to be one.
- **`get_product`** returns full product detail, including the source retailer and both the source and Robodepo's price, side by side (the roadmap `include_evidence` option is covered below).
- **`create_checkout`** is the hero. One call runs the whole pre-purchase path that used to take several steps: cart, address, delivery quote, and a priced, time-limited mandate for a person to review.
- **`cancel_checkout`** records an explicit decline, a recorded outcome, not something inferred later from silence.
- **`get_order`** reads a placed order straight back once a person has approved it.
- **`get_trust_manifest`** returns the store's public trust manifest.
- **`submit_feedback`** lets an agent leave structured feedback at any point, whether the purchase went through or not; stored as data, never as instructions.
- **`get_tool_guide`** pulls the complete guide for any tool on demand: description, parameter notes, outputs, error recovery and worked examples.

After `create_checkout`, the agent hands the person a link to Robodepo's own approval page, showing the item, the delivery region and the total, nothing more, and asking for one confirmation, a WebAuthn presence check where the browser offers one, the same gesture as unlocking a phone with a fingerprint or face. It is not a payment authorisation and never touches the server directly; it just proves a person is at the device before the same form the plain button would submit gets submitted. Devices without a platform authenticator simply see the plain button, which works the same way.

Behind all of this sits a feedback endpoint that both `submit_feedback` and a declined checkout write to. Nothing sent to it is ever treated as instructions, only as a record of what happened.

## How the human boundary is enforced

The rule that matters most is simple to state and hard to get around: no tool can place an order. Only a person, on Robodepo's own approval page, in a real browser tab, can.

The mechanics come from the purchase contract. Opening the confirmation page requires the run cookie that owns that specific checkout, so a stranger who somehow learned a mandate's id still could not open it. Loading the page mints a fresh confirmation session: a short-lived, browser-only cookie, a single-use security code, and a single-use order key, all issued together and thrown away the moment the page reloads or the checkout is used. The final submission must carry that exact security code and order key, not any value a caller invents, and the server checks the request came from Robodepo's own origin rather than a copy of the page hosted elsewhere. The page refuses to load inside a frame, so it cannot be embedded invisibly and clicked by accident. Every check runs on the server, every time, regardless of what a tool or an agent claims about what a person did.

That is the whole boundary. An agent can prepare everything up to the door. It cannot open it.

## Why the checkout is trustworthy

Trust here is not a claim; it is a set of engineering decisions.

One shared purchase system serves the website and the agent tools, so there is no second, less-tested code path for machines. Every mutation is idempotent, so a retried tool call, the kind of thing an agent does automatically after a slow response, cannot accidentally duplicate an order. Every listing discloses the source retailer, source price and Robodepo's displayed price, side by side.

Behind the visible page is an evaluation setup built to hold the whole system to account. Real agents run through the store under sealed conditions: premium price levels are committed cryptographically before a run starts, so no one, including the people who built this, can adjust the test after seeing a result. Every purchase record gets an independent LLM audit. The protocol is versioned, so a later rule change never quietly applies to old results. A price-integrity check voids any run where the shown price differs from the charged price. That rig has been through ten adversarial review passes, each trying to find a way the evidence could be wrong.

Putting WebMCP in front of an API is easy. Proving the checkout works for agents is the work. The boundary that matters for trust is not where an agent chooses to stop. It is proving, mechanically, that it cannot cross it, rather than asking nicely.

The rig runs real agents, ChatGPT, Codex, Claude and Claude Code, through the real purchase path run after run. What it taught us changed the product: agents fail not because the store is broken but the moment a step is unexplained, and an unexplained rejection makes an agent retry blindly. So every response now names the field, the fix and the next tool, and nine purchase steps became one call. The harness even found a checkout defect no local test could see. Next, it opens as a Test Track, so agent developers can prove their own agents against a real checkout before going live.

## What the agent gets that a listing page cannot give it

A regular product listing gives an agent a title, a price and a few bullet points: the same page a person would read, guessed at by a program instead of understood by one. Robodepo's aim is different: maximally truth-seeking product information, the maximum an agent needs for an informed decision, not the maximum a marketing page wants to show.

`get_product` already discloses the source retailer and both the source price and Robodepo's own price side by side, so an agent is never reasoning from one incomplete number. On the roadmap, the same tool gains an `include_evidence` option: specifications and safe operating limits from the manufacturer's manual, review themes drawn from real use, and permitted YouTube transcript evidence, every claim cited back to its source rather than blended into confident marketing copy. Where sources disagree, the plan is to say so, not average it away.

Context preservation is the other half. An agent pays in tokens, time and tool calls for every page it opens and every irrelevant result it reads past. The roadmap version of `search_by_activity` returns a short, checkout-ready shortlist for the specific request, so an agent spends its context on the products that actually matter rather than trawling thousands of irrelevant pages. That shortlist never closes the door: the full catalogue stays open for an agent that wants to look wider, or do better than the shortlist.

None of this is invented for the pitch: `get_product`'s side-by-side pricing works today; the evidence option and the shortlist are roadmap items, labelled as such everywhere mentioned.

## How this is different from what exists

What exists today splits into two camps. One camp is merchant-side tooling: Shopify's WebMCP, Google's UCP, Microsoft's Copilot Checkout, Perplexity's merchant program, Firmly's no-code connector. Each asks the store to do something first: install WebMCP-capable Liquid, connect a Merchant Center account, join a program, or run an onboarding flow. A store that has never heard of agentic commerce is invisible to all of them. The other camp is buyer-side proxying: Amazon's Buy for Me, Rye and Zinc automate one store's human checkout on the shopper's behalf, using the shopper's own saved details; no merchant cooperation needed, but it depends on that store's checkout form not changing.

Robodepo sits outside both camps, like the proxies in one respect and the merchant tooling in another:

- The shop does nothing. Robodepo aggregates instead of proxying one store at a time: it lists a store's products, discloses that store as the source, and buys from it under the store's own published rules on the human's behalf, so a store that never installed WebMCP, never joined a merchant program and never heard the word agent is still agent-completable, and the same tools work across every store Robodepo lists.
- The agent gets information it cannot get elsewhere: source retailer and price disclosed side by side; evidence and a shortlist, both on the roadmap.
- The human keeps the irreversible step by construction, not by policy.
- Completion is measured, not claimed. A sealed evaluation rig runs real agents through the real purchase path and audits the results, so "it works for agents" is a checked result, not a claim.
- Nothing to install, for the agent, the human or the shop: WebMCP tools sit on the page, plain HTTPS underneath.
- The tool names, `search_catalog`, `get_product`, `create_checkout`, `cancel_checkout`, `get_order`, match the dialect UCP, Shopify and ACP have already converged on.

The nearest things are protocols that ask every shop to integrate, or agents that scrape. Robodepo is the store that already did the work, and it is being built into the world's largest shopping mall for agents: the best product information and a completed order, across millions of stores.

| Name | Side | Who does the work | Completes checkout for the agent? | Source | Date checked |
|---|---|---|---|---|---|
| Shopify WebMCP / Catalog MCP | Merchant tooling | Shopify, auto-on | Yes, in-page | shopify.dev/docs/api/web-mcp | 03-Sep-2026 |
| Google UCP | Protocol/platform | Merchant integrates | Yes, on Google's surfaces | developers.googleblog.com/.../ucp | 03-Sep-2026 |
| OpenAI/Stripe ACP + ChatGPT | Protocol/platform | Merchant builds a ChatGPT App | No, discovery only | digitalcommerce360.com | 03-Sep-2026 |
| Microsoft Copilot Checkout | Platform | Merchant integrates via PayPal/Shopify/Stripe | Yes, in Copilot chat | news.microsoft.com | 03-Sep-2026 |
| Perplexity Buy with Pro | Platform | Merchant joins the program | Yes, in Perplexity | novadata.io | 03-Sep-2026 |
| Amazon Buy for Me | Buyer-side proxy | Nothing required of the brand | Yes, Amazon automates it | aboutamazon.com | 03-Sep-2026 |
| Visa / Mastercard Agent Pay | Payment rail | Issuer, processor and agent support tokenized credentials | No, authorizes payment elsewhere | digitalcommerce360.com | 03-Sep-2026 |
| Firmly Connect | Merchant onboarding | Merchant does a no-code setup | Enables it; the agent channel completes it | digitalcommerce360.com | 03-Sep-2026 |
| Nekuda / Skyfire / PayOS | Payment/identity infra | Developer and payment network integrate | No, infrastructure only | useproxy.ai | 03-Sep-2026 |
| Rye / Zinc | Buyer-side execution API | Nobody at the store; Rye/Zinc automate it | Yes, by proxying human checkout | rye.com/blog/agentic-commerce-startups | 03-Sep-2026 |

## The tool design

Every tool follows the same shape, so an agent that has seen one can guess the rest. Each registered description is kept short, sized to fit Chrome's WebMCP guidance; the full depth, parameter notes, every output field, error recovery, worked examples, lives at `/agent/tools.json`, pullable on demand with `get_tool_guide`.

Input schemas are strict: no undeclared fields, every property described. Every tool carries explicit annotations for whether it only reads data, whether it changes anything, whether it is safe to retry, and whether its output could carry untrusted third-party text, so a host browser can apply its own policy.

The tool names follow a `verb_noun` pattern aligned with Google's UCP, Shopify's storefront tools and OpenAI and Stripe's ACP.

## Responses that tell the agent what to do next

Every response carries a `status` the agent branches on, `messages` naming the exact field and fix rather than just saying something went wrong, `next_actions` with the retry already filled in, and separate `instructions` for the agent and the human, since the two need different advice at once. An error is never actionless.

Here is a real one, trimmed to the fields that matter, what `create_checkout` returns when asked to ship to a postcode this sandbox does not accept:

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

Trimmed from the full envelope, which also carries `resource` and `links`; the request never reached the store, caught client-side.

## Where this is going

The roadmap groups around what actually helps an agent buy well. Four items below are preview tools in the live catalogue, honestly labelled, returning `status: "not_available"`; one is a roadmap option on a tool that already works; the last is a future product.

- **Search by need**, a checkout-ready shortlist for the request instead of trawling thousands of irrelevant pages (`search_by_activity`).
- **The best source of product truth**, specifications, manuals, review themes and permitted YouTube transcript evidence, cited and fresh rather than copied from marketing pages, coming to `get_product` as an `include_evidence` option.
- **Side by side comparison**, across products a person or an agent is weighing up (`compare_products`).
- **One tool to transact across many merchants**, the same prepare-then-approve path beyond Robodepo's own catalogue (`get_shipping_options`, and the delegated-checkout direction behind it).
- **Continued assistance**, replenishment reminders and price alerts for the things people buy again (`subscribe_replenishment_alerts`).
- **A Test Track**, the same evaluation harness opened up for agent developers to prove their own agents against a real checkout before going live.

## Before and for the challenge

Before the challenge existed, the Robodepo store, its purchase API and its human confirmation page were already real and working; nothing about that prior work changed for this submission. Everything at `/agent` is new: the WebMCP tool catalogue described above, the one-call `create_checkout` tool, the approval page and its WebAuthn presence check, the feedback endpoint, the full test suite covering every tool's schema and response shape, and the public repository this story is copied into.

## Links

- Live page: https://robodepo.shop/agent
- Full tool catalogue, machine-readable: https://robodepo.shop/agent/tools.json
- Trust manifest: https://robodepo.shop/trust-manifest.json
- Public repository: https://github.com/Web3Zero/robodepo-webmcp
