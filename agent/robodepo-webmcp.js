/**
 * Robodepo (working name) WebMCP tools — MIT
 *
 * A browser-side WebMCP tool layer over Robodepo's frozen public v1 purchase
 * API. Plain ES2022, no imports, no build step, so this file can be mirrored
 * verbatim into a public MIT repository.
 *
 * Design rules this file obeys:
 *   - Same origin only. Every request is a relative URL sent with
 *     `credentials: "same-origin"` so the `__Host-robodepo_run` cookie
 *     (Secure, HttpOnly, SameSite=Strict) travels with it.
 *   - The one irreversible step stays human. There is no `complete_checkout`
 *     tool; the agent hands the person an approval link and stops. That link
 *     is Robodepo's own `/approve/{mandate_id}` page, which shows the item and
 *     total and takes one biometric touch where the device supports it, and a
 *     plain button where it does not. The gesture is checked by the browser;
 *     the server's own confirmation checks are unchanged and are what actually
 *     authorise the purchase. `/confirm/{mandate_id}` remains available and is
 *     returned alongside as `confirmation_page`.
 *   - Every tool answers with the same envelope: `status`, `resource`,
 *     `messages[]`, `next_actions[]`, `links[]`, `instructions`.
 *   - `next_actions` are computed from the page session's state, never
 *     hard-coded per tool, and are never empty on an error.
 *   - No envelope ever carries a cookie value, a CSRF value or a Stripe
 *     object, and none ever carries a person's address. The only address that
 *     appears anywhere is the published sandbox literal, and only inside a
 *     `next_actions[].args_hint` prefill: it is a non-personal contract value,
 *     and prefilling it removes the one failure mode an agent cannot reason
 *     its way out of. In a `resource`, the delivery region (`WA 6019`) is the
 *     most location detail that leaves this file.
 *   - Nothing unbuilt is advertised as built. A preview tool says so in its
 *     first words and returns `status: "not_available"`.
 *
 * Node/vitest safe: every browser global is reached through a small guarded
 * function, and registration only runs when `window` exists.
 */

/* ------------------------------------------------------------------------ *
 * Frozen facts. Every value here is published by the Robodepo v1 contract
 * (`GET /api/v1`, `GET /api/v1/products/{id}`, `GET /trust-manifest.json`).
 * ------------------------------------------------------------------------ */

/** The only product in the demo catalogue. */
export const PRODUCT_ID = "holiday-bucket-beige-canvas-l-xl-beige";

/** Title and variant are frozen fields of the published product response. */
export const PRODUCT_TITLE = "Holiday Bucket - Beige Canvas";
export const PRODUCT_VARIANT = "L-XL / Beige";
export const SOURCE_RETAILER = "Lack of Color";

/** The only currency. All amounts are integer cents. */
export const CURRENCY = "AUD";

/** The only supported quantity in the tracer. */
export const SUPPORTED_QUANTITY = 1;

/** Deterministic standard sandbox shipping, in cents. */
export const SANDBOX_SHIPPING_CENTS = 1200;

/** A mandate (checkout) expires this long after it is created. */
export const CHECKOUT_LIFETIME_MINUTES = 15;

/**
 * The only address the store accepts. Exact-object match, field for field.
 * This is published in the contract, so checking it here is format validation
 * against a literal, not a judgement — the allowed deterministic exception.
 */
export const ACCEPTED_ADDRESS = Object.freeze({
  recipient_name: "Sandbox Buyer",
  line1: "10 Example Street",
  line2: null,
  suburb: "Wembley Downs",
  state: "WA",
  postcode: "6019",
  country: "AU",
});

const ACCEPTED_ADDRESS_SENTENCE =
  'recipient_name "Sandbox Buyer", line1 "10 Example Street", line2 null, ' +
  'suburb "Wembley Downs", state "WA", postcode "6019", country "AU"';

const ADDRESS_FIELDS = [
  "recipient_name",
  "line1",
  "line2",
  "suburb",
  "state",
  "postcode",
  "country",
];

const FEEDBACK_PATH = "/api/agent/feedback";
const TRUST_MANIFEST_PATH = "/trust-manifest.json";
const IDEMPOTENCY_KEY_MIN = 16;
const IDEMPOTENCY_KEY_MAX = 128;
/** Longest step suffix is `-shipping` (9 characters). */
const IDEMPOTENCY_BASE_MAX = IDEMPOTENCY_KEY_MAX - 9;

/* ------------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------------ */

/** Format integer AUD cents the way the page and the agent both read it. */
export function formatAud(cents) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) {
    return null;
  }
  return `A$${(cents / 100).toFixed(2)}`;
}

/** Every envelope passes through here, so every envelope has the same shape. */
export function buildEnvelope({
  status,
  resource = null,
  messages = [],
  next_actions = [],
  links = [],
  instructions = null,
}) {
  return {
    status,
    resource,
    messages: Array.isArray(messages) ? messages : [],
    next_actions: Array.isArray(next_actions) ? next_actions : [],
    links: Array.isArray(links) ? links : [],
    instructions:
      instructions === null
        ? { for_human: null, for_agent: null }
        : {
            for_human: instructions.for_human ?? null,
            for_agent: instructions.for_agent ?? null,
          },
  };
}

function message(type, code, severity, path, content) {
  return { type, code, severity, path: path ?? null, content };
}

/**
 * `concise` is the default — including when the property is null or absent —
 * so an agent's context is not spent on a source block it did not ask for.
 * The disclosure is never dropped by concise, only shortened, so the safe
 * default and the small default are the same thing here.
 */
export function wantsDetail(input) {
  return input?.response_format === "detailed";
}

/**
 * The source disclosure, at the requested depth. `detailed` returns the whole
 * published `source` block; `concise` shortens it to the retailer's name and
 * the price-may-differ flag. Neither drops the disclosure.
 */
export function sourceDisclosure(source, detailed) {
  if (detailed) {
    return {
      source: {
        retailer: source?.retailer ?? null,
        url: source?.url ?? null,
        price_may_differ: source?.price_may_differ ?? true,
        last_checked_at: source?.last_checked_at ?? null,
      },
    };
  }
  return {
    source_retailer: source?.retailer ?? null,
    price_may_differ: source?.price_may_differ ?? true,
  };
}

/**
 * The approval page for a mandate, on the same origin the store issued its
 * confirmation link on. `/approve/{id}` wraps `/confirm/{id}`: same form, same
 * server checks, plus a browser-checked biometric gesture in front of them.
 */
export function approvalUrlFor(confirmationUrl, mandateId, origin) {
  const path = `/approve/${encodeURIComponent(mandateId)}`;
  if (typeof confirmationUrl === "string" && confirmationUrl.length > 0) {
    try {
      return `${new URL(confirmationUrl).origin}${path}`;
    } catch {
      // A relative confirmation url; fall through to the caller's origin.
    }
  }
  return `${origin}${path}`;
}

/** The operational tool a preview's own catalogue entry sends callers to. */
export function previewRecovery(name) {
  return TOOLS.find((tool) => tool.name === name)?.recover ?? null;
}

function isPrintableAscii(value) {
  if (typeof value !== "string") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point < 0x20 || point > 0x7e) {
      return false;
    }
  }
  return true;
}

/** Collapse a value to null when it is an empty string, so `line2` compares. */
function normaliseAddressValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Exact-object comparison against the published sandbox address. Deterministic
 * on purpose: the contract fixes this literal, so an agent gets told the exact
 * accepted value instead of guessing after a server rejection.
 */
export function checkShippingAddress(address) {
  if (address === null || typeof address !== "object" || Array.isArray(address)) {
    return { ok: false, reason: "missing" };
  }
  const extra = Object.keys(address).filter((key) => !ADDRESS_FIELDS.includes(key));
  if (extra.length > 0) {
    return { ok: false, reason: "unknown_field" };
  }
  for (const field of ADDRESS_FIELDS) {
    if (normaliseAddressValue(address[field]) !== ACCEPTED_ADDRESS[field]) {
      return { ok: false, reason: "mismatch" };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------------ *
 * v1 error code mapping. `self` means "retry the tool that just failed".
 * ------------------------------------------------------------------------ */

const API_ERROR_MAP = {
  INVALID_REQUEST: {
    code: "invalid_request",
    severity: "requires_buyer_input",
    content:
      "The store rejected a field in this request. Correct the field named in this message and call the same tool again.",
    recover: ["self"],
  },
  RUN_AUTH_REQUIRED: {
    code: "run_authority_missing",
    severity: "recoverable",
    content:
      "This browser is not carrying the run authority that owns the checkout. The run cookie belongs to this browser and lives 24 hours; start a fresh checkout, which issues a new one.",
    recover: ["create_checkout"],
  },
  NOT_FOUND: {
    code: "not_found",
    severity: "recoverable",
    content:
      "That identifier is absent or belongs to another browser's run. get_order can only read an order created in this browser; otherwise start again from the catalogue.",
    recover: ["search_catalog"],
  },
  PRODUCT_NOT_FOUND: {
    code: "product_not_found",
    severity: "recoverable",
    content: "That product id is not in this catalogue.",
    recover: ["search_catalog"],
  },
  INVALID_STATE: {
    code: "checkout_expired_or_invalid_state",
    severity: "recoverable",
    content:
      "That step is not allowed from the checkout's current state, or the checkout has expired. A checkout lives 15 minutes; create a new one.",
    recover: ["create_checkout"],
  },
  IDEMPOTENCY_CONFLICT: {
    code: "idempotency_conflict",
    severity: "recoverable",
    content:
      "That idempotency key is already bound to a different request. Retry with a new idempotency_key, or leave it null and the tool will generate one.",
    recover: ["self"],
  },
  IDEMPOTENCY_SCOPE_CONFLICT: {
    code: "idempotency_conflict",
    severity: "recoverable",
    content:
      "That idempotency key belongs to another run. Retry with a new idempotency_key, or leave it null and the tool will generate one.",
    recover: ["self"],
  },
  PRODUCT_UNAVAILABLE: {
    code: "out_of_stock",
    severity: "requires_buyer_review",
    content:
      "The source retailer's variant is unavailable, so this purchase cannot proceed. Tell the person, then look at the catalogue again.",
    recover: ["search_catalog"],
  },
  QUOTE_STALE: {
    code: "quote_expired",
    severity: "recoverable",
    content:
      "The shipping quote no longer matches the cart or has expired. Create a fresh checkout, which quotes shipping again.",
    recover: ["create_checkout"],
  },
  REQUEST_TOO_LARGE: {
    code: "request_too_large",
    severity: "requires_buyer_input",
    content: "The request body exceeded the published limit. Shorten the input and call the same tool again.",
    recover: ["self"],
  },
  RATE_LIMITED: {
    code: "rate_limited",
    severity: "recoverable",
    content:
      "A published abuse threshold was reached. Wait 60 seconds, then retry; cart creation is limited to 10 per hour per address.",
    recover: ["self"],
  },
  PRODUCT_STALE: {
    code: "price_not_fresh",
    severity: "recoverable",
    content:
      "No fresh validated source snapshot exists, so the store refuses to quote a price it cannot stand behind. Retry in a minute.",
    recover: ["self"],
  },
  PAYMENT_UNAVAILABLE: {
    code: "payment_unavailable",
    severity: "unrecoverable",
    content:
      "The sandbox test payment did not safely succeed and no order exists. This is not something a retry fixes; report it.",
    recover: ["submit_feedback"],
  },
  SERVICE_UNAVAILABLE: {
    code: "service_unavailable",
    severity: "recoverable",
    content: "The store closed this path safely rather than guess. Retry later.",
    recover: ["self"],
  },
  CSRF_REJECTED: {
    code: "confirmation_authority_rejected",
    severity: "requires_buyer_review",
    content:
      "The store rejected a confirmation attempt. Only the person can confirm, on Robodepo's own confirmation page; the agent must not submit that form.",
    recover: ["create_checkout"],
  },
};

/**
 * Per-tool overrides of the shared map. `get_order` needs them because a lost
 * or absent run authority is genuinely unrecoverable for an existing order: a
 * new checkout issues a new run rather than reaching back into the old one, so
 * offering `create_checkout` first would send an agent round a loop that
 * cannot succeed. The description says so and this makes the envelope agree.
 */
const TOOL_ERROR_OVERRIDES = {
  get_order: {
    RUN_AUTH_REQUIRED: {
      code: "run_authority_missing",
      severity: "unrecoverable",
      content:
        "This browser no longer carries the run authority that owns the order. A new checkout issues a new run and cannot reach an order created under the old one, so no retry gets there. Report it.",
      recover: ["submit_feedback", "search_catalog"],
    },
    NOT_FOUND: {
      code: "not_found",
      severity: "recoverable",
      content:
        "No order with that id exists in this browser's run. An order is readable only from the browser whose run created it, so creating another checkout will not surface it. Report it if the person did confirm, then start again from the catalogue.",
      recover: ["submit_feedback", "search_catalog"],
    },
  },
};

const NETWORK_ERROR = {
  code: "network_error",
  severity: "recoverable",
  content:
    "The request did not reach the store, so nothing changed. Retry the same tool; the idempotency key makes a repeat safe.",
  recover: ["self"],
};

const UNKNOWN_ERROR = {
  code: "unexpected_store_error",
  severity: "recoverable",
  content: "The store returned an error this tool layer does not recognise. Retry, then report it.",
  recover: ["self", "submit_feedback"],
};

/* ------------------------------------------------------------------------ *
 * Tool catalogue. Names are final; descriptions follow the template in
 * docs/product/agent-tool-catalogue-design.md.
 * ------------------------------------------------------------------------ */

/**
 * Every preview description opens with this, unabridged. It says three things
 * before anything else: this is not built, it exists to describe the roadmap,
 * and it must not be called to do real work.
 */
export const PREVIEW_PREFIX =
  "Preview — not operational in this demo. Describes the roadmap only; " +
  "returns status not_available and must not be called to do real work. ";

const RESPONSE_FORMAT_PROPERTY = {
  type: "string",
  enum: ["concise", "detailed"],
  description:
    "How much to return. `concise` is the default when null: acting fields plus source_retailer and price_may_differ. `detailed` adds the source block.",
};

export const TOOLS = Object.freeze([
  {
    name: "search_catalog",
    title: "Search the Robodepo catalogue",
    kind: "operational",
    description: "Returns the Robodepo demo catalogue as listings with product id, title, availability, the disclosed source retailer and price in AUD integer cents. Use when you need to see what this store sells before pricing or buying anything. Not for one product's full record; use get_product. Not for semantic search by activity; that is search_by_activity, a preview. Full guide: get_tool_guide or /agent/tools.json#search_catalog",
    guide: {
      "summary": "Returns the Robodepo demo catalogue as listings, each with its product id, title, variant, availability, the disclosed source retailer, and the displayed price as AUD integer cents plus a formatted string such as A$113.85.",
      "use_when": "Use this when you want to see what this store actually sells before you price or buy anything.",
      "do_not_use": "Do not use this for the full record of one product; use `get_product` instead. Do not use it for semantic search by activity or function; that is `search_by_activity`, which is a preview and does not work yet.",
      "parameters": "The `query` parameter is recorded and returned to you unchanged. The demo catalogue holds exactly one product, so this tool does not rank, filter or keyword-match anything: deciding whether the returned listing answers the query is your judgement, not the store's. `limit` bounds how many listings come back, and `response_format` chooses how much of the source disclosure travels with each one.",
      "caveats": "It returns no shipping cost, no delivery estimate, no reviews and no evidence pack. It holds no handle, takes no lock and reserves no stock, so calling it twice changes nothing.",
      "outputs": "`resource.catalogue_size` states how many products the demo catalogue holds. Each entry in `resource.listings[]` carries `product_id` (feed it to `get_product`, or to `create_checkout` as `line_items[0].product_id`), `display_price_cents` with `formatted_price`, `available`, `transaction_mode`, and the source disclosure — under `concise` that is `source_retailer` and `price_may_differ`; under `detailed` it is the full `source` object with `retailer`, `url`, `price_may_differ` and `last_checked_at`. `get_product` is where the source retailer's own price is disclosed alongside the displayed price.",
      "error_recovery": "`product_not_found` or `out_of_stock` means the listing is gone, so `listings` comes back empty and the message says why; `price_not_fresh` means no validated source snapshot exists, so retry in a minute; `rate_limited` means the published public-read budget is spent, so wait 60 seconds; `network_error` means the request never reached the store, so call this tool again.",
      "examples": [
        {
          "title": "See the demo catalogue",
          "input": {
            "query": "a sun hat for a boat",
            "limit": 5,
            "response_format": "concise"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300,
          "description": "What the person is looking for, in their own words. Returned to you unchanged; the store does not rank against it."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20,
          "description": "Maximum listings to return. The demo catalogue holds one product, so any value from 1 to 20 returns the same single listing."
        },
        "response_format": RESPONSE_FORMAT_PROPERTY
      },
      "required": [
        "query",
        "limit",
        "response_format"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "get_product",
    title: "Read one product record",
    kind: "operational",
    description: "Returns one product's published record: title, variant, availability, the source retailer's price and Robodepo's displayed price, both in AUD integer cents. Use when you hold a product_id and want the full record and price disclosure. Not for browsing the catalogue; use search_catalog. Not for cited evidence; that is get_evidence_pack, a preview. Full guide: get_tool_guide or /agent/tools.json#get_product",
    guide: {
      "summary": "Returns every published field for one product: title, variant, availability, the source retailer's price and Robodepo's displayed price, both as AUD integer cents, plus a formatted price string such as A$113.85 and the source disclosure.",
      "use_when": "Use this when you hold a `product_id` from `search_catalog` and want the full record, including the price disclosure, before pricing a checkout.",
      "do_not_use": "Do not use this for browsing the whole catalogue; use `search_catalog` instead. Do not use it for cited evidence from manuals, reviews or guides; that is `get_evidence_pack`, which is a preview and does not work yet.",
      "parameters": "`product_id` comes from `search_catalog`. The demo catalogue's only product id is `holiday-bucket-beige-canvas-l-xl-beige`, and any other id is refused rather than guessed at. `response_format` chooses how much of the source disclosure comes back: `concise` for the retailer's name and the price-may-differ flag, `detailed` for the whole `source` block.",
      "caveats": "It returns no shipping cost, no delivery estimate and no stock count. It reads a stored snapshot, holds no handle and places no reservation, so the price it shows can still move before you create a checkout.",
      "outputs": "`resource.product_id` feeds `create_checkout` as `line_items[0].product_id`. `resource.source_price_cents` and `resource.display_price_cents` are both returned: the displayed price sits above the source retailer's price, and Robodepo publishes both rather than hiding the difference. Under `detailed`, `resource.source.retailer`, `resource.source.url` and `resource.source.last_checked_at` say where the item comes from and when it was last read, and `resource.source.price_may_differ` warns that the retailer's own price can move; under `concise` that block is replaced by `resource.source_retailer` and `resource.price_may_differ`, so the disclosure is shortened but never dropped.",
      "error_recovery": "`product_not_found` means that id is not in this catalogue, so call `search_catalog`; `out_of_stock` means the source variant is unavailable, so call `search_catalog` and tell the person; `price_not_fresh` means no validated snapshot exists, so retry in a minute; `rate_limited` means the public-read budget is spent, so wait 60 seconds; `network_error` means the request never left the browser, so call this tool again.",
      "examples": [
        {
          "title": "Read the demo product with the full source block",
          "input": {
            "product_id": "holiday-bucket-beige-canvas-l-xl-beige",
            "response_format": "detailed"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The product id returned by `search_catalog`. The demo catalogue's only value is `holiday-bucket-beige-canvas-l-xl-beige`."
        },
        "response_format": RESPONSE_FORMAT_PROPERTY
      },
      "required": [
        "product_id",
        "response_format"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "create_checkout",
    title: "Price a checkout and prepare the human confirmation",
    kind: "operational",
    description: "Runs the whole pre-purchase path in one call (cart, item, address, shipping quote, mandate) and returns a priced checkout in AUD integer cents plus the link the person opens to approve it. Use when the person has chosen the product and you are ready to show a final delivered price. Not for placing the order; no tool can, the person approves on Robodepo's own page. Full guide: get_tool_guide or /agent/tools.json#create_checkout",
    guide: {
      "summary": "Runs the entire pre-purchase path in one call — cart, item, address, shipping quote and purchase mandate — and returns a priced checkout in AUD integer cents with a `confirmation_url` the person opens to place the sandbox order.",
      "use_when": "Use this when the person has chosen the product and you are ready to show them a final delivered price to approve.",
      "do_not_use": "Do not use this for placing the order; there is no tool that places it, because the one irreversible step belongs to the person on Robodepo's own pages. Do not use it to read an order afterwards; use `get_order` instead, and use `cancel_checkout` if the person declines.",
      "parameters": "`line_items[0].product_id` comes from `search_catalog` or `get_product`, and `quantity` must be 1 because the tracer supports no other quantity. `shipping_address` must be the published sandbox address exactly — recipient_name \"Sandbox Buyer\", line1 \"10 Example Street\", line2 null, suburb \"Wembley Downs\", state \"WA\", postcode \"6019\", country \"AU\" — and any other address is refused here, before any request is sent, with the accepted value named in the message. `budget_ceiling_cents` is the person's stated ceiling: exceeding it does not block the checkout, it adds a `budget_exceeded` warning for the person to review. `idempotency_key` may be null, in which case the tool generates one; supplied keys must be 16 to 128 printable ASCII characters and are suffixed per step so a repeat is safe.",
      "caveats": "It returns no payment details, no Stripe object, no cookie value and no full address — only the delivery region, such as WA 6019. The checkout expires 15 minutes after it is created and cannot be confirmed after that; the run authority that owns it is a browser cookie that lives 24 hours and follows the most recent checkout, so a checkout created in one browser cannot be confirmed or read in another. Shipping is the flat A$12.00 standard sandbox rate. The order is a Stripe test-mode payment: nothing is charged, no retailer order is placed and nothing is shipped.",
      "outputs": "`resource.checkout_id` feeds `cancel_checkout` and `get_order`. `resource.confirmation_url` is the link to hand the person: Robodepo's approval page, which shows the item, variant, delivery region and total and takes one biometric touch — a fingerprint, face unlock or device passkey prompt — where the browser has one, and a plain single button where it does not. That gesture is checked by the browser and never reaches Robodepo; it adds no server-side authority, and the server still verifies the same run cookie, confirmation cookie, single-use CSRF value, server-issued single-use idempotency key, same-origin submission and five-minute session it always has. No tool can submit either page. `links[]` carries that link as `approval_page` and the plain confirmation page as `confirmation_page`, for a person who would rather use the button alone. `resource.totals` carries `items_cents`, `shipping_cents`, `total_cents`, `currency` and `formatted_total`; `resource.expires_at` is when the checkout dies; `resource.delivery_region`, `resource.source_retailer` and `resource.price_may_differ` are the disclosures to relay. `instructions.for_human` is ready-made wording to pass on and `instructions.for_agent` is your own next step.",
      "error_recovery": "`invalid_request` names the field to fix, then call this tool again; `run_authority_missing` means this browser lost its run cookie, so call this tool again to get a new one; `checkout_expired_or_invalid_state` means the 15 minutes ran out, so call this tool again; `quote_expired` means the shipping quote went stale, so call this tool again; `out_of_stock` means the source variant went unavailable, so tell the person and call `search_catalog`; `idempotency_conflict` means the key is already bound elsewhere, so retry with a new `idempotency_key` or null; `rate_limited` means the cart budget of 10 per hour is spent, so wait 60 seconds; `price_not_fresh` means no validated snapshot exists, so retry in a minute; `payment_unavailable` cannot be retried into a success, so call `submit_feedback`; `network_error` means the step never reached the store, so call this tool again. Every error names the step that failed.",
      "examples": [
        {
          "title": "Price the one buyable order",
          "input": {
            "line_items": [
              {
                "product_id": "holiday-bucket-beige-canvas-l-xl-beige",
                "quantity": 1
              }
            ],
            "shipping_address": {
              "recipient_name": "Sandbox Buyer",
              "line1": "10 Example Street",
              "line2": null,
              "suburb": "Wembley Downs",
              "state": "WA",
              "postcode": "6019",
              "country": "AU"
            },
            "budget_ceiling_cents": null,
            "idempotency_key": null
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": false,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "line_items": {
          "type": "array",
          "minItems": 1,
          "maxItems": 1,
          "description": "Exactly one line item. The tracer supports a single product at quantity 1 and refuses anything else.",
          "items": {
            "type": "object",
            "properties": {
              "product_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200,
                "description": "The product id from `search_catalog` or `get_product`. The demo catalogue's only value is `holiday-bucket-beige-canvas-l-xl-beige`."
              },
              "quantity": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1,
                "description": "Must be 1. The tracer supports no other quantity."
              }
            },
            "required": [
              "product_id",
              "quantity"
            ],
            "additionalProperties": false
          }
        },
        "shipping_address": {
          "type": "object",
          "description": "Must equal the published sandbox address exactly, field for field. No real address is ever accepted here.",
          "properties": {
            "recipient_name": {
              "type": "string",
              "description": "The accepted sandbox value is \"Sandbox Buyer\"."
            },
            "line1": {
              "type": "string",
              "description": "The accepted sandbox value is \"10 Example Street\"."
            },
            "line2": {
              "type": [
                "string",
                "null"
              ],
              "description": "The accepted sandbox value is null."
            },
            "suburb": {
              "type": "string",
              "description": "The accepted sandbox value is \"Wembley Downs\"."
            },
            "state": {
              "type": "string",
              "description": "The accepted sandbox value is \"WA\"."
            },
            "postcode": {
              "type": "string",
              "description": "The accepted sandbox value is \"6019\"."
            },
            "country": {
              "type": "string",
              "description": "The accepted sandbox value is \"AU\"."
            }
          },
          "required": [
            "recipient_name",
            "line1",
            "line2",
            "suburb",
            "state",
            "postcode",
            "country"
          ],
          "additionalProperties": false
        },
        "budget_ceiling_cents": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "description": "The person's ceiling in AUD integer cents, or null. Exceeding it adds a budget_exceeded warning to review; it does not block the checkout."
        },
        "idempotency_key": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 16,
          "maxLength": 128,
          "description": "16 to 128 printable ASCII characters, or null to have the tool generate one. Each internal step gets its own suffixed key, so a repeat is safe."
        }
      },
      "required": [
        "line_items",
        "shipping_address",
        "budget_ceiling_cents",
        "idempotency_key"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "cancel_checkout",
    title: "Decline a prepared checkout on the record",
    kind: "operational",
    description: "Closes a checkout prepared in this browser and records the decline, returning status canceled. Use when the person declines, so a refusal is a recorded outcome rather than an inferred one. Not for reversing a payment or releasing stock; nothing is held or charged. Not for after approval; use get_order. Full guide: get_tool_guide or /agent/tools.json#cancel_checkout",
    guide: {
      "summary": "Marks a checkout prepared in this browser as declined, records the decline with Robodepo, and returns `status: \"canceled\"` so a correct refusal is a recorded outcome rather than something inferred from silence.",
      "use_when": "Use this when the person decides not to buy, or when you decide the checkout should not proceed — a price above their ceiling, a wrong item, a change of mind.",
      "do_not_use": "Do not use this for releasing stock or reversing a payment; nothing is held and nothing is charged. Do not use it after the person has confirmed; at that point call `get_order` instead, and use `submit_feedback` to say what went wrong.",
      "parameters": "`checkout_id` is the value `create_checkout` returned. `reason` is optional free text of up to 300 characters and should carry no personal data.",
      "caveats": "Told plainly: the v1 API has no server-side cancel route, so this tool does not call one. The sandbox mandate simply expires within 15 minutes of creation and cannot be confirmed from this page afterwards. What this tool really does is close the checkout in this page's own registry so the tools stop offering it, and record the decline so the outcome is explicit. It changes nothing on the server and is safe to call more than once.",
      "outputs": "`resource.checkout_id` and `resource.state` confirm which checkout was closed, and `resource.declined_at` is when. `resource.feedback_recorded` says whether the decline reached the feedback endpoint; when it did not, a warning explains and the cancel still stands. `next_actions` will point you back at `search_catalog` and `submit_feedback`.",
      "error_recovery": "`not_found` means this browser never prepared that checkout — checkouts are per-browser and per-page — so call `create_checkout` to make one; `network_error` means the decline record did not reach the store, which is reported as a warning rather than a failure, because the cancel itself is local and already done.",
      "examples": [
        {
          "title": "Decline on the record",
          "input": {
            "checkout_id": "the checkout_id create_checkout returned",
            "reason": "Above the person's ceiling"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": false,
      "untrustedContentHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "checkout_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The `checkout_id` returned by `create_checkout` in this browser."
        },
        "reason": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 300,
          "description": "Why the checkout was declined, or null. Free text up to 300 characters; do not put personal data here."
        }
      },
      "required": [
        "checkout_id",
        "reason"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "get_order",
    title: "Read back a confirmed sandbox order",
    kind: "operational",
    description: "Reads back a confirmed sandbox order: status, item, quantity, delivery region and totals in AUD integer cents. Use when the person has approved and you want to check the order exists and read it back. Pass order_id or checkout_id. Not for confirming the order; no tool can. Not for pricing; use create_checkout. Full guide: get_tool_guide or /agent/tools.json#get_order",
    guide: {
      "summary": "Reads a confirmed sandbox order and returns its status, item, quantity, delivery region and totals in AUD integer cents with a formatted total such as A$125.85.",
      "use_when": "Use this when the person has pressed confirm on Robodepo's confirmation page and you want to check the order really exists and read it back to them.",
      "do_not_use": "Do not use this for confirming the order; no tool can, the person does that themselves, and to price something use `create_checkout` instead.",
      "parameters": "Supply at least one of `order_id` or `checkout_id`; both may not be null. `order_id` comes from the order page the person lands on after confirming, at `/orders/{order_id}`. `checkout_id` comes from `create_checkout`, and when you pass it this tool checks whether the window this page opened has reached an order page — either the approval page or the plain confirmation page redirects there — so you can poll politely while the person decides.",
      "caveats": "It returns no payment details, no Stripe object and no full address — the delivery region, such as WA 6019, is the most it gives. An order can only be read from the browser whose run created it. If the person has not confirmed yet, this is not an error: you get `status: \"awaiting_human_confirmation\"` and the confirmation link to hand them again.",
      "outputs": "`resource.order_id`, `resource.status`, `resource.item` (product_id, title, variant, quantity, unit_price_cents), `resource.shipping_cents`, `resource.total_cents` with `formatted_total`, `resource.delivery_region` and `resource.created_at`. `links[]` carries the human-readable `order_page`. `instructions.for_human` is wording you can read out.",
      "error_recovery": "`not_found` means no order with that id exists in this browser's run, and because an order is readable only from the browser whose run created it, creating another checkout will not surface it — report it with `submit_feedback` if the person did confirm, then start again from `search_catalog`; `run_authority_missing` means this browser lost the run authority that owns the order, and a new checkout issues a new run rather than recovering the old one, so no retry reaches it and `submit_feedback` is the honest next step; `rate_limited` means the run read budget is spent, so wait 60 seconds and call this tool again; `network_error` means the request never reached the store, so call this tool again.",
      "examples": [
        {
          "title": "Poll while the person decides",
          "input": {
            "order_id": null,
            "checkout_id": "the checkout_id create_checkout returned"
          }
        },
        {
          "title": "Read back a confirmed order",
          "input": {
            "order_id": "the id in /orders/{order_id}",
            "checkout_id": null
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "order_id": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 200,
          "description": "The order id from `/orders/{order_id}` after the person confirms, or null to look it up from `checkout_id`."
        },
        "checkout_id": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 200,
          "description": "The `checkout_id` from `create_checkout`, or null when you already hold `order_id`. At least one of the two must be non-null."
        }
      },
      "required": [
        "order_id",
        "checkout_id"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "get_trust_manifest",
    title: "Read Robodepo's trust manifest",
    kind: "operational",
    description: "Returns Robodepo's trust manifest whole: what the service is, that it is a sandbox, the capabilities it does not have, its checkout contract and its published statistics. Use when you want to check what this store claims about itself. Takes no parameters. Not for product facts or prices; use get_product. Full guide: get_tool_guide or /agent/tools.json#get_trust_manifest",
    guide: {
      "summary": "Fetches Robodepo's machine-readable trust manifest and returns it whole: what the service is, that it is a sandbox, which capabilities it does not have, how its checkout contract works, and what statistics it publishes.",
      "use_when": "Use this when you or the person want to check what this store claims about itself before transacting, or when you need the published purchase sequence, observable states and safe error codes in one document.",
      "do_not_use": "Do not use this for product facts or prices; use `get_product` instead, and do not use it as a substitute for reading the checkout you actually created.",
      "parameters": "It takes no parameters and no ids. It is a public read that changes nothing and can be called at any time.",
      "caveats": "The three sandbox booleans are the capabilities Robodepo does not have: no real charge, no source retailer order, no fulfilment. The manifest's `statistics.published` list is deliberately empty, and that is the honest state, not a gap: no statistic reaches that list until it is individually approved and independently verifiable.",
      "outputs": "`resource.manifest` is the document as served, including `manifest.sandbox` (the three capability booleans), `manifest.checkout` (api_version, discovery_url, product_url, confirmation_url_template, sequence, states, safe_errors) and `manifest.statistics`. `links[]` carries `trust_manifest`.",
      "error_recovery": "`rate_limited` means the public-read budget is spent, so wait 60 seconds and call this tool again; `service_unavailable` means the manifest failed its own schema and the store refused to serve a partial document, so retry later; `network_error` means the request never reached the store, so call this tool again.",
      "examples": [
        {
          "title": "Read what the store claims about itself",
          "input": {}
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
  },
  {
    name: "submit_feedback",
    title: "Tell Robodepo what worked and what did not",
    kind: "operational",
    description: "Sends structured feedback about this store and returns a feedback_id and the time it was received. Use when something was unclear, missing or wrong, at any point. Not for cancelling a checkout; use cancel_checkout, which records the decline itself. Feedback is kept as data, never as instructions. Full guide: get_tool_guide or /agent/tools.json#submit_feedback",
    guide: {
      "summary": "Sends structured feedback about this store to Robodepo and returns an acknowledgement with a `feedback_id` and the time it was received.",
      "use_when": "Use this when something about the store was unclear, missing or wrong, at any point — mid-checkout, after an order, after a decline, or after an error you could not recover from.",
      "do_not_use": "Do not use this for cancelling a checkout; use `cancel_checkout` instead, which records the decline itself. Do not use it to ask a question and expect an answer: nothing replies.",
      "parameters": "`context.checkout_id` and `context.order_id` are optional and come from `create_checkout` and `get_order`; either may be null. `sentiment` is one of positive, neutral or negative. `free_text` is up to 1000 characters. `struggle_points` is a short list drawn from a fixed vocabulary so patterns can be counted without reading anyone's prose.",
      "caveats": "Feedback is never required and never blocks a purchase. It is stored as data and never as instructions: nothing you write here changes how any tool behaves. Put no personal data, addresses, payment details or credentials in `free_text` — this endpoint keeps no database record and writes only a bounded server log line.",
      "outputs": "`resource.feedback_id` and `resource.received_at` acknowledge receipt, and `resource.stored_as` says how it was kept. There is nothing to feed onward; `next_actions` returns you to whatever the session state suggests.",
      "error_recovery": "`invalid_request` means a field is outside its bounds, most often `free_text` over 1000 characters or a `struggle_points` value outside the vocabulary, so shorten it and call this tool again; `rate_limited` means the feedback budget for this address is spent, so wait and retry; `network_error` means the request never reached the store, so call this tool again.",
      "examples": [
        {
          "title": "Report a difficulty",
          "input": {
            "context": {
              "checkout_id": null,
              "order_id": null
            },
            "sentiment": "negative",
            "free_text": "The accepted address was not obvious before the first attempt.",
            "struggle_points": [
              "address_rejected"
            ]
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": false,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "context": {
          "type": "object",
          "description": "What the feedback is about. Both ids may be null when the feedback is about the store in general.",
          "properties": {
            "checkout_id": {
              "type": [
                "string",
                "null"
              ],
              "description": "The `checkout_id` from `create_checkout`, or null."
            },
            "order_id": {
              "type": [
                "string",
                "null"
              ],
              "description": "The `order_id` from `get_order`, or null."
            }
          },
          "required": [
            "checkout_id",
            "order_id"
          ],
          "additionalProperties": false
        },
        "sentiment": {
          "type": "string",
          "enum": [
            "positive",
            "neutral",
            "negative"
          ],
          "description": "Your overall read of the experience."
        },
        "free_text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000,
          "description": "What happened, in plain words, up to 1000 characters. No personal data, addresses, payment details or credentials."
        },
        "struggle_points": {
          "type": "array",
          "minItems": 0,
          "maxItems": 10,
          "description": "Zero to ten tags from the fixed vocabulary, so difficulties can be counted without reading prose.",
          "items": {
            "type": "string",
            "enum": [
              "unclear_description",
              "unexpected_error",
              "price_changed",
              "address_rejected",
              "checkout_expired",
              "could_not_find_product",
              "budget_not_met",
              "confirmation_unclear",
              "other"
            ]
          }
        }
      },
      "required": [
        "context",
        "sentiment",
        "free_text",
        "struggle_points"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "get_tool_guide",
    title: "Read one tool's complete guide",
    kind: "operational",
    description: "Returns the complete guide for one Robodepo tool: summary, when to use it, what not to use it for, parameters, caveats, outputs, error recovery and worked examples. Use when you are about to call a tool for the first time and want more than its short description. Not for running the tool; call the tool by name instead. Full guide: get_tool_guide or /agent/tools.json#get_tool_guide",
    guide: {
      "summary": "Returns the full, unabridged guide for one registered tool — everything the short description had to leave out — as a structured object rather than one long string.",
      "use_when": "Use this when you are about to call a tool for the first time, when a short description leaves you unsure which parameter comes from where, or when an error code named a recovery you want to read in full.",
      "do_not_use": "Do not use this for running the tool; call the tool by its own name instead. Do not use it to discover what tools exist; the catalogue you were registered with already lists them, and `/agent/tools.json` serves the same guides as one document.",
      "parameters": "`tool_name` is the exact name from the catalogue, such as `create_checkout`. Unknown names are refused with the list of valid names rather than a guess.",
      "caveats": "It reads a static catalogue that ships with this page, so it makes no network request, holds no handle and cannot fail for any reason but an unknown name. The guide it returns is the same text `/agent/tools.json` publishes.",
      "outputs": "`resource.name`, `resource.operational` and `resource.guide`, where the guide carries `summary`, `use_when`, `do_not_use`, `parameters`, `caveats`, `outputs`, `error_recovery` and `examples[]`. Feed an example's `input` straight back into the named tool.",
      "error_recovery": "`not_found` is the only error and it means the name is not in this catalogue; the message lists every valid name, so pick one and call again. There is nothing to retry and no network failure to recover from.",
      "examples": [
        {
          "title": "Read a tool in full before first use",
          "input": {
            "tool_name": "create_checkout"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "tool_name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "The exact name of a registered tool, as it appears in this catalogue."
        }
      },
      "required": [
        "tool_name"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "search_by_activity",
    title: "Preview: find products by what the person is doing",
    kind: "preview",
    recover: ["search_catalog"],
    notBuilt: "Semantic search by function or activity is not built. Nothing behind this tool interprets an activity, and no product is matched to one.",
    description: "Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will find products by what the person is doing rather than the words they typed, returning ranked listings with the reason each was chosen. Use search_catalog today. Full guide: get_tool_guide or /agent/tools.json#search_by_activity",
    guide: {
      "summary": "Preview — not operational in this demo. It is meant to find products by what the person is doing rather than by words they typed — \"something to keep the sun off on a boat\" — and to return ranked listings with the reasoning that put each one there.",
      "use_when": "Use this when it ships and the person describes a situation rather than a product.",
      "do_not_use": "Do not use this for anything today; use `search_catalog` instead, which returns the demo catalogue and leaves relevance to your judgement, and `get_product` for the full record of a listing.",
      "parameters": "`activity` would be the situation in the person's own words, and `constraints` any limits such as a budget or a date. Neither is read by anything today.",
      "caveats": "This is the capability Robodepo's roadmap points at, and it is named here so the shape of the intent is visible — but it does not work, and `search_catalog` is not a quiet version of it: `search_catalog` filters nothing and ranks nothing across a one-product demo catalogue.",
      "outputs": "this tool returns `status: \"not_available\"` with a message saying plainly what is not built. There are no listings, no ranking and no ids to feed onward. It does return `resource.roadmap`, a sketch of the intended inputs, output fields and response shape, marked `illustrative: true` — that example is not live data and nothing in it is built.",
      "error_recovery": "there is no error to recover from and no retry that will help. Call `search_catalog` to see what the store actually sells, then `submit_feedback` if the missing capability is what you needed.",
      "examples": [
        {
          "title": "What a call would look like once built",
          "input": {
            "activity": "keep the sun off on a boat",
            "constraints": "under A$150"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "activity": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300,
          "description": "What the person is doing or needs to solve, in their own words."
        },
        "constraints": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 300,
          "description": "Limits such as budget, date or size, or null."
        }
      },
      "required": [
        "activity",
        "constraints"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "compare_products",
    title: "Preview: compare products side by side",
    kind: "preview",
    recover: ["get_product"],
    notBuilt: "Side-by-side comparison is not built. No comparison table, attribute alignment or evidence pack exists behind this tool.",
    description: "Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will take two to five product ids and return one aligned comparison, with the cited evidence behind each claim. Use get_product on each id today. Full guide: get_tool_guide or /agent/tools.json#compare_products",
    guide: {
      "summary": "Preview — not operational in this demo. It is meant to take two to five product ids and return one aligned comparison — shared attributes, where they differ, and the cited evidence behind each claim.",
      "use_when": "Use this when it ships and the person is choosing between candidates.",
      "do_not_use": "Do not use this for anything today; use `get_product` on each id instead and compare the published fields yourself, and `search_catalog` to find the ids.",
      "parameters": "`product_ids` would come from `search_catalog`. The demo catalogue holds one product, so there is nothing here to compare even once this is built for a larger catalogue.",
      "caveats": "Nothing is cached, computed or reserved by calling this. It is listed so the roadmap is legible, not because a partial version runs underneath.",
      "outputs": "this tool returns `status: \"not_available\"` with a plain explanation. There is no comparison object and no ids to feed onward. It does return `resource.roadmap`, a sketch of the intended inputs, output fields and response shape, marked `illustrative: true` — that example is not live data and nothing in it is built.",
      "error_recovery": "there is no error and no retry that helps. Call `get_product` for each id you hold, then `submit_feedback` if a real comparison is what you needed.",
      "examples": [
        {
          "title": "What a call would look like once built",
          "input": {
            "product_ids": [
              "prod_example",
              "prod_example_two"
            ]
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "product_ids": {
          "type": "array",
          "minItems": 2,
          "maxItems": 5,
          "description": "Two to five product ids from `search_catalog`.",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        }
      },
      "required": [
        "product_ids"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "get_evidence_pack",
    title: "Preview: cited evidence for a product",
    kind: "preview",
    recover: ["get_product"],
    notBuilt: "Evidence packs are not built. No manual, review or guide is indexed, and no citation exists to return.",
    description: "Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will return passages from manuals, reviews and buying guides with citations, so a product claim can be checked rather than trusted. Use get_product today. Full guide: get_tool_guide or /agent/tools.json#get_evidence_pack",
    guide: {
      "summary": "Preview — not operational in this demo. It is meant to return the evidence behind a product — passages from manuals, reviews and buying guides, each with its citation — so a claim can be checked rather than trusted.",
      "use_when": "Use this when it ships and the person asks whether a product really does something.",
      "do_not_use": "Do not use this for anything today; use `get_product` instead, which returns only the fields Robodepo actually publishes and discloses the source retailer, and `get_trust_manifest` for what the store claims about itself.",
      "parameters": "`product_id` would come from `search_catalog` or `get_product`. It is validated for shape and then ignored, because there is nothing to look up.",
      "caveats": "Robodepo publishes no product claim it cannot source, which is exactly why this tool returns nothing rather than a plausible summary. Calling it changes nothing and costs nothing.",
      "outputs": "this tool returns `status: \"not_available\"` with a message saying what is missing. There is no evidence array, no citations and nothing to feed onward. It does return `resource.roadmap`, a sketch of the intended inputs, output fields and response shape, marked `illustrative: true` — that example is not live data and nothing in it is built.",
      "error_recovery": "there is no error and no retry that helps. Call `get_product` for the published record, then `submit_feedback` if the missing evidence is what blocked the person.",
      "examples": [
        {
          "title": "What a call would look like once built",
          "input": {
            "product_id": "prod_example"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The product id from `search_catalog` or `get_product`."
        }
      },
      "required": [
        "product_id"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "get_shipping_options",
    title: "Preview: alternative shipping services",
    kind: "preview",
    recover: ["create_checkout"],
    notBuilt: "Alternative shipping services are not built. The store quotes exactly one service and there is no second option to choose between.",
    description: "Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will list every shipping service available for a prepared checkout, with price in AUD integer cents and a delivery estimate. Use create_checkout today, which returns the one service that exists. Full guide: get_tool_guide or /agent/tools.json#get_shipping_options",
    guide: {
      "summary": "Preview — not operational in this demo. It is meant to list the shipping services available for a prepared checkout — service name, price in AUD integer cents and delivery estimate — so the person can pick one.",
      "use_when": "Use this when it ships and the person cares about speed or cost.",
      "do_not_use": "Do not use this for anything today; use `create_checkout` instead, which already returns the only service that exists, `standard_sandbox` at a flat A$12.00 to the accepted sandbox address, and `get_order` to read back what was actually shipped against.",
      "parameters": "`checkout_id` would come from `create_checkout`. It is not looked up, because there is nothing to look up.",
      "caveats": "There is no hidden cheaper or faster option being withheld here: the sandbox has one deterministic rate, and this tool exists to say so rather than to imply choice the store does not have.",
      "outputs": "this tool returns `status: \"not_available\"` with that explanation. There is no options array and nothing to feed into a checkout. It does return `resource.roadmap`, a sketch of the intended inputs, output fields and response shape, marked `illustrative: true` — that example is not live data and nothing in it is built.",
      "error_recovery": "there is no error and no retry that helps. The shipping cost you already hold from `create_checkout` is the real one; call `submit_feedback` if the person needed a choice.",
      "examples": [
        {
          "title": "What a call would look like once built",
          "input": {
            "checkout_id": "chk_example"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "checkout_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The `checkout_id` returned by `create_checkout`."
        }
      },
      "required": [
        "checkout_id"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "create_custom_store",
    title: "Preview: a storefront assembled for this agent's brief",
    kind: "preview",
    recover: ["search_catalog"],
    notBuilt: "Per-agent custom storefronts are not built. No brief is read, no selection is assembled and no storefront is created.",
    description: "Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will assemble a checkout-ready storefront for the brief a visiting agent arrives with, and return a link to it. Use search_catalog today. Full guide: get_tool_guide or /agent/tools.json#create_custom_store",
    guide: {
      "summary": "Preview — not operational in this demo. It is meant to assemble a storefront for the brief a visiting agent arrives with — a narrowed selection, priced and ready to buy through the same checkout path — and return a link to it.",
      "use_when": "Use this when it ships and the person's need is broader than one product.",
      "do_not_use": "Do not use this for anything today; use `search_catalog` instead to see the whole demo catalogue, which is one product, and `create_checkout` to buy it.",
      "parameters": "`brief` would be what the person wants, up to 500 characters. It is checked for shape and then discarded; nothing reads it and nothing is stored.",
      "caveats": "This is the most ambitious item on the roadmap and the least built. It is listed to show the direction, and it says so in its first words rather than returning an empty storefront that looks like a real one.",
      "outputs": "this tool returns `status: \"not_available\"` with a plain explanation. There is no storefront, no link and nothing to feed onward. It does return `resource.roadmap`, a sketch of the intended inputs, output fields and response shape, marked `illustrative: true` — that example is not live data and nothing in it is built.",
      "error_recovery": "there is no error and no retry that helps. Call `search_catalog`, then `submit_feedback` to say what brief you would have given it.",
      "examples": [
        {
          "title": "What a call would look like once built",
          "input": {
            "brief": "Sun protection for a week on the water"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "brief": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500,
          "description": "What the person wants the storefront to cover, up to 500 characters."
        }
      },
      "required": [
        "brief"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "subscribe_replenishment_alerts",
    title: "Preview: reminders when a consumable runs down",
    kind: "preview",
    recover: ["get_product"],
    notBuilt: "Replenishment alerts are not built. No subscription is created, no schedule is kept and no reminder will ever arrive.",
    description: "Preview — not operational in this demo. Describes the roadmap only; returns status not_available and must not be called to do real work. It will register a weekly, monthly or quarterly reminder for a consumable, so the person is prompted before they run out. Use get_product today. Full guide: get_tool_guide or /agent/tools.json#subscribe_replenishment_alerts",
    guide: {
      "summary": "Preview — not operational in this demo. It is meant to register a repeating reminder for a consumable — weekly, monthly or quarterly — so the person is prompted before they run out, and to return the subscription id.",
      "use_when": "Use this when it ships and the person buys something they will need again.",
      "do_not_use": "Do not use this for anything today; use `get_product` instead to read the item and `create_checkout` when they actually want another one.",
      "parameters": "`product_id` would come from `search_catalog` or `get_product`, and `cadence` would be weekly, monthly or quarterly. Neither is stored.",
      "caveats": "Nothing is scheduled and nothing will be sent. Robodepo holds no contact details for anyone, so there is no channel a reminder could arrive on; saying that plainly is more useful than a subscription id that means nothing.",
      "outputs": "this tool returns `status: \"not_available\"` with that explanation. There is no subscription id and nothing to feed onward. It does return `resource.roadmap`, a sketch of the intended inputs, output fields and response shape, marked `illustrative: true` — that example is not live data and nothing in it is built.",
      "error_recovery": "there is no error and no retry that helps. Call `get_product` for the record, then `submit_feedback` if the person wanted the reminder.",
      "examples": [
        {
          "title": "What a call would look like once built",
          "input": {
            "product_id": "prod_example",
            "cadence": "monthly"
          }
        }
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "untrustedContentHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    inputSchema: {
      "type": "object",
      "properties": {
        "product_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The product id from `search_catalog` or `get_product`."
        },
        "cadence": {
          "type": "string",
          "enum": [
            "weekly",
            "monthly",
            "quarterly"
          ],
          "description": "How often the reminder would repeat."
        }
      },
      "required": [
        "product_id",
        "cadence"
      ],
      "additionalProperties": false
    },
  },
]);

/**
 * The catalogue in publication order: the eight operational tools first, then
 * the six previews, each group keeping its own order.
 *
 * The literal above is already written this way, so this changes nothing
 * today. It exists so that adding a tool in the wrong place cannot quietly
 * bury a working tool below six that return `not_available` — a host reads
 * this order, and an agent skimming it should meet the real ones first.
 */
export const ORDERED_TOOLS = Object.freeze([
  ...TOOLS.filter((tool) => tool.kind === "operational"),
  ...TOOLS.filter((tool) => tool.kind !== "operational"),
]);

export const OPERATIONAL_TOOL_NAMES = Object.freeze(
  ORDERED_TOOLS.filter((tool) => tool.kind === "operational").map((tool) => tool.name),
);

export const PREVIEW_TOOL_NAMES = Object.freeze(
  ORDERED_TOOLS.filter((tool) => tool.kind === "preview").map((tool) => tool.name),
);

/**
 * The catalogue as a document: what a mirror repository's README, or a judge
 * reading the source, prints. No `execute`, no closures, JSON-serialisable.
 */
export function TOOL_CATALOGUE_JSON() {
  return ORDERED_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    operational: tool.kind === "operational",
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    guide: tool.guide,
  }));
}

/** The guide for one tool, or null when the name is not in this catalogue. */
export function toolGuide(name) {
  const tool = TOOLS.find((candidate) => candidate.name === name) ?? null;
  return tool ? { name: tool.name, operational: tool.kind === "operational", guide: tool.guide } : null;
}

/* ------------------------------------------------------------------------ *
 * Preview roadmaps.
 *
 * Every preview tool returns one of these so the intended shape is legible
 * without pretending any of it runs. `illustrative_response` is a sketch, not
 * a recorded result: ids are placeholders such as `prod_example`, amounts are
 * null because no price has been observed for anything that does not exist,
 * and the `illustrative: true` flag plus the `illustrative_only` message say
 * so in the envelope itself.
 * ------------------------------------------------------------------------ */

const PREVIEW_ROADMAPS = Object.freeze({
  search_by_activity: {
    what_it_will_do:
      "Find products by what the person is doing rather than by the words they typed, and return ranked listings with the reason each one was chosen.",
    planned_inputs: ["activity", "constraints", "limit", "response_format"],
    planned_output_fields: [
      "resource.query_understanding",
      "resource.listings[].product_id",
      "resource.listings[].title",
      "resource.listings[].display_price_cents",
      "resource.listings[].match_reason",
      "resource.listings[].confidence",
    ],
    illustrative_response: {
      status: "ok",
      resource: {
        type: "listings",
        listings: [{ product_id: "prod_example", match_reason: "Why this fits the activity." }],
      },
    },
    illustrative: true,
  },
  compare_products: {
    what_it_will_do:
      "Take two to five product ids and return one aligned comparison — shared attributes, where they differ, and the cited evidence behind each claim.",
    planned_inputs: ["product_ids", "attributes", "response_format"],
    planned_output_fields: [
      "resource.comparison.attributes[]",
      "resource.comparison.rows[].product_id",
      "resource.comparison.rows[].values",
      "resource.comparison.differences[]",
      "resource.citations[]",
    ],
    illustrative_response: {
      status: "ok",
      resource: {
        type: "comparison",
        rows: [{ product_id: "prod_example", values: { attribute_name: null } }],
      },
    },
    illustrative: true,
  },
  get_evidence_pack: {
    what_it_will_do:
      "Return the evidence behind a product — passages from manuals, reviews and buying guides, each with its citation — so a claim can be checked rather than trusted.",
    planned_inputs: ["product_id", "claim", "response_format"],
    planned_output_fields: [
      "resource.evidence[].claim",
      "resource.evidence[].passage",
      "resource.evidence[].source_type",
      "resource.evidence[].source_url",
      "resource.evidence[].retrieved_at",
      "resource.unsupported_claims[]",
    ],
    illustrative_response: {
      status: "ok",
      resource: {
        type: "evidence_pack",
        evidence: [{ claim: "The claim asked about.", source_type: "manual", source_url: null }],
      },
    },
    illustrative: true,
  },
  get_shipping_options: {
    what_it_will_do:
      "List every shipping service available for a prepared checkout, with its price in AUD integer cents and a delivery estimate, so the person can choose one.",
    planned_inputs: ["checkout_id"],
    planned_output_fields: [
      "resource.options[].shipping_quote_id",
      "resource.options[].service",
      "resource.options[].shipping_cents",
      "resource.options[].formatted_price",
      "resource.options[].delivery_estimate",
      "resource.selected_shipping_quote_id",
    ],
    illustrative_response: {
      status: "ok",
      resource: {
        type: "shipping_options",
        options: [{ shipping_quote_id: "quote_example", service: "service_name", shipping_cents: null }],
      },
    },
    illustrative: true,
  },
  create_custom_store: {
    what_it_will_do:
      "Assemble a storefront for the brief a visiting agent arrives with — a narrowed selection, priced and buyable through the same checkout path — and return a link to it.",
    planned_inputs: ["brief", "budget_ceiling_cents", "limit"],
    planned_output_fields: [
      "resource.store.store_id",
      "resource.store.url",
      "resource.store.brief_understood_as",
      "resource.store.listings[]",
      "resource.store.expires_at",
    ],
    illustrative_response: {
      status: "ok",
      resource: {
        type: "custom_store",
        store: { store_id: "store_example", url: "/s/store_example", expires_at: null },
      },
    },
    illustrative: true,
  },
  subscribe_replenishment_alerts: {
    what_it_will_do:
      "Register a repeating reminder for a consumable — weekly, monthly or quarterly — so the person is prompted before they run out.",
    planned_inputs: ["product_id", "cadence", "channel"],
    planned_output_fields: [
      "resource.subscription.subscription_id",
      "resource.subscription.product_id",
      "resource.subscription.cadence",
      "resource.subscription.next_reminder_at",
      "resource.subscription.state",
    ],
    illustrative_response: {
      status: "ok",
      resource: {
        type: "subscription",
        subscription: { subscription_id: "sub_example", cadence: "monthly", state: "active" },
      },
    },
    illustrative: true,
  },
});

/* ------------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------------ */

function defaultModelContext() {
  if (typeof document !== "undefined" && document && document.modelContext) {
    return document.modelContext;
  }
  if (typeof navigator !== "undefined" && navigator && navigator.modelContext) {
    return navigator.modelContext;
  }
  return null;
}

function defaultRandomUuid() {
  const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  // Deliberate last resort: a v4-shaped id built from Math.random. The store
  // validates the shape, and this branch only runs where crypto is absent.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function defaultOpenWindow(url, name) {
  if (typeof window === "undefined" || typeof window.open !== "function") {
    return null;
  }
  return window.open(url, name);
}

/**
 * Build the tool runtime. Every browser capability arrives as an option so the
 * whole thing runs under Node in a test.
 */
export function createRobodepoTools(options = {}) {
  const deps = {
    fetch:
      options.fetch ??
      (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null),
    modelContext: options.modelContext ?? null,
    origin: options.origin ?? "",
    now: options.now ?? (() => new Date()),
    randomUUID: options.randomUUID ?? defaultRandomUuid,
    openWindow: options.openWindow ?? defaultOpenWindow,
  };

  const session = {
    /** @type {Map<string, object>} */
    checkouts: new Map(),
    /** @type {string[]} */
    order: [],
    handoffWindow: null,
  };

  const activityListeners = new Set();
  let abortController = null;

  function nowIso() {
    return deps.now().toISOString();
  }

  function currentCheckout() {
    for (let index = session.order.length - 1; index >= 0; index -= 1) {
      const entry = session.checkouts.get(session.order[index]);
      if (entry) {
        return entry;
      }
    }
    return null;
  }

  /* ------------------------- next_actions from state ------------------- */

  function actionFor(toolName, checkout) {
    switch (toolName) {
      case "search_catalog":
        return {
          tool: "search_catalog",
          why: "See what this store sells.",
          args_hint: { query: "", limit: 10, response_format: "concise" },
        };
      case "get_product":
        return {
          tool: "get_product",
          why: "Read one product's full record, including both prices.",
          args_hint: { product_id: PRODUCT_ID },
        };
      case "create_checkout":
        return {
          tool: "create_checkout",
          why: "Price the order and get the approval link.",
          args_hint: {
            line_items: [{ product_id: PRODUCT_ID, quantity: SUPPORTED_QUANTITY }],
            shipping_address: { ...ACCEPTED_ADDRESS },
            budget_ceiling_cents: null,
            idempotency_key: null,
          },
        };
      case "cancel_checkout":
        return {
          tool: "cancel_checkout",
          why: "Decline explicitly so the refusal is recorded.",
          args_hint: { checkout_id: checkout ? checkout.checkout_id : null, reason: null },
        };
      case "get_order":
        return {
          tool: "get_order",
          why: "Read back the order once the person has approved.",
          args_hint: {
            order_id: checkout ? checkout.order_id : null,
            checkout_id: checkout ? checkout.checkout_id : null,
          },
        };
      case "get_tool_guide":
        return {
          tool: "get_tool_guide",
          why: "Read a tool's complete guide before calling it for the first time.",
          args_hint: { tool_name: "create_checkout" },
        };
      case "get_trust_manifest":
        return {
          tool: "get_trust_manifest",
          why: "Check what this store claims about itself.",
          args_hint: {},
        };
      case "submit_feedback":
        return {
          tool: "submit_feedback",
          why: "Say what was unclear, missing or wrong.",
          args_hint: {
            context: {
              checkout_id: checkout ? checkout.checkout_id : null,
              order_id: checkout ? checkout.order_id : null,
            },
          },
        };
      default:
        return null;
    }
  }

  function handoffAction(checkout) {
    return {
      tool: null,
      action: "open_confirmation_page",
      url: checkout.confirmation_url,
      why: "The person approves here, with a fingerprint or face touch where the device has one and a plain button where it does not. This is the only irreversible step and the agent must not submit it.",
    };
  }

  /**
   * Recommended next tools, computed from the page session's state. Never
   * hard-coded per tool, and never empty when something went wrong.
   */
  function computeNextActions(recoverTools, failedTool) {
    const checkout = currentCheckout();

    if (Array.isArray(recoverTools) && recoverTools.length > 0) {
      const resolved = [];
      for (const entry of recoverTools) {
        const name = entry === "self" ? failedTool : entry;
        const action = actionFor(name, checkout);
        if (action && !resolved.some((existing) => existing.tool === action.tool)) {
          resolved.push(action);
        }
      }
      if (!resolved.some((existing) => existing.tool === "submit_feedback")) {
        resolved.push(actionFor("submit_feedback", checkout));
      }
      return resolved;
    }

    if (!checkout) {
      return [actionFor("search_catalog", null), actionFor("get_product", null)];
    }
    if (checkout.order_id) {
      return [actionFor("get_order", checkout), actionFor("submit_feedback", checkout)];
    }
    if (checkout.status === "canceled") {
      return [actionFor("search_catalog", checkout), actionFor("submit_feedback", checkout)];
    }
    if (checkout.status === "ready_for_complete") {
      return [
        handoffAction(checkout),
        actionFor("cancel_checkout", checkout),
        actionFor("submit_feedback", checkout),
      ];
    }
    return [actionFor("search_catalog", checkout), actionFor("submit_feedback", checkout)];
  }

  function trustManifestLink() {
    return { type: "trust_manifest", url: `${deps.origin}${TRUST_MANIFEST_PATH}` };
  }

  /* ------------------------------ transport ---------------------------- */

  async function requestJson(method, path, { body, idempotencyKey } = {}) {
    if (typeof deps.fetch !== "function") {
      return { ok: false, network: true, requestId: null };
    }
    const headers = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    let response;
    try {
      response = await deps.fetch(`${deps.origin}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { ok: false, network: true, requestId: null };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = payload && payload.error ? payload.error : null;
      return {
        ok: false,
        network: false,
        status: response.status,
        code: error && typeof error.code === "string" ? error.code : null,
        requestId: error && typeof error.request_id === "string" ? error.request_id : null,
      };
    }

    const data =
      payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
    const requestId =
      payload && payload.meta && typeof payload.meta.request_id === "string"
        ? payload.meta.request_id
        : null;
    return { ok: true, status: response.status, data, requestId };
  }

  function apiErrorEnvelope(failure, { tool, step = null, resourceType = "checkout" }) {
    const mapping = failure.network
      ? NETWORK_ERROR
      : (TOOL_ERROR_OVERRIDES[tool]?.[failure.code] ??
        API_ERROR_MAP[failure.code] ??
        UNKNOWN_ERROR);
    const stepNote = step ? ` The step that failed was ${step}.` : "";
    return buildEnvelope({
      status: "error",
      resource: {
        type: resourceType,
        failed_step: step,
        request_id: failure.requestId ?? null,
        api_error_code: failure.network ? null : (failure.code ?? null),
      },
      messages: [
        message(
          "error",
          mapping.code,
          mapping.severity,
          null,
          `${mapping.content}${stepNote}`,
        ),
      ],
      next_actions: computeNextActions(mapping.recover, tool),
      links: [trustManifestLink()],
      instructions: {
        for_human: "Robodepo could not finish that step. Nothing was charged.",
        for_agent: `Follow next_actions. Do not retry blindly; the message names the cause.${stepNote}`,
      },
    });
  }

  function incompleteEnvelope({ path, code, content, recover, tool }) {
    return buildEnvelope({
      status: "incomplete",
      resource: { type: "checkout", checkout_id: null, state: "incomplete" },
      messages: [message("error", code, "requires_buyer_input", path, content)],
      next_actions: computeNextActions(recover, tool),
      links: [trustManifestLink()],
      instructions: {
        for_human: "Robodepo needs one detail corrected before it can price this order.",
        for_agent: "Correct the field named in the message path, then call the same tool again.",
      },
    });
  }

  /* ----------------------------- idempotency --------------------------- */

  function resolveIdempotencyBase(supplied) {
    if (supplied === null || supplied === undefined) {
      return { ok: true, base: `wm-${deps.randomUUID()}` };
    }
    if (
      typeof supplied !== "string" ||
      !isPrintableAscii(supplied) ||
      supplied.length < IDEMPOTENCY_KEY_MIN ||
      supplied.length > IDEMPOTENCY_KEY_MAX
    ) {
      return { ok: false };
    }
    return { ok: true, base: supplied.slice(0, IDEMPOTENCY_BASE_MAX) };
  }

  /* ------------------------------ the tools ---------------------------- */

  async function searchCatalog(input) {
    const query = typeof input?.query === "string" ? input.query : "";
    const result = await requestJson("GET", `/api/v1/products/${PRODUCT_ID}`);

    if (!result.ok) {
      const recoverable =
        result.code === "PRODUCT_NOT_FOUND" ||
        result.code === "PRODUCT_UNAVAILABLE" ||
        result.code === "PRODUCT_STALE";
      if (!recoverable) {
        return apiErrorEnvelope(result, { tool: "search_catalog", resourceType: "listings" });
      }
      const mapping = API_ERROR_MAP[result.code];
      return buildEnvelope({
        status: "ok",
        resource: { type: "listings", catalogue_size: 1, query, listings: [] },
        messages: [
          message("warning", mapping.code, mapping.severity, "$.resource.listings", mapping.content),
        ],
        next_actions: computeNextActions(mapping.recover, "search_catalog"),
        links: [trustManifestLink()],
        instructions: {
          for_human: "Robodepo cannot offer its demo product right now.",
          for_agent: "The catalogue returned no buyable listing. Tell the person why.",
        },
      });
    }

    const product = result.data ?? {};
    const listing = {
      product_id: product.product_id ?? PRODUCT_ID,
      title: product.title ?? null,
      variant: product.variant ?? null,
      currency: product.currency ?? CURRENCY,
      display_price_cents: product.display_price_cents ?? null,
      formatted_price: formatAud(product.display_price_cents),
      available: product.available ?? false,
      transaction_mode: "sandbox",
      ...sourceDisclosure(product.source, wantsDetail(input)),
    };

    const buyable = listing.available === true;
    const catalogueMessage = message(
      "info",
      "demo_catalogue",
      "recoverable",
      null,
      "One product in this catalogue. Nothing was ranked or keyword-matched against your query; relevance is your call.",
    );
    const messages = buyable
      ? [catalogueMessage]
      : [
          catalogueMessage,
          message(
            "warning",
            "out_of_stock",
            "requires_buyer_review",
            "$.resource.listings",
            "The demo catalogue's only product is reported unavailable at the source retailer, so no listing can be bought and the listings array is empty.",
          ),
        ];

    return buildEnvelope({
      status: "ok",
      resource: {
        type: "listings",
        catalogue_size: 1,
        query,
        listings: buyable ? [listing] : [],
      },
      messages,
      next_actions: computeNextActions(["get_product", "create_checkout"], "search_catalog"),
      links: [trustManifestLink()],
      instructions: {
        for_human: `One item: ${listing.title ?? "the demo product"} at ${listing.formatted_price ?? "an unpriced amount"}.`,
        for_agent: "Call get_product for the full record, or create_checkout to price it.",
      },
    });
  }

  async function getProduct(input) {
    const productId = typeof input?.product_id === "string" ? input.product_id : PRODUCT_ID;
    const result = await requestJson(
      "GET",
      `/api/v1/products/${encodeURIComponent(productId)}`,
    );
    if (!result.ok) {
      return apiErrorEnvelope(result, { tool: "get_product", resourceType: "product" });
    }
    const product = result.data ?? {};
    const { source, ...withoutSource } = product;
    const detailed = wantsDetail(input);
    return buildEnvelope({
      status: "ok",
      resource: {
        type: "product",
        ...(detailed ? product : withoutSource),
        ...sourceDisclosure(source, detailed),
        formatted_price: formatAud(product.display_price_cents),
        formatted_source_price: formatAud(product.source_price_cents),
        transaction_mode: "sandbox",
      },
      messages: [
        message(
          "info",
          "price_disclosure",
          "recoverable",
          null,
          "Both prices are published: the displayed price sits above the source retailer's, and the retailer's own price can move.",
        ),
      ],
      next_actions: computeNextActions(["create_checkout", "search_catalog"], "get_product"),
      links: [trustManifestLink()],
      instructions: {
        for_human: `${product.title ?? "This item"} is ${formatAud(product.display_price_cents) ?? "unpriced"} from ${product.source?.retailer ?? "the source retailer"}.`,
        for_agent: "Relay both prices and the retailer, then call create_checkout.",
      },
    });
  }

  async function createCheckout(input) {
    const lineItems = Array.isArray(input?.line_items) ? input.line_items : [];
    const first = lineItems.length > 0 ? lineItems[0] : null;

    if (!first || typeof first.product_id !== "string" || first.product_id.length === 0) {
      return incompleteEnvelope({
        path: "$.line_items[0].product_id",
        code: "line_item_missing",
        content: `Name the product to buy. The demo catalogue holds one product, ${PRODUCT_ID}; call search_catalog to see it.`,
        recover: ["search_catalog"],
        tool: "create_checkout",
      });
    }

    if (first.quantity !== SUPPORTED_QUANTITY) {
      return incompleteEnvelope({
        path: "$.line_items[0].quantity",
        code: "quantity_not_supported",
        content: `The tracer supports quantity ${SUPPORTED_QUANTITY} only. Set quantity to ${SUPPORTED_QUANTITY} and call create_checkout again.`,
        recover: ["create_checkout"],
        tool: "create_checkout",
      });
    }

    // Exact-format validation against the literal the contract publishes. This
    // is the allowed deterministic exception: it saves a round trip and lets
    // the agent be told the accepted value instead of guessing.
    const addressCheck = checkShippingAddress(input?.shipping_address);
    if (!addressCheck.ok) {
      return incompleteEnvelope({
        path: "$.shipping_address",
        code: "address_not_accepted",
        content: `Robodepo's sandbox accepts exactly one address and no real address is ever accepted. Use ${ACCEPTED_ADDRESS_SENTENCE}, then call create_checkout again. No request was sent to the store.`,
        recover: ["create_checkout"],
        tool: "create_checkout",
      });
    }

    const keyCheck = resolveIdempotencyBase(
      input?.idempotency_key === undefined ? null : input.idempotency_key,
    );
    if (!keyCheck.ok) {
      return incompleteEnvelope({
        path: "$.idempotency_key",
        code: "idempotency_key_invalid",
        content: `An idempotency key must be ${IDEMPOTENCY_KEY_MIN} to ${IDEMPOTENCY_KEY_MAX} printable ASCII characters, or null so the tool generates one. Fix it and call create_checkout again.`,
        recover: ["create_checkout"],
        tool: "create_checkout",
      });
    }

    const base = keyCheck.base;
    const runId = deps.randomUUID();

    const cart = await requestJson("POST", "/api/v1/carts", {
      body: { run_id: runId, surface: "webmcp", product_id: first.product_id },
      idempotencyKey: `${base}-cart`,
    });
    if (!cart.ok) {
      return apiErrorEnvelope(cart, { tool: "create_checkout", step: "create_cart" });
    }
    const cartId = cart.data?.cart_id;

    const item = await requestJson("POST", `/api/v1/carts/${cartId}/items`, {
      body: { product_id: first.product_id, quantity: SUPPORTED_QUANTITY },
      idempotencyKey: `${base}-item`,
    });
    if (!item.ok) {
      return apiErrorEnvelope(item, { tool: "create_checkout", step: "add_item" });
    }
    const subtotalCents = item.data?.subtotal_cents ?? 0;

    const address = await requestJson("PUT", `/api/v1/carts/${cartId}/address`, {
      body: { ...ACCEPTED_ADDRESS },
      idempotencyKey: `${base}-address`,
    });
    if (!address.ok) {
      return apiErrorEnvelope(address, { tool: "create_checkout", step: "apply_address" });
    }
    const deliveryRegion = address.data?.delivery_region ?? null;

    const shipping = await requestJson("POST", `/api/v1/carts/${cartId}/shipping-quotes`, {
      body: {},
      idempotencyKey: `${base}-shipping`,
    });
    if (!shipping.ok) {
      return apiErrorEnvelope(shipping, { tool: "create_checkout", step: "quote_shipping" });
    }
    const shippingCents = shipping.data?.shipping_cents ?? SANDBOX_SHIPPING_CENTS;
    const shippingQuoteId = shipping.data?.shipping_quote_id;
    const shippingService = shipping.data?.service ?? "standard_sandbox";

    const mandate = await requestJson("POST", `/api/v1/carts/${cartId}/mandates`, {
      body: {
        shipping_quote_id: shippingQuoteId,
        max_total_cents: subtotalCents + shippingCents,
      },
      idempotencyKey: `${base}-mandate`,
    });
    if (!mandate.ok) {
      return apiErrorEnvelope(mandate, { tool: "create_checkout", step: "issue_mandate" });
    }

    const itemsCents = mandate.data?.item_total_cents ?? subtotalCents;
    const totalCents = mandate.data?.total_cents ?? itemsCents + shippingCents;
    const checkoutId = mandate.data?.mandate_id ?? null;
    const plainConfirmationUrl = mandate.data?.confirmation_url ?? null;
    const approvalUrl = checkoutId
      ? approvalUrlFor(plainConfirmationUrl, checkoutId, deps.origin)
      : null;

    const record = {
      checkout_id: checkoutId,
      cart_id: cartId ?? null,
      run_id: runId,
      confirmation_url: approvalUrl,
      plain_confirmation_url: plainConfirmationUrl,
      status: "ready_for_complete",
      created_at: nowIso(),
      expires_at: mandate.data?.expires_at ?? null,
      order_id: null,
      title: PRODUCT_TITLE,
      variant: PRODUCT_VARIANT,
      delivery_region: deliveryRegion,
      total_cents: totalCents,
    };
    if (checkoutId) {
      session.checkouts.set(checkoutId, record);
      session.order.push(checkoutId);
    }

    const messages = [
      message(
        "info",
        "human_confirmation_required",
        "requires_buyer_review",
        "$.resource.confirmation_url",
        "Priced and ready. Only the person can place it, on Robodepo's approval page — one biometric touch where the browser has one, a plain button where it does not, and no tool can submit either. The checkout expires 15 minutes after creation. Stripe test payment: nothing is charged, no retailer order, nothing ships.",
      ),
    ];

    const ceiling = input?.budget_ceiling_cents;
    if (typeof ceiling === "number" && Number.isFinite(ceiling) && totalCents > ceiling) {
      messages.push(
        message(
          "warning",
          "budget_exceeded",
          "requires_buyer_review",
          "$.resource.totals.total_cents",
          `The delivered total ${formatAud(totalCents)} exceeds the stated ceiling of ${formatAud(ceiling)}. No cheaper listing exists in this demo catalogue. Cancel with cancel_checkout, or hand over the confirmation link with the person's approval.`,
        ),
      );
    }

    return buildEnvelope({
      status: "ready_for_complete",
      resource: {
        type: "checkout",
        checkout_id: checkoutId,
        cart_id: cartId ?? null,
        run_id: runId,
        state: "awaiting_confirmation",
        expires_at: record.expires_at,
        line_items: [
          {
            product_id: first.product_id,
            title: PRODUCT_TITLE,
            variant: PRODUCT_VARIANT,
            quantity: SUPPORTED_QUANTITY,
            unit_price_cents: itemsCents,
          },
        ],
        totals: {
          currency: CURRENCY,
          items_cents: itemsCents,
          shipping_cents: shippingCents,
          total_cents: totalCents,
          formatted_total: formatAud(totalCents),
        },
        delivery_region: deliveryRegion,
        shipping_service: shippingService,
        source_retailer: SOURCE_RETAILER,
        price_may_differ: true,
        confirmation_url: approvalUrl,
        plain_confirmation_url: plainConfirmationUrl,
      },
      messages,
      next_actions: computeNextActions(null, "create_checkout"),
      links: [
        { type: "approval_page", url: approvalUrl },
        { type: "confirmation_page", url: plainConfirmationUrl },
        trustManifestLink(),
      ],
      instructions: {
        for_human: "Open the approval page and approve to place a sandbox order; nothing is charged.",
        for_agent: "Hand over confirmation_url, then call get_order once they approve.",
      },
    });
  }

  async function postFeedback(payload) {
    return requestJson("POST", FEEDBACK_PATH, { body: payload });
  }

  async function cancelCheckout(input) {
    const checkoutId = typeof input?.checkout_id === "string" ? input.checkout_id : null;
    const record = checkoutId ? session.checkouts.get(checkoutId) : null;

    if (!record) {
      return buildEnvelope({
        status: "error",
        resource: { type: "checkout", checkout_id: checkoutId, request_id: null },
        messages: [
          message(
            "error",
            "not_found",
            "recoverable",
            "$.checkout_id",
            "This browser did not prepare that checkout. Checkouts belong to the page session that created them; create one with create_checkout.",
          ),
        ],
        next_actions: computeNextActions(["create_checkout"], "cancel_checkout"),
        links: [trustManifestLink()],
        instructions: {
          for_human: "There is nothing to cancel here.",
          for_agent: "Create a checkout before cancelling one.",
        },
      });
    }

    record.status = "canceled";
    const declinedAt = nowIso();
    const reason =
      typeof input?.reason === "string" && input.reason.length > 0 ? input.reason : null;

    const posted = await postFeedback({
      kind: "checkout_declined",
      context: { checkout_id: record.checkout_id, order_id: record.order_id },
      sentiment: null,
      free_text: null,
      struggle_points: null,
      reason,
    });

    const messages = [
      message(
        "info",
        "checkout_declined",
        "recoverable",
        null,
        "The checkout is closed in this page session and the decline is on the record. The v1 API has no server-side cancel route: the sandbox mandate simply expires within 15 minutes of creation and cannot be confirmed from this page afterwards. Nothing was held and nothing was charged.",
      ),
    ];
    if (!posted.ok) {
      messages.push(
        message(
          "warning",
          "decline_not_recorded",
          "recoverable",
          null,
          "The decline record did not reach Robodepo. The cancel itself stands; call submit_feedback if you want the reason kept.",
        ),
      );
    }

    return buildEnvelope({
      status: "canceled",
      resource: {
        type: "checkout",
        checkout_id: record.checkout_id,
        state: "canceled",
        declined_at: declinedAt,
        reason,
        feedback_recorded: posted.ok === true,
      },
      messages,
      next_actions: computeNextActions(null, "cancel_checkout"),
      links: [trustManifestLink()],
      instructions: {
        for_human: "Nothing was bought and nothing was charged.",
        for_agent: "The decline is recorded. Offer the catalogue again or submit feedback.",
      },
    });
  }

  /** Read the handoff window's path without ever touching a cross-origin one. */
  function orderIdFromHandoffWindow() {
    const handle = session.handoffWindow;
    if (!handle) {
      return null;
    }
    try {
      const pathname = handle.location && handle.location.pathname;
      if (typeof pathname !== "string") {
        return null;
      }
      const parts = pathname.split("/").filter((part) => part.length > 0);
      if (parts.length === 2 && parts[0] === "orders") {
        return parts[1];
      }
      return null;
    } catch {
      return null;
    }
  }

  async function getOrder(input) {
    let orderId = typeof input?.order_id === "string" && input.order_id ? input.order_id : null;
    const checkoutId =
      typeof input?.checkout_id === "string" && input.checkout_id ? input.checkout_id : null;

    if (!orderId && !checkoutId) {
      return incompleteEnvelope({
        path: "$.order_id",
        code: "identifier_required",
        content:
          "Supply at least one of order_id or checkout_id. order_id comes from the /orders/{order_id} page the person lands on after confirming; checkout_id comes from create_checkout.",
        recover: ["create_checkout"],
        tool: "get_order",
      });
    }

    let record = checkoutId ? (session.checkouts.get(checkoutId) ?? null) : null;

    if (!orderId && checkoutId) {
      if (!record) {
        return buildEnvelope({
          status: "error",
          resource: { type: "order", checkout_id: checkoutId, request_id: null },
          messages: [
            message(
              "error",
              "not_found",
              "recoverable",
              "$.checkout_id",
              "This browser did not prepare that checkout, so there is no order to look up. An order is readable only from the browser whose run created it. Supply an order_id if you hold one, otherwise start again from the catalogue.",
            ),
          ],
          next_actions: computeNextActions(["search_catalog"], "get_order"),
          links: [trustManifestLink()],
          instructions: {
            for_human: "There is no order under that reference in this browser.",
            for_agent: "Use an order_id if you hold one, or start again from search_catalog.",
          },
        });
      }
      orderId = record.order_id ?? orderIdFromHandoffWindow();
      if (orderId) {
        record.order_id = orderId;
        record.status = "completed";
      }
    }

    if (!orderId) {
      return buildEnvelope({
        status: "awaiting_human_confirmation",
        resource: {
          type: "checkout",
          checkout_id: record ? record.checkout_id : checkoutId,
          state: "awaiting_confirmation",
          expires_at: record ? record.expires_at : null,
          confirmation_url: record ? record.confirmation_url : null,
          plain_confirmation_url: record ? (record.plain_confirmation_url ?? null) : null,
        },
        messages: [
          message(
            "info",
            "awaiting_human_confirmation",
            "requires_buyer_review",
            "$.resource.confirmation_url",
            "The person has not approved yet, so no order exists. This is not an error. The checkout expires 15 minutes after creation; the agent must not submit the approval or confirmation form, and no tool can.",
          ),
        ],
        next_actions: computeNextActions(null, "get_order"),
        links: record?.confirmation_url
          ? [
              { type: "approval_page", url: record.confirmation_url },
              ...(record.plain_confirmation_url
                ? [{ type: "confirmation_page", url: record.plain_confirmation_url }]
                : []),
              trustManifestLink(),
            ]
          : [trustManifestLink()],
        instructions: {
          for_human:
            "Open the approval page and approve with your fingerprint or face, or the plain button, when you are ready. Nothing is charged.",
          for_agent: "Wait for the person, then call get_order again.",
        },
      });
    }

    const result = await requestJson("GET", `/api/v1/orders/${encodeURIComponent(orderId)}`);
    if (!result.ok) {
      return apiErrorEnvelope(result, { tool: "get_order", resourceType: "order" });
    }

    const order = result.data ?? {};
    if (record) {
      record.order_id = order.order_id ?? orderId;
      record.status = "completed";
    }

    return buildEnvelope({
      status: "completed",
      resource: {
        type: "order",
        ...order,
        formatted_total: formatAud(order.total_cents),
        transaction_mode: "sandbox",
      },
      messages: [
        message(
          "info",
          "sandbox_order",
          "recoverable",
          null,
          "Sandbox order, Stripe test payment. No money moved, no retailer order, nothing ships.",
        ),
      ],
      next_actions: computeNextActions(null, "get_order"),
      links: [
        { type: "order_page", url: `${deps.origin}/orders/${order.order_id ?? orderId}` },
        trustManifestLink(),
      ],
      instructions: {
        for_human: `Order ${order.order_id ?? orderId} is confirmed for ${formatAud(order.total_cents) ?? "the quoted total"} to ${order.delivery_region ?? "the delivery region"}. Sandbox only; nothing was charged.`,
        for_agent: "Read the order back to the person.",
      },
    });
  }

  /**
   * The complete guide for one tool. Reads the static catalogue that shipped
   * with this page, so it makes no request and cannot fail on the network.
   */
  async function getToolGuide(input) {
    const name = typeof input?.tool_name === "string" ? input.tool_name : "";
    const found = toolGuide(name);

    if (!found) {
      return buildEnvelope({
        status: "error",
        resource: { type: "tool_guide", name: name || null, guide: null },
        messages: [
          message(
            "error",
            "not_found",
            "requires_buyer_input",
            "$.tool_name",
            `There is no tool called ${name || "(empty)"} here. Valid names: ${TOOLS.map((tool) => tool.name).join(", ")}.`,
          ),
        ],
        next_actions: computeNextActions(["get_tool_guide"], "get_tool_guide"),
        links: [trustManifestLink()],
        instructions: {
          for_human: null,
          for_agent: "Pick a name from the list in the message and call get_tool_guide again.",
        },
      });
    }

    return buildEnvelope({
      status: "ok",
      resource: { type: "tool_guide", ...found },
      messages: [],
      // A preview has nothing to call, so point at the operational tool its
      // own guide names instead of at itself.
      next_actions: computeNextActions(
        found.operational ? [found.name] : (previewRecovery(found.name) ?? ["search_catalog"]),
        "get_tool_guide",
      ),
      links: [trustManifestLink()],
      instructions: {
        for_human: null,
        for_agent: found.operational
          ? `Read guide.parameters and guide.examples, then call ${found.name}.`
          : `${found.name} is a preview and returns not_available; guide.do_not_use names the tool to use instead.`,
      },
    });
  }

  async function getTrustManifest() {
    const result = await requestJson("GET", TRUST_MANIFEST_PATH);
    if (!result.ok) {
      return apiErrorEnvelope(result, {
        tool: "get_trust_manifest",
        resourceType: "trust_manifest",
      });
    }
    return buildEnvelope({
      status: "ok",
      resource: { type: "trust_manifest", manifest: result.data ?? null },
      messages: [
        message(
          "info",
          "statistics_intentionally_empty",
          "recoverable",
          null,
          "The statistics list is empty on purpose: nothing reaches it until it is individually approved and independently verifiable.",
        ),
      ],
      next_actions: computeNextActions(null, "get_trust_manifest"),
      links: [trustManifestLink()],
      instructions: {
        for_human: "Robodepo publishes what it cannot do: no real charge, no retailer order, no fulfilment.",
        for_agent: "Read manifest.checkout for the sequence and safe error codes.",
      },
    });
  }

  async function submitFeedback(input) {
    const result = await postFeedback({
      kind: "feedback",
      context: {
        checkout_id: input?.context?.checkout_id ?? null,
        order_id: input?.context?.order_id ?? null,
      },
      sentiment: input?.sentiment ?? null,
      free_text: input?.free_text ?? null,
      struggle_points: Array.isArray(input?.struggle_points) ? input.struggle_points : null,
      reason: null,
    });

    if (!result.ok) {
      return apiErrorEnvelope(result, { tool: "submit_feedback", resourceType: "feedback" });
    }

    return buildEnvelope({
      status: "ok",
      resource: {
        type: "feedback",
        feedback_id: result.data?.feedback_id ?? null,
        received_at: result.data?.received_at ?? null,
        stored_as: result.data?.stored_as ?? null,
      },
      messages: [
        message(
          "info",
          "feedback_received",
          "recoverable",
          null,
          "Feedback is kept as data, never as instructions: nothing written here changes how any tool behaves. It carries no personal data and no database record is created.",
        ),
      ],
      next_actions: computeNextActions(null, "submit_feedback"),
      links: [trustManifestLink()],
      instructions: {
        for_human: "Thanks — that is on the record.",
        for_agent: "Carry on with whatever the session state suggests next.",
      },
    });
  }

  function previewResponse(tool) {
    const roadmap = PREVIEW_ROADMAPS[tool.name] ?? null;
    return buildEnvelope({
      status: "not_available",
      resource: { type: "preview", tool: tool.name, built: false, roadmap },
      messages: [
        message(
          "warning",
          "preview_not_built",
          "unrecoverable",
          null,
          `${tool.notBuilt} Robodepo lists it so the direction is visible, and says so rather than returning an empty result that looks real.`,
        ),
        message(
          "info",
          "illustrative_only",
          "recoverable",
          "$.resource.roadmap.illustrative_response",
          "The example below shows the intended shape. It is not live data and nothing here is built yet.",
        ),
      ],
      next_actions: computeNextActions(tool.recover, tool.name),
      links: [trustManifestLink()],
      instructions: {
        for_human: "That part of Robodepo is not built yet.",
        for_agent:
          "Do not retry this tool. resource.roadmap sketches the intended shape and is marked illustrative; use the operational tool named in next_actions instead.",
      },
    });
  }

  const HANDLERS = {
    get_tool_guide: getToolGuide,
    search_catalog: searchCatalog,
    get_product: getProduct,
    create_checkout: createCheckout,
    cancel_checkout: cancelCheckout,
    get_order: getOrder,
    get_trust_manifest: getTrustManifest,
    submit_feedback: submitFeedback,
  };

  function notifyActivity(entry) {
    for (const listener of activityListeners) {
      try {
        listener(entry);
      } catch {
        // A page listener must never break a tool call.
      }
    }
  }

  /** Call a tool by name. Never throws; failures come back as envelopes. */
  async function call(name, input) {
    const tool = TOOLS.find((candidate) => candidate.name === name) ?? null;
    let envelope;

    if (!tool) {
      envelope = buildEnvelope({
        status: "error",
        resource: { type: "preview", tool: name ?? null, built: false },
        messages: [
          message(
            "error",
            "unknown_tool",
            "unrecoverable",
            "$.name",
            `There is no tool called ${String(name)} on this page. Call list() to see the catalogue.`,
          ),
        ],
        next_actions: computeNextActions(["search_catalog"], null),
        links: [trustManifestLink()],
        instructions: {
          for_human: "That capability does not exist here.",
          for_agent: "Pick a tool from the registered catalogue.",
        },
      });
    } else if (tool.kind === "preview") {
      envelope = previewResponse(tool);
    } else {
      try {
        envelope = await HANDLERS[tool.name](input ?? {});
      } catch {
        // The store's own errors already arrive as envelopes; this catches a
        // programming fault in this file and still answers in-shape.
        envelope = buildEnvelope({
          status: "error",
          resource: { type: "preview", tool: tool.name, built: true },
          messages: [
            message(
              "error",
              "tool_layer_failure",
              "recoverable",
              null,
              "This tool layer failed before it reached the store, so nothing changed. Retry the same tool, then report it.",
            ),
          ],
          next_actions: computeNextActions(["self", "submit_feedback"], tool.name),
          links: [trustManifestLink()],
          instructions: {
            for_human: "Something went wrong in the page's tool layer. Nothing was charged.",
            for_agent: "Retry once, then call submit_feedback.",
          },
        });
      }
    }

    notifyActivity({
      at: nowIso(),
      tool: name ?? null,
      status: envelope.status,
    });
    return envelope;
  }

  /** The catalogue as a host would list it. */
  function list() {
    return ORDERED_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      kind: tool.kind,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      guide: tool.guide,
    }));
  }

  /** Open the confirmation page for a prepared checkout, keeping the handle. */
  function openConfirmation(checkoutId) {
    const record = checkoutId
      ? (session.checkouts.get(checkoutId) ?? null)
      : currentCheckout();
    if (!record || !record.confirmation_url) {
      return null;
    }
    session.handoffWindow = deps.openWindow(record.confirmation_url, "robodepo-confirm");
    return session.handoffWindow;
  }

  /**
   * Register every tool with the browser's model context.
   *
   * Chrome 152 exposes `document.modelContext.registerTool(descriptor, {signal})`
   * and no `provideContext`. The guarded fallback below exists only for the
   * older preview shape and is skipped whenever `registerTool` is present.
   */
  async function register() {
    const mc = deps.modelContext ?? defaultModelContext();
    if (!mc) {
      return { available: false, registered: 0 };
    }

    const descriptors = ORDERED_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execute: async (toolInput) => call(tool.name, toolInput),
    }));

    if (typeof mc.registerTool === "function") {
      abortController =
        typeof AbortController === "function" ? new AbortController() : null;
      let registered = 0;
      for (const descriptor of descriptors) {
        try {
          await mc.registerTool(
            descriptor,
            abortController ? { signal: abortController.signal } : undefined,
          );
          registered += 1;
        } catch {
          // One rejected descriptor must not strand the rest.
        }
      }
      return { available: true, registered };
    }

    if (typeof mc.provideContext === "function") {
      try {
        await mc.provideContext({ tools: descriptors });
        return { available: true, registered: descriptors.length };
      } catch {
        return { available: true, registered: 0 };
      }
    }

    return { available: false, registered: 0 };
  }

  function unregister() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  function onActivity(listener) {
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  }

  function getCheckout(checkoutId) {
    const record = checkoutId
      ? (session.checkouts.get(checkoutId) ?? null)
      : currentCheckout();
    return record ? { ...record } : null;
  }

  return {
    list,
    call,
    register,
    unregister,
    onActivity,
    getCheckout,
    openConfirmation,
  };
}

/* ------------------------------------------------------------------------ *
 * The /agent page's own view. It lives here rather than in an inline script
 * because that page's Content-Security-Policy is `script-src 'self'`, which
 * blocks inline script entirely.
 * ------------------------------------------------------------------------ */

const ACTIVITY_LIMIT = 50;

/** Marks where the working tools end and the roadmap ones begin. */
export const PREVIEW_DIVIDER_LABEL = "Preview tools: roadmap only, not for real use";

/** Section order and labels for a rendered guide. */
const GUIDE_SECTIONS = [
  ["summary", "Summary"],
  ["use_when", "When to use it"],
  ["do_not_use", "When not to use it"],
  ["parameters", "Parameters"],
  ["caveats", "Caveats"],
  ["outputs", "Outputs"],
  ["error_recovery", "Error recovery"],
];

/**
 * The full guide behind a disclosure. Built with `textContent` throughout, so
 * nothing in a guide can ever be interpreted as markup.
 */
function renderGuide(doc, tool) {
  const details = doc.createElement("details");
  details.className = "tool-guide";

  const summary = doc.createElement("summary");
  summary.textContent = "Full guide";
  details.append(summary);

  for (const [key, label] of GUIDE_SECTIONS) {
    const text = tool.guide?.[key];
    if (!text) {
      continue;
    }
    const heading = doc.createElement("h4");
    heading.textContent = label;
    const body = doc.createElement("p");
    body.textContent = text;
    details.append(heading, body);
  }

  const examples = tool.guide?.examples ?? [];
  if (examples.length > 0) {
    const heading = doc.createElement("h4");
    heading.textContent = examples.length === 1 ? "Example" : "Examples";
    details.append(heading);
    for (const example of examples) {
      const caption = doc.createElement("p");
      caption.textContent = example.title;
      const block = doc.createElement("pre");
      block.className = "guide-example";
      block.textContent = JSON.stringify(example.input, null, 2);
      details.append(caption, block);
    }
  }

  return details;
}

export function mountAgentPage(tools, doc, registration) {
  const statusNode = doc.getElementById("webmcp-status");
  const listNode = doc.getElementById("tool-list");
  const handoffNode = doc.getElementById("handoff");
  const activityNode = doc.getElementById("activity");
  if (!statusNode || !listNode || !handoffNode || !activityNode) {
    return;
  }

  wireCopyPromptButton(doc);

  const catalogue = tools.list();

  let previewDividerDrawn = false;
  for (const tool of catalogue) {
    const item = doc.createElement("li");

    // The divider between the working tools and the roadmap ones. It is the
    // first child of the first preview rather than an `<li>` of its own so
    // that `#tool-list li` still counts exactly one row per tool; promote it
    // to its own row only alongside the tests that count those rows.
    if (tool.kind === "preview" && !previewDividerDrawn) {
      previewDividerDrawn = true;
      const divider = doc.createElement("p");
      divider.className = "tool-divider";
      divider.textContent = PREVIEW_DIVIDER_LABEL;
      item.append(divider);
    }

    const name = doc.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;
    const badge = doc.createElement("span");
    badge.className = `badge ${tool.kind}`;
    badge.textContent = tool.kind;
    const summary = doc.createElement("p");
    summary.className = "tool-summary";
    // The registered description, whole. It is short by design now, and the
    // rich text it replaced is one disclosure away rather than gone.
    summary.textContent = tool.description;
    item.append(name, badge, summary, renderGuide(doc, tool));
    listNode.append(item);
  }

  // The page markup carries a count; keep it honest against the catalogue.
  const catalogueLabel = listNode.closest
    ? listNode.closest("details")?.querySelector("summary")
    : null;
  if (catalogueLabel) {
    catalogueLabel.textContent = `Tool catalogue (${catalogue.length} tools)`;
  }

  if (registration && registration.available && registration.registered > 0) {
    statusNode.textContent = `WebMCP detected: ${registration.registered} tools registered`;
  } else {
    statusNode.textContent =
      "WebMCP not detected in this browser. Enable chrome://flags/#enable-webmcp-testing in Chrome 149+ and reload. The tools are still listed below and callable from the console via robodepoTools.call(name, input).";
  }

  const entries = [];
  tools.onActivity((entry) => {
    entries.unshift(entry);
    entries.length = Math.min(entries.length, ACTIVITY_LIMIT);
    activityNode.replaceChildren(
      ...entries.map((logged) => {
        const row = doc.createElement("li");
        row.textContent = `${logged.at} · ${logged.tool} · ${logged.status}`;
        return row;
      }),
    );

    const checkout = tools.getCheckout(null);
    if (checkout && checkout.status === "ready_for_complete") {
      renderHandoff(checkout);
    }
  });

  function renderHandoff(checkout) {
    handoffNode.replaceChildren();

    const kicker = doc.createElement("p");
    kicker.className = "eyebrow";
    kicker.textContent = "The moment of truth";

    const heading = doc.createElement("h2");
    heading.textContent = "One decision left, and it isn't the agent's";

    const list = doc.createElement("dl");
    list.className = "handoff";
    const rows = [
      ["Item", `${checkout.title} — ${checkout.variant}`],
      ["Delivery region", checkout.delivery_region ?? "unknown"],
      ["Total", formatAud(checkout.total_cents) ?? "unpriced"],
      ["Expires at", checkout.expires_at ?? "unknown"],
    ];
    for (const [label, value] of rows) {
      const term = doc.createElement("dt");
      term.textContent = label;
      const detail = doc.createElement("dd");
      detail.textContent = value;
      list.append(term, detail);
    }

    const button = doc.createElement("button");
    button.type = "button";
    button.className = "handoff-button";
    button.textContent = "Open approval page";
    button.addEventListener("click", () => {
      tools.openConfirmation(checkout.checkout_id);
    });

    const note = doc.createElement("p");
    note.className = "note";
    note.textContent =
      "The person approves on Robodepo's own page. No tool can submit it.";

    handoffNode.append(kicker, heading, list, button, note);
    handoffNode.hidden = false;
  }
}

/**
 * Wires the "Try the complete journey" copy button, when the page markup
 * provides one. Copies the sample prompt's own `textContent` to the
 * clipboard — never `innerHTML` — and reports success or failure back only
 * through the button's own label, so no extra DOM is created for it.
 */
function wireCopyPromptButton(doc) {
  const button = doc.getElementById("copy-prompt-button");
  const source = doc.getElementById("agent-prompt");
  // Optional page furniture. A page without the prompt block is a page
  // without a copy button, not an error, and the tool list must still render.
  if (!button || !source) {
    return;
  }
  const defaultLabel = button.textContent;
  let resetHandle = null;
  button.addEventListener("click", () => {
    const text = source.textContent;
    const canCopy =
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function";
    const outcome = canCopy
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error("clipboard unavailable"));
    outcome.then(
      () => {
        button.textContent = "Copied";
      },
      () => {
        button.textContent = "Copy failed";
      },
    );
    if (resetHandle) {
      clearTimeout(resetHandle);
    }
    resetHandle = setTimeout(() => {
      button.textContent = defaultLabel;
    }, 2000);
  });
}

/* ------------------------------------------------------------------------ *
 * Auto-registration. Browser only; importing this file under Node does
 * nothing but define the exports above.
 * ------------------------------------------------------------------------ */

if (typeof window !== "undefined") {
  const robodepoTools = createRobodepoTools({});
  window.robodepoTools = robodepoTools;
  robodepoTools.register().then((outcome) => {
    if (typeof document !== "undefined") {
      mountAgentPage(robodepoTools, document, outcome);
    }
  });
}
