# Robodepo (a working name)

The full story of what Robodepo is, what actually works today, and why the checkout can be trusted. Written for anyone reviewing the project, human or agent.

## The problem

Agents cannot reliably complete checkout. Send a shopping agent onto the open web today and it will search, compare, and sometimes even get as far as filling in a cart. Then it stalls. Pages are built for human eyes and human hands: forms with hidden assumptions, checkout flows with steps a person fills in without thinking and an agent has to guess at. The result is an agent that can do almost everything except the one thing that actually matters: finish the purchase.

Robodepo was built to close that specific gap. Not a better search engine, not a better catalogue on its own, but a store where an agent can go from a plain-English request to a prepared order, with a person confirming the one step that should never be automated.

## What Robodepo is

Robodepo is a store built for agents from the ground up: the same purchase system serves the website and the tools, so a person and an agent see the same product facts and go through the same checkout logic.

It is being built as the mall for agents: the destination is billions of products from millions of stores, reachable through one consistent set of tools rather than a different scraped page for every retailer. That is the destination, not a claim about today's catalogue. What exists right now is one demo product, run all the way through the real purchase path, deliberately, so that path can be measured and trusted before the catalogue grows. Get the till right first. The mall comes after.

## What works today at /agent

Open `/agent` in a WebMCP-aware browser and it registers a catalogue of tools directly with the page: no install, no separate agent setup, nothing to configure. Eight of those tools work end to end today:

- **`search_catalog`** finds products in the demo catalogue and is honest that relevance judgement is the agent's own call, not a keyword filter pretending to be one.
- **`get_product`** returns full product detail, including the source retailer and both the source price and Robodepo's own price, side by side. A roadmap option, `include_evidence`, will add specifications, manuals, review themes and permitted YouTube transcript evidence, cited and fresh.
- **`create_checkout`** is the hero. One call runs the whole pre-purchase path that used to take several separate steps: cart, address, delivery quote, and a priced, time-limited mandate ready for a person to review.
- **`cancel_checkout`** records an explicit decline, so a correct refusal becomes a recorded outcome rather than something inferred later from silence.
- **`get_order`** reads a placed order straight back once a person has approved it.
- **`get_trust_manifest`** returns the store's public trust manifest.
- **`submit_feedback`** lets an agent leave structured feedback at any point, whether the purchase went through or the agent walked away from it. It is stored as data, never as instructions.
- **`get_tool_guide`** pulls the complete guide for any tool on demand: full description, parameter notes, outputs, error recovery, and worked examples.

After `create_checkout`, the agent hands the person a link to Robodepo's own approval page. That page shows the item, the delivery region and the total, nothing more, and asks for one confirmation. Where the browser offers it, that confirmation can be a WebAuthn presence check, the same gesture as unlocking a phone with a fingerprint or face. It is not a payment authorisation and never touches the server directly; it just proves a person is at the device before the same form the plain button would submit gets submitted. Devices without a platform authenticator simply see the plain button, which works the same way.

Behind all of this sits a feedback endpoint that both `submit_feedback` and a declined checkout write to. Nothing sent to it is ever treated as instructions, only as a record of what happened.

## How the human boundary is enforced

The rule that matters most in this whole design is simple to state and deliberately hard to get around: no tool can place an order. Only a person, on Robodepo's own approval page, in a real browser tab, can do that.

The mechanics behind that rule come straight from the purchase contract. Opening the confirmation page requires the run cookie that owns that specific checkout, so a stranger who somehow learned a mandate's id still could not open it. Loading the page mints a fresh confirmation session: a short-lived, browser-only cookie, a single-use security code, and a single-use order key, all issued together and all thrown away the moment the page reloads or the checkout is used. The final submission has to carry that exact security code and that exact order key, not any value a caller invents or copies from somewhere else, and the server checks that the request came from Robodepo's own origin rather than a copy of the page hosted elsewhere. The page itself refuses to load inside a frame, so it cannot be embedded invisibly and clicked by accident. Every one of those checks runs on the server, every time, regardless of what a tool or an agent claims about what a person did.

That is the whole boundary. An agent can prepare everything up to the door. It cannot open it.

## Why the checkout is trustworthy

Trust here is not a claim, it is a set of engineering decisions.

One shared purchase system serves the website and the agent tools, so there is no second, less-tested code path for machines. Every mutation is idempotent, so a retried tool call, the kind of thing an agent does automatically after a slow response, cannot accidentally duplicate an order. Every product listing discloses the source retailer, source price and Robodepo's own displayed price, side by side, rather than hiding the difference.

Behind the visible page is an evaluation setup built to hold the whole system to account. Real agents run through the store under sealed conditions: premium price levels are committed cryptographically before a run starts, so no one, including the people who built this, can see a result and adjust the test afterwards. Every purchase record produced by that rig gets an independent LLM audit. The protocol itself is versioned, so a later rule change never quietly applies to old results. A price-integrity check voids any run where the shown price differs from the charged price. That rig has been through ten adversarial review passes, each trying to find a way the evidence could be wrong.

Putting WebMCP in front of an API is easy. Proving the checkout works for agents is the work.

## How this is different from what exists

What exists today splits into two camps. One camp is merchant-side tooling: Shopify's WebMCP and UCP integration, Google's UCP, Microsoft's Copilot Checkout, Perplexity's merchant program, Firmly's no-code connector. Each asks the store to do something first: install WebMCP-capable Liquid, connect a Merchant Center account, join a program, or run an onboarding flow. A store that has never heard of agentic commerce is invisible to all of them. The other camp is buyer-side proxying: Amazon's Buy for Me, Rye and Zinc. No merchant cooperation needed, because they automate the store's ordinary human checkout using the shopper's own saved details, which works as long as the target site's checkout form doesn't change.

Robodepo sits outside both camps, behaving like the proxies in one respect and the merchant tooling in another, without either dependency:

- The shop does nothing. Robodepo lists disclosed-source products and runs the whole purchase on the shop's behalf, so a store that never installed WebMCP, never joined a merchant program and never heard the word agent is still agent-completable through Robodepo.
- The agent gets information it cannot get elsewhere in one place: source retailer and price disclosed side by side; evidence from manuals, reviews and permitted transcripts is on the roadmap; a shortlist built for each request is on the roadmap.
- The human keeps the irreversible step by construction, not by policy: no tool call can place an order, only a person on Robodepo's own confirmation page can.
- Completion is measured, not claimed. A sealed evaluation rig runs real agents through the real purchase path and audits the results, so "it works for agents" is a checked result, not a claim.
- Nothing to install, for the agent, the human or the shop: WebMCP tools sit on the page, and underneath is plain HTTPS any agent can call.
- The tool names, `search_catalog`, `get_product`, `create_checkout`, `cancel_checkout`, `get_order`, match the dialect UCP, Shopify and ACP have already converged on.

The nearest things are protocols that ask every shop to integrate, or agents that scrape. Robodepo is the store that already did the work.

| Name | Side | Who does the work | Completes checkout for the agent? | Source | Date checked |
|---|---|---|---|---|---|
| Shopify WebMCP / Catalog MCP | Merchant tooling | Shopify, auto-on | Yes, in-page | shopify.dev/docs/api/web-mcp | 03-Sep-2026 |
| Google UCP | Protocol/platform | Merchant integrates | Yes, on Google's surfaces | developers.googleblog.com/.../ucp | 03-Sep-2026 |
| OpenAI/Stripe ACP + ChatGPT | Protocol/platform | Merchant builds a ChatGPT App | No, discovery only; Instant Checkout suspended Mar-2026 | digitalcommerce360.com | 03-Sep-2026 |
| Microsoft Copilot Checkout | Platform | Merchant integrates via PayPal/Shopify/Stripe | Yes, in Copilot chat | news.microsoft.com | 03-Sep-2026 |
| Perplexity Buy with Pro | Platform | Merchant joins the program | Yes, in Perplexity | novadata.io | 03-Sep-2026 |
| Amazon Buy for Me | Buyer-side proxy | Nothing required of the brand | Yes, Amazon automates it | aboutamazon.com | 03-Sep-2026 |
| Visa Intelligent Commerce / Mastercard Agent Pay | Payment rail | Issuer, processor and agent support tokenized credentials | No, authorizes payment elsewhere | digitalcommerce360.com | 03-Sep-2026 |
| Firmly Connect | Merchant onboarding | Merchant does a no-code setup | Enables it; the agent channel completes it | digitalcommerce360.com | 03-Sep-2026 |
| Nekuda / Skyfire / PayOS / Crossmint | Payment/identity infra | Developer and payment network integrate | No, infrastructure only | useproxy.ai | 03-Sep-2026 |
| Rye / Zinc | Buyer-side execution API | Nobody at the store; Rye/Zinc automate it | Yes, by proxying human checkout | rye.com/blog/agentic-commerce-startups | 03-Sep-2026 |

## The tool design

Every tool follows the same shape on purpose, so an agent that has seen one of them can guess the rest.

Each tool's own registered description is kept short, sized to fit Chrome's WebMCP guidance for what a browser will show. The full depth, parameter notes, every output field, how to recover from every error, worked examples, lives separately at `/agent/tools.json`, pullable on demand with `get_tool_guide`.

Every response carries the same envelope: a `status` that moves through a small, explicit set of states, a `messages` array explaining anything unusual in plain language, and a `next_actions` list computed from the current state, not hard-coded per tool, so the suggestion always matches what is actually possible right now. Input schemas are strict: no undeclared fields, every property described. Every tool carries explicit annotations for whether it only reads data, whether it changes anything, whether it is safe to retry, and whether its output could carry untrusted third-party text, so a host browser can apply its own policy.

The tool names themselves follow a `verb_noun` pattern deliberately aligned with the names Google's UCP, Shopify's own storefront tools, and OpenAI and Stripe's ACP have already converged on.

## Where this is going

The roadmap groups around what actually helps an agent buy well. Four items below already exist as preview tools in the live catalogue, honestly labelled, returning `status: "not_available"`, and never called for real work today; one is a roadmap option on a tool that already works.

- **Search by need**, a short, checkout-ready shortlist built for the request instead of a person or an agent trawling thousands of irrelevant pages (`search_by_activity`).
- **The best source of product truth**, specifications, manuals, review themes and permitted YouTube transcript evidence, cited and kept fresh rather than copied from marketing pages, coming to the working `get_product` tool as an `include_evidence` option.
- **Side by side comparison**, across products a person or an agent is weighing up (`compare_products`).
- **One tool to transact across many merchants**, the same prepare-then-approve path working beyond Robodepo's own catalogue (`get_shipping_options`, and the delegated-checkout direction behind it).
- **Continued assistance**, replenishment reminders and price alerts for the things people buy again (`subscribe_replenishment_alerts`).

## Before and for the challenge

Before the challenge existed, the Robodepo store, its purchase API and its human confirmation page were already real and working. Nothing about that prior work changed for this submission. Everything at `/agent` is new: the WebMCP tool catalogue described above, the one-call `create_checkout` tool, the approval page and its WebAuthn presence check, the feedback endpoint, the full test suite covering every tool's schema and response shape, and the public repository this story is copied into.

## Links

- Live page: https://robodepo.shop/agent
- Full tool catalogue, machine-readable: https://robodepo.shop/agent/tools.json
- Trust manifest: https://robodepo.shop/trust-manifest.json
- Public repository: https://github.com/Web3Zero/robodepo-webmcp
