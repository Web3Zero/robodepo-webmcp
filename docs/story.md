# Robodepo (a working name)

The full story of what Robodepo is, what actually works today, and why the checkout can be trusted. Written for anyone reviewing the project, human or agent.

## The problem

Agents cannot reliably complete checkout. Send a shopping agent onto the open web today and it will search, compare, and sometimes even get as far as filling in a cart. Then it stalls. Pages are built for human eyes and human hands: forms with hidden assumptions, checkout flows with steps a person fills in without thinking and an agent has to guess at. The result is an agent that can do almost everything except the one thing that actually matters: finish the purchase.

Robodepo was built to close that specific gap. Not a better search engine, not a better catalogue on its own, but a store where an agent can go from a plain-English request to a prepared order, with a person confirming the one step that should never be automated.

## What Robodepo is

Robodepo is a store built for agents from the ground up: the same purchase system serves the website and the tools, so a person and an agent see the same product facts and go through the same checkout logic.

It is being built as the mall for agents: the destination is billions of products from millions of stores, reachable through one consistent set of tools rather than a different scraped page for every retailer. That is the destination, not a claim about today's catalogue. What exists right now is one demo product, run all the way through the real purchase path, deliberately, so that path can be measured and trusted before the catalogue grows. Get the till right first. The mall comes after.

## What works today at /agent

Open `/agent` in a WebMCP-aware browser and it registers a catalogue of tools directly with the page. No install, no separate agent setup, nothing to configure. Eight of those tools are fully working end to end today:

- **`search_catalog`** finds products in the demo catalogue and is honest that relevance judgement is the agent's own call, not a keyword filter pretending to be one.
- **`get_product`** returns full product detail, including the source retailer and both the source price and Robodepo's own price, side by side.
- **`create_checkout`** is the hero. One call runs the whole pre-purchase path that used to take several separate steps: cart, address, delivery quote, and a priced, time-limited mandate ready for a person to review.
- **`cancel_checkout`** records an explicit decline, so a correct refusal becomes a recorded outcome rather than something inferred later from silence.
- **`get_order`** reads a placed order straight back once a person has approved it.
- **`get_trust_manifest`** returns the store's public trust manifest.
- **`submit_feedback`** lets an agent leave structured feedback at any point, whether the purchase went through or the agent walked away from it. It is stored as data, never as instructions.
- **`get_tool_guide`** pulls the complete guide for any tool on demand: full description, parameter notes, outputs, error recovery, and worked examples.

After `create_checkout`, the agent hands the person a link to Robodepo's own approval page. That page shows the item, the delivery region and the total, nothing more, and asks for one confirmation. Where the browser offers it, that confirmation can be a WebAuthn presence check, the same kind of gesture as unlocking a phone with a fingerprint or a face. It is not a payment authorisation and it never touches the server directly; it just proves a person is at the device before the same form the plain button would submit gets submitted. Devices without a platform authenticator simply see the plain button, and it works exactly the same way.

Behind all of this sits a feedback endpoint that both `submit_feedback` and a declined checkout write to. Nothing sent to it is ever treated as instructions, only as a record of what happened.

## How the human boundary is enforced

The rule that matters most in this whole design is simple to state and deliberately hard to get around: no tool can place an order. Only a person, on Robodepo's own approval page, in a real browser tab, can do that.

The mechanics behind that rule come straight from the purchase contract. Opening the confirmation page requires the run cookie that owns that specific checkout, so a stranger who somehow learned a mandate's id still could not open it. Loading the page mints a fresh confirmation session: a short-lived, browser-only cookie, a single-use security code, and a single-use order key, all issued together and all thrown away the moment the page reloads or the checkout is used. The final submission has to carry that exact security code and that exact order key, not any value a caller invents or copies from somewhere else, and the server checks that the request came from Robodepo's own origin rather than a copy of the page hosted elsewhere. The page itself refuses to load inside a frame, so it cannot be embedded invisibly and clicked by accident. Every one of those checks runs on the server, every time, regardless of what a tool or an agent claims about what a person did.

That is the whole boundary. An agent can prepare everything up to the door. It cannot open it.

## Why the checkout is trustworthy

Trust here is not a claim, it is a set of specific engineering decisions.

One shared purchase system serves the website and the agent tools, so there is no second, less-tested code path for machines. Every mutation in that system is idempotent, so a retried tool call, the kind of thing an agent does automatically after a slow response, cannot accidentally duplicate an order. Every product listing discloses the source retailer, the source price and Robodepo's own displayed price, side by side, rather than hiding the difference.

Behind the visible page is an evaluation setup built to hold the whole system to account. Real agents can be run through the store under sealed conditions: premium price levels are committed cryptographically before a run starts, so no one, including the people who built this, can see a result and adjust the test afterwards. Every purchase record produced by that rig gets an independent LLM audit. The protocol itself is versioned, so a later rule change never quietly applies to old results. A price-integrity check voids any run where the price shown to the agent differs from the price actually charged. That whole rig has been through ten adversarial review passes, each one trying to find a way the evidence could be wrong before anyone would trust it.

Putting WebMCP in front of an API is easy. Proving the checkout works for agents is the work.

## The tool design

Every tool follows the same shape on purpose, so an agent that has seen one of them can guess the rest.

Each tool's own registered description is kept short, sized to fit Chrome's WebMCP guidance for what a browser will actually show. The full depth, parameter notes, every output field, how to recover from every error, worked examples, lives separately as a machine-readable catalogue at `/agent/tools.json`, and any agent can pull it on demand with `get_tool_guide` rather than every tool description having to carry that weight itself.

Every response carries the same envelope: a `status` that moves through a small, explicit set of states, a `messages` array that explains anything unusual in plain language, and a `next_actions` list computed from the current state rather than hard-coded per tool, so the suggestion an agent gets always matches what is actually possible right now. Input schemas are strict: no undeclared fields, every property described, nothing left to guesswork. Every tool carries explicit annotations for whether it only reads data, whether it changes anything, whether it is safe to retry, and whether its output could contain untrusted third-party text, so a host browser can apply its own policy on top.

The tool names themselves follow a `verb_noun` pattern deliberately aligned with the names Google's Universal Commerce Protocol, Shopify's own storefront tools, and OpenAI and Stripe's Agentic Commerce Protocol have already converged on. An agent that already knows one of those speaks Robodepo's dialect without having to learn a new vocabulary.

## Where this is going

The roadmap groups around what actually helps an agent buy well, not around a longer feature list for its own sake. Every item below already exists as a preview tool in the live catalogue: honestly labelled, returning a plain `status: "not_available"` response, and never called for real work today.

- **The best source of product truth**, specs, manuals, review themes and permitted YouTube transcript evidence, cited and kept fresh rather than copied from marketing pages (`get_evidence_pack`, `compare_products`).
- **A custom store per request**, a storefront assembled around what one visiting agent actually asked for (`create_custom_store`).
- **Search by need**, finding a product by the job it has to do rather than matching words in a listing title (`search_by_activity`).
- **A universal transaction layer**, the same prepare-then-approve path working across many merchants, not only Robodepo's own catalogue (`get_shipping_options`, and the delegated-checkout direction behind it).
- **Continued assistance**, replenishment reminders and price alerts for the things people buy again (`subscribe_replenishment_alerts`).

## Before and for the challenge

Before the challenge existed, the Robodepo store, its purchase API and its human confirmation page were already real and working. Nothing about that prior work changed for this submission. Everything at `/agent` is new: the WebMCP tool catalogue described above, the one-call `create_checkout` tool, the approval page and its WebAuthn presence check, the feedback endpoint, the full test suite covering every tool's schema and response shape, and the public repository this story is copied into.

## Links

- Live page: https://robodepo.shop/agent
- Full tool catalogue, machine-readable: https://robodepo.shop/agent/tools.json
- Trust manifest: https://robodepo.shop/trust-manifest.json
- Public repository: https://github.com/Web3Zero/robodepo-webmcp
