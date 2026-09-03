import { describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_ADDRESS,
  CART_CREATE_LIMIT_PER_HOUR,
  OPERATIONAL_TOOL_NAMES,
  PREVIEW_TOOL_NAMES,
  PRODUCT_ID,
  TOOLS,
  IDLE_LABEL,
  ORDERED_TOOLS,
  readConfirmationForm,
  PREVIEW_DIVIDER_LABEL,
  mountAgentPage,
  PREVIEW_PREFIX,
  TOOL_CATALOGUE_JSON,
  approvalUrlFor,
  buildEnvelope,
  createRobodepoTools,
} from "../agent/robodepo-webmcp.js";

type JsonSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

type Guide = {
  summary: string;
  use_when: string;
  do_not_use: string;
  parameters: string;
  caveats: string;
  outputs: string;
  error_recovery: string;
  examples: Array<{ title: string; input: Record<string, unknown> }>;
};

type ToolDescriptor = {
  name: string;
  title: string;
  kind: "operational" | "preview";
  description: string;
  guide: Guide;
  inputSchema: JsonSchema;
  annotations: Record<string, unknown>;
};

/**
 * The registered description is what every host pays context for on every
 * turn, so it is bounded. The Chrome WebMCP best-practices page publishes no
 * number of its own (checked 03-Sep-2026), so these are Robodepo's own limits.
 */
const MAX_DESCRIPTION = 500;
const MAX_PROPERTY_DESCRIPTION = 150;

const GUIDE_FIELDS = [
  "summary",
  "use_when",
  "do_not_use",
  "parameters",
  "caveats",
  "outputs",
  "error_recovery",
] as const;

type Message = {
  type: string;
  code: string;
  severity: string;
  path: string | null;
  content: string;
};

type NextAction = {
  tool: string | null;
  why: string;
  args_hint?: Record<string, unknown>;
};

type Roadmap = {
  what_it_will_do: string;
  planned_inputs: string[];
  planned_output_fields: string[];
  illustrative_response: Record<string, unknown>;
  illustrative: boolean;
};

type Envelope = {
  status: string;
  resource: Record<string, unknown> | null;
  messages: Message[];
  next_actions: NextAction[];
  links: Array<{ type: string; url: string | null }>;
  instructions: { for_human: string | null; for_agent: string | null };
};

const catalogue = TOOLS as unknown as ToolDescriptor[];

const OPERATIONAL = [
  "search_catalog",
  "get_product",
  "create_checkout",
  "cancel_checkout",
  "get_order",
  "get_trust_manifest",
  "submit_feedback",
  "get_tool_guide",
];

const PREVIEW = [
  "search_by_activity",
  "compare_products",
  "get_shipping_options",
  "subscribe_replenishment_alerts",
];

/* ---------------------------------------------------------------------- *
 * A recording fetch. Every response is a plain object queued in order.
 * ---------------------------------------------------------------------- */

type Recorded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: string;
  body: unknown;
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(responses: Response[]) {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      credentials: String(init.credentials),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = responses.shift();
    if (!next) {
      throw new Error(`No queued response for ${init.method ?? "GET"} ${url}`);
    }
    return next;
  };
  return { calls, fetchImpl };
}

const PRODUCT_PAYLOAD = {
  data: {
    product_id: PRODUCT_ID,
    title: "Holiday Bucket - Beige Canvas",
    variant: "L-XL / Beige",
    currency: "AUD",
    source_price_cents: 9900,
    display_price_cents: 11385,
    available: true,
    source: {
      retailer: "Lack of Color",
      url: "https://lackofcolor.com.au/products/holiday-bucket-beige-canvas",
      price_may_differ: true,
      last_checked_at: "2026-08-27T14:08:31Z",
    },
  },
  meta: { request_id: "11111111-1111-4111-8111-111111111111", api_version: "v1" },
};

function checkoutResponses(): Response[] {
  return [
    jsonResponse(201, {
      data: {
        run_id: "run-1",
        cart_id: "cart-1",
        state: "cart_open",
        currency: "AUD",
        product_id: PRODUCT_ID,
        source_last_checked_at: "2026-08-27T14:08:31Z",
        expires_at: "2026-08-28T14:08:31Z",
      },
      meta: { request_id: "r1", api_version: "v1" },
    }),
    jsonResponse(201, {
      data: {
        cart_id: "cart-1",
        state: "cart_open",
        product_id: PRODUCT_ID,
        quantity: 1,
        subtotal_cents: 11385,
        currency: "AUD",
      },
      meta: { request_id: "r2", api_version: "v1" },
    }),
    jsonResponse(200, {
      data: { cart_id: "cart-1", state: "address_applied", delivery_region: "WA 6019" },
      meta: { request_id: "r3", api_version: "v1" },
    }),
    jsonResponse(201, {
      data: {
        cart_id: "cart-1",
        shipping_quote_id: "quote-1",
        service: "standard_sandbox",
        shipping_cents: 1200,
        currency: "AUD",
        expires_at: "2026-08-27T14:23:31Z",
        state: "shipping_quoted",
      },
      meta: { request_id: "r4", api_version: "v1" },
    }),
    jsonResponse(201, {
      data: {
        mandate_id: "mandate-1",
        state: "awaiting_confirmation",
        currency: "AUD",
        item_total_cents: 11385,
        shipping_cents: 1200,
        total_cents: 12585,
        expires_at: "2026-08-27T14:23:31Z",
        confirmation_url: "https://robodepo.shop/confirm/mandate-1",
      },
      meta: { request_id: "r5", api_version: "v1" },
    }),
  ];
}

function goodCheckoutInput(overrides: Record<string, unknown> = {}) {
  return {
    line_items: [{ product_id: PRODUCT_ID, quantity: 1 }],
    shipping_address: { ...ACCEPTED_ADDRESS },
    budget_ceiling_cents: null,
    idempotency_key: null,
    ...overrides,
  };
}

function makeTools(responses: Response[]) {
  const { calls, fetchImpl } = recordingFetch(responses);
  const tools = createRobodepoTools({
    fetch: fetchImpl,
    origin: "",
    now: () => new Date("2026-09-03T02:00:00.000Z"),
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  });
  return { calls, tools };
}

/* ---------------------------------------------------------------------- *
 * Catalogue shape
 * ---------------------------------------------------------------------- */

describe("WebMCP tool catalogue", () => {
  it("registers exactly twelve tools with valid protocol names", () => {
    expect(catalogue).toHaveLength(12);
    for (const tool of catalogue) {
      expect(tool.name, tool.name).toMatch(/^[a-z0-9_]{1,64}$/);
    }
    expect(new Set(catalogue.map((tool) => tool.name)).size).toBe(12);
  });

  it("splits the catalogue into the eight operational and four preview tools", () => {
    expect(catalogue.filter((tool) => tool.kind === "operational").map((t) => t.name)).toEqual(
      OPERATIONAL,
    );
    expect(catalogue.filter((tool) => tool.kind === "preview").map((t) => t.name)).toEqual(
      PREVIEW,
    );
    expect([...OPERATIONAL_TOOL_NAMES]).toEqual(OPERATIONAL);
    expect([...PREVIEW_TOOL_NAMES]).toEqual(PREVIEW);
  });

  it("keeps every registered description short, and pointed at the full guide", () => {
    for (const tool of catalogue) {
      expect(tool.description.length, `${tool.name} description length`).toBeLessThanOrEqual(
        MAX_DESCRIPTION,
      );
      expect(tool.description, tool.name).toContain("Full guide: get_tool_guide");
      expect(tool.description, tool.name).toContain(`/agent/tools.json#${tool.name}`);
      // What it does, and when to use it.
      expect(tool.description, tool.name).toMatch(/(^|\s)Use /);
      // The exclusion. An operational tool names what to use instead; a
      // preview's exclusion is the opener itself — do not call it at all.
      if (tool.kind === "operational") {
        expect(tool.description, tool.name).toContain("Not for");
      } else {
        expect(tool.description, tool.name).toContain("must not be called to do real work");
      }
    }
  });

  it("keeps the whole rich description in the guide, losing nothing", () => {
    for (const tool of catalogue) {
      for (const field of GUIDE_FIELDS) {
        const value = tool.guide[field];
        expect(typeof value, `${tool.name}.guide.${field}`).toBe("string");
        expect(value.trim().length, `${tool.name}.guide.${field}`).toBeGreaterThan(0);
      }
      expect(tool.guide.use_when, tool.name).toContain("Use this when");
      expect(tool.guide.do_not_use, tool.name).toContain("Do not use this for");
      expect(tool.guide.examples.length, tool.name).toBeGreaterThan(0);
      for (const example of tool.guide.examples) {
        expect(typeof example.title, tool.name).toBe("string");
        expect(typeof example.input, tool.name).toBe("object");
      }
    }
  });

  it("bounds every parameter description too", () => {
    for (const tool of catalogue) {
      const walk = (properties: Record<string, unknown> | undefined, path: string) => {
        for (const [key, raw] of Object.entries(properties ?? {})) {
          const value = raw as {
            description?: string;
            properties?: Record<string, unknown>;
            items?: { properties?: Record<string, unknown> };
          };
          expect(typeof value.description, `${path}.${key}`).toBe("string");
          expect(value.description!.length, `${path}.${key}`).toBeLessThanOrEqual(
            MAX_PROPERTY_DESCRIPTION,
          );
          walk(value.properties, `${path}.${key}`);
          walk(value.items?.properties, `${path}.${key}[]`);
        }
      };
      walk(tool.inputSchema.properties, tool.name);
    }
  });

  it("opens every preview description by saying it is not operational", () => {
    for (const tool of catalogue.filter((entry) => entry.kind === "preview")) {
      expect(tool.description.startsWith("Preview — not operational in this demo."), tool.name).toBe(
        true,
      );
      expect(tool.description.startsWith(PREVIEW_PREFIX), tool.name).toBe(true);
      // A judge, and an agent, must both be told it is roadmap only.
      expect(tool.description, tool.name).toContain("Describes the roadmap only");
      expect(tool.description, tool.name).toContain("must not be called to do real work");
    }
    for (const tool of catalogue.filter((entry) => entry.kind === "operational")) {
      expect(tool.description.startsWith("Preview"), tool.name).toBe(false);
    }
  });

  it("uses strict schemas whose every property is required", () => {
    for (const tool of catalogue) {
      const schema = tool.inputSchema;
      expect(schema.type, tool.name).toBe("object");
      expect(schema.additionalProperties, tool.name).toBe(false);
      const properties = Object.keys(schema.properties ?? {});
      expect(schema.required, tool.name).toBeDefined();
      expect([...(schema.required ?? [])].sort(), tool.name).toEqual([...properties].sort());
    }
  });

  it("states all five annotation booleans explicitly on every tool", () => {
    for (const tool of catalogue) {
      for (const hint of [
        "readOnlyHint",
        "untrustedContentHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]) {
        expect(typeof tool.annotations[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });
});

/* ---------------------------------------------------------------------- *
 * Envelope
 * ---------------------------------------------------------------------- */

describe("response envelope", () => {
  it("always carries status, messages and next_actions", async () => {
    const { tools } = makeTools([]);
    const envelope = (await tools.call("search_by_activity", {
      activity: "keep the sun off on a boat",
      constraints: null,
    })) as Envelope;

    expect(typeof envelope.status).toBe("string");
    expect(Array.isArray(envelope.messages)).toBe(true);
    expect(Array.isArray(envelope.next_actions)).toBe(true);
    expect(Array.isArray(envelope.links)).toBe(true);
  });

  it("normalises a partial envelope rather than emitting missing arrays", () => {
    const envelope = buildEnvelope({ status: "ok" }) as Envelope;
    expect(envelope).toEqual({
      status: "ok",
      resource: null,
      messages: [],
      next_actions: [],
      links: [],
      instructions: { for_human: null, for_agent: null },
    });
  });

  it("answers an unknown tool name in shape instead of throwing", async () => {
    const { tools } = makeTools([]);
    const envelope = (await tools.call("complete_checkout", {})) as Envelope;
    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("unknown_tool");
    expect(envelope.next_actions.length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------- *
 * Preview tools
 * ---------------------------------------------------------------------- */

describe("preview tools", () => {
  it("return not_available and point only at operational tools", async () => {
    const { calls, tools } = makeTools([]);

    for (const name of PREVIEW) {
      const envelope = (await tools.call(name, {})) as Envelope;
      expect(envelope.status, name).toBe("not_available");
      expect(envelope.resource, name).toMatchObject({ type: "preview", built: false });
      expect(envelope.messages[0].code, name).toBe("preview_not_built");
      expect(envelope.next_actions.length, name).toBeGreaterThan(0);
      for (const action of envelope.next_actions) {
        if (action.tool !== null) {
          expect(OPERATIONAL, `${name} -> ${action.tool}`).toContain(action.tool);
        }
      }
    }

    // A preview reaches no network at all.
    expect(calls).toHaveLength(0);
  });

  it("shows the intended shape as a labelled sketch, never as live data", async () => {
    const { tools } = makeTools([]);

    for (const name of PREVIEW) {
      const envelope = (await tools.call(name, {})) as Envelope;
      const roadmap = (envelope.resource as { roadmap: Roadmap }).roadmap;

      expect(roadmap, name).toBeDefined();
      expect(roadmap.illustrative, name).toBe(true);
      expect(typeof roadmap.what_it_will_do, name).toBe("string");
      expect(roadmap.planned_inputs.length, name).toBeGreaterThan(0);
      expect(roadmap.planned_output_fields.length, name).toBeGreaterThan(0);
      expect(typeof roadmap.illustrative_response, name).toBe("object");

      const labelled = envelope.messages.find((entry) => entry.code === "illustrative_only");
      expect(labelled, name).toBeDefined();
      expect(labelled?.type, name).toBe("info");
      expect(labelled?.content, name).toBe(
        "The example below shows the intended shape. It is not live data and nothing here is built yet.",
      );

      // The sketch must not smuggle in a fact about anything real.
      const serialised = JSON.stringify(roadmap);
      expect(serialised, name).not.toContain(PRODUCT_ID);
      expect(serialised, name).not.toContain("Lack of Color");
      expect(serialised, name).not.toContain("A$");
    }
  });
});

describe("the catalogue as a document", () => {
  it("prints twelve entries, eight of them operational, with no execute", () => {
    const printed = TOOL_CATALOGUE_JSON() as Array<{
      name: string;
      title: string;
      description: string;
      inputSchema: JsonSchema;
      annotations: Record<string, unknown>;
      operational: boolean;
      guide: Guide;
    }>;

    expect(printed).toHaveLength(12);
    expect(printed.filter((entry) => entry.operational)).toHaveLength(8);
    expect(printed.filter((entry) => !entry.operational)).toHaveLength(4);
    expect(printed.map((entry) => entry.name)).toEqual([...OPERATIONAL, ...PREVIEW]);

    for (const entry of printed) {
      expect(Object.keys(entry).sort(), entry.name).toEqual([
        "annotations",
        "description",
        "guide",
        "inputSchema",
        "name",
        "operational",
        "title",
      ]);
      expect(entry.guide.summary.length, entry.name).toBeGreaterThan(0);
    }
    // It is a document, so it must survive a round trip through JSON.
    expect(JSON.parse(JSON.stringify(printed))).toEqual(printed);
  });
});

/* ---------------------------------------------------------------------- *
 * Reads
 * ---------------------------------------------------------------------- */

describe("catalogue reads", () => {
  it("returns the one-product demo catalogue and says relevance is the agent's call", async () => {
    const { calls, tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);

    const envelope = (await tools.call("search_catalog", {
      query: "a hat for the boat",
      limit: 10,
      response_format: "concise",
    })) as Envelope;

    expect(calls[0].url).toBe(`/api/v1/products/${PRODUCT_ID}`);
    expect(calls[0].credentials).toBe("same-origin");
    expect(envelope.status).toBe("ok");
    expect(envelope.resource).toMatchObject({ type: "listings", catalogue_size: 1 });
    const listings = (envelope.resource as { listings: Array<Record<string, unknown>> }).listings;
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      product_id: PRODUCT_ID,
      display_price_cents: 11385,
      formatted_price: "A$113.85",
      transaction_mode: "sandbox",
    });
    const codes = envelope.messages.map((entry) => entry.code);
    expect(codes).toContain("demo_catalogue");
    expect(envelope.messages[0].content).toContain("relevance is your call");
  });

  it("returns the product record with both prices disclosed", async () => {
    const { tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);

    const envelope = (await tools.call("get_product", {
      product_id: PRODUCT_ID,
      response_format: "detailed",
    })) as Envelope;

    expect(envelope.status).toBe("ok");
    expect(envelope.resource).toMatchObject({
      type: "product",
      source_price_cents: 9900,
      display_price_cents: 11385,
      formatted_price: "A$113.85",
    });
  });

  it("shortens the listing's source disclosure for concise, never drops it", async () => {
    const concise = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
    const conciseEnvelope = (await concise.tools.call("search_catalog", {
      query: "a hat",
      limit: 5,
      response_format: "concise",
    })) as Envelope;
    const conciseListing = (
      conciseEnvelope.resource as { listings: Array<Record<string, unknown>> }
    ).listings[0];

    expect(conciseListing.source).toBeUndefined();
    expect(conciseListing.source_retailer).toBe("Lack of Color");
    expect(conciseListing.price_may_differ).toBe(true);

    const detailed = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
    const detailedEnvelope = (await detailed.tools.call("search_catalog", {
      query: "a hat",
      limit: 5,
      response_format: "detailed",
    })) as Envelope;
    const detailedListing = (
      detailedEnvelope.resource as { listings: Array<Record<string, unknown>> }
    ).listings[0];

    expect(detailedListing.source).toEqual({
      retailer: "Lack of Color",
      url: "https://lackofcolor.com.au/products/holiday-bucket-beige-canvas",
      price_may_differ: true,
      last_checked_at: "2026-08-27T14:08:31Z",
    });
    expect(detailedListing.source_retailer).toBeUndefined();

    // The two formats differ in depth only. Whatever the caller asks for, the
    // retailer is named and the price-may-differ warning survives.
    expect(JSON.stringify(conciseListing)).toContain("Lack of Color");
    expect(JSON.stringify(detailedListing)).toContain("Lack of Color");
    expect(JSON.stringify(conciseListing)).toContain("price_may_differ");
    expect(JSON.stringify(detailedListing)).toContain("price_may_differ");
    expect(conciseListing.display_price_cents).toBe(detailedListing.display_price_cents);
  });

  it("applies the same response_format rule to a single product record", async () => {
    const concise = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
    const conciseResource = (
      (await concise.tools.call("get_product", {
        product_id: PRODUCT_ID,
        response_format: "concise",
      })) as Envelope
    ).resource as Record<string, unknown>;

    expect(conciseResource.source).toBeUndefined();
    expect(conciseResource.source_retailer).toBe("Lack of Color");
    expect(conciseResource.price_may_differ).toBe(true);
    // The price disclosure is the point of this tool, so it survives both.
    expect(conciseResource.source_price_cents).toBe(9900);
    expect(conciseResource.display_price_cents).toBe(11385);

    const detailed = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
    const detailedResource = (
      (await detailed.tools.call("get_product", {
        product_id: PRODUCT_ID,
        response_format: "detailed",
      })) as Envelope
    ).resource as Record<string, unknown>;

    expect(detailedResource.source).toMatchObject({
      retailer: "Lack of Color",
      url: "https://lackofcolor.com.au/products/holiday-bucket-beige-canvas",
      last_checked_at: "2026-08-27T14:08:31Z",
    });
    expect(detailedResource.source_retailer).toBeUndefined();
    expect(detailedResource.source_price_cents).toBe(9900);
  });

  it("returns the trust manifest whole", async () => {
    const manifest = {
      manifest_version: "1.0.0",
      sandbox: { real_charge: false, source_retailer_order: false, fulfilment: false },
      statistics: { published: [], policy: "No statistic is published..." },
    };
    const { calls, tools } = makeTools([jsonResponse(200, manifest)]);

    const envelope = (await tools.call("get_trust_manifest", {})) as Envelope;

    expect(calls[0].url).toBe("/trust-manifest.json");
    expect(envelope.status).toBe("ok");
    expect(envelope.resource).toEqual({ type: "trust_manifest", manifest });
    expect(envelope.messages[0].code).toBe("statistics_intentionally_empty");
  });
});

/* ---------------------------------------------------------------------- *
 * create_checkout — the hero
 * ---------------------------------------------------------------------- */

describe("create_checkout", () => {
  it("runs the five contract steps in order and hands back a confirmation link", async () => {
    const { calls, tools } = makeTools(checkoutResponses());

    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /api/v1/carts",
      "POST /api/v1/carts/cart-1/items",
      "PUT /api/v1/carts/cart-1/address",
      "POST /api/v1/carts/cart-1/shipping-quotes",
      "POST /api/v1/carts/cart-1/mandates",
    ]);

    for (const call of calls) {
      expect(call.credentials).toBe("same-origin");
      expect(call.headers["Content-Type"]).toBe("application/json");
      const key = call.headers["Idempotency-Key"];
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(key.length).toBeLessThanOrEqual(128);
      // 16-128 printable ASCII, exactly as the contract requires.
      expect(key).toMatch(/^[\x20-\x7e]{16,128}$/);
    }
    expect(new Set(calls.map((call) => call.headers["Idempotency-Key"])).size).toBe(5);

    expect(calls[0].body).toMatchObject({ surface: "webmcp", product_id: PRODUCT_ID });
    expect(calls[1].body).toEqual({ product_id: PRODUCT_ID, quantity: 1 });
    expect(calls[2].body).toEqual({ ...ACCEPTED_ADDRESS });
    expect(calls[3].body).toEqual({});
    // max_total_cents must equal subtotal plus shipping, to the cent.
    expect(calls[4].body).toEqual({
      shipping_quote_id: "quote-1",
      max_total_cents: 11385 + 1200,
    });

    expect(envelope.status).toBe("ready_for_complete");
    expect(envelope.resource).toMatchObject({
      type: "checkout",
      checkout_id: "mandate-1",
      cart_id: "cart-1",
      state: "awaiting_confirmation",
      delivery_region: "WA 6019",
      shipping_service: "standard_sandbox",
      price_may_differ: true,
      // The person is handed the approval page; the plain confirmation page
      // the API itself issued travels alongside it, unchanged.
      confirmation_url: "https://robodepo.shop/approve/mandate-1",
      plain_confirmation_url: "https://robodepo.shop/confirm/mandate-1",
    });
    expect((envelope.resource as { totals: Record<string, unknown> }).totals).toEqual({
      currency: "AUD",
      items_cents: 11385,
      shipping_cents: 1200,
      total_cents: 12585,
      formatted_total: "A$125.85",
    });
    expect(envelope.links).toContainEqual({
      type: "approval_page",
      url: "https://robodepo.shop/approve/mandate-1",
    });
    expect(envelope.links).toContainEqual({
      type: "confirmation_page",
      url: "https://robodepo.shop/confirm/mandate-1",
    });
    expect(envelope.instructions.for_human).toContain("Approve on the Robodepo page");
    expect(envelope.instructions.for_human).toContain("touch once");
    // The run cookie is SameSite=Strict, so an agent that opens the link from
    // a chat sends the person to a page that can only refuse. Say so.
    expect(envelope.instructions.for_agent).toContain("Do not open the approval link yourself");
    expect(envelope.instructions.for_agent).toContain("carries no session");
    expect(envelope.instructions.for_agent).toContain("call get_order with the checkout_id");
  });

  it("carries no person's address, cookie or payment detail back to the agent", async () => {
    const { tools } = makeTools(checkoutResponses());
    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;
    const serialised = JSON.stringify(envelope);

    expect(serialised).not.toContain("__Host-robodepo");
    expect(serialised).not.toContain("pm_card");

    // The invariant: no envelope carries a person's address. The only address
    // that appears anywhere is the published sandbox literal, and only inside
    // an `args_hint` prefill (asserted in the next test). A `resource` gets
    // the delivery region and nothing more.
    const reported = JSON.stringify(envelope.resource);
    expect(reported).not.toContain("10 Example Street");
    expect(reported).not.toContain("Sandbox Buyer");
    expect(reported).not.toContain("Wembley Downs");
    expect(reported).toContain("WA 6019");
  });

  it("prefills the published sandbox address only inside an args_hint", async () => {
    const { tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);

    const envelope = (await tools.call("search_catalog", {
      query: "a hat",
      limit: 5,
      response_format: "concise",
    })) as Envelope;

    // Kept deliberately: it is the non-personal literal the contract publishes,
    // and prefilling it removes the one failure mode an agent cannot reason
    // its way out of. It is never a person's address.
    const hint = envelope.next_actions.find((action) => action.tool === "create_checkout")
      ?.args_hint as { shipping_address: Record<string, unknown> };
    expect(hint.shipping_address).toEqual({ ...ACCEPTED_ADDRESS });

    for (const [label, part] of [
      ["resource", envelope.resource],
      ["messages", envelope.messages],
      ["links", envelope.links],
      ["instructions", envelope.instructions],
    ] as const) {
      expect(JSON.stringify(part), label).not.toContain("10 Example Street");
      expect(JSON.stringify(part), label).not.toContain("Sandbox Buyer");
    }
  });

  it("refuses an address other than the published sandbox one without calling the API", async () => {
    const { calls, tools } = makeTools(checkoutResponses());

    const envelope = (await tools.call(
      "create_checkout",
      goodCheckoutInput({
        shipping_address: {
          recipient_name: "Someone Real",
          line1: "42 Real Road",
          line2: null,
          suburb: "Subiaco",
          state: "WA",
          postcode: "6008",
          country: "AU",
        },
      }),
    )) as Envelope;

    expect(calls).toHaveLength(0);
    expect(envelope.status).toBe("incomplete");
    const problem = envelope.messages.find((entry) => entry.path === "$.shipping_address");
    expect(problem).toBeDefined();
    expect(problem?.severity).toBe("requires_buyer_input");
    expect(problem?.content).toContain("Sandbox Buyer");
    expect(problem?.content).toContain("10 Example Street");
    expect(problem?.content).toContain("Wembley Downs");
    expect(problem?.content).toContain("6019");
    expect(envelope.next_actions.length).toBeGreaterThan(0);
  });

  it("refuses a quantity the tracer does not support without calling the API", async () => {
    const { calls, tools } = makeTools(checkoutResponses());

    const envelope = (await tools.call(
      "create_checkout",
      goodCheckoutInput({ line_items: [{ product_id: PRODUCT_ID, quantity: 2 }] }),
    )) as Envelope;

    expect(calls).toHaveLength(0);
    expect(envelope.status).toBe("incomplete");
    expect(envelope.messages[0].path).toBe("$.line_items[0].quantity");
  });

  it("refuses an idempotency key outside the published bounds", async () => {
    const { calls, tools } = makeTools(checkoutResponses());

    const envelope = (await tools.call(
      "create_checkout",
      goodCheckoutInput({ idempotency_key: "too-short" }),
    )) as Envelope;

    expect(calls).toHaveLength(0);
    expect(envelope.status).toBe("incomplete");
    expect(envelope.messages[0].path).toBe("$.idempotency_key");
  });

  it("warns rather than blocks when the total exceeds the person's ceiling", async () => {
    const { tools } = makeTools(checkoutResponses());

    const envelope = (await tools.call(
      "create_checkout",
      goodCheckoutInput({ budget_ceiling_cents: 9000 }),
    )) as Envelope;

    expect(envelope.status).toBe("ready_for_complete");
    const warning = envelope.messages.find((entry) => entry.code === "budget_exceeded");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("requires_buyer_review");
    expect(warning?.path).toBe("$.resource.totals.total_cents");
    expect(warning?.content).toContain("A$125.85");
    expect(warning?.content).toContain("A$90.00");
  });

  it("maps an API error body to a coded message and never an empty next_actions", async () => {
    const { tools } = makeTools([
      jsonResponse(200, PRODUCT_PAYLOAD),
      jsonResponse(409, {
        error: {
          code: "PRODUCT_UNAVAILABLE",
          message: "Current source variant is unavailable",
          request_id: "req-abc",
        },
      }),
    ]);

    await tools.call("search_catalog", { query: "hat", limit: 5, response_format: "concise" });
    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("out_of_stock");
    expect(envelope.messages[0].severity).toBe("requires_buyer_review");
    expect(envelope.messages[0].content).toContain("create_cart");
    expect(envelope.resource).toMatchObject({
      failed_step: "create_cart",
      request_id: "req-abc",
      api_error_code: "PRODUCT_UNAVAILABLE",
    });
    expect(envelope.next_actions.length).toBeGreaterThan(0);
    expect(envelope.next_actions.map((action) => action.tool)).toContain("search_catalog");
  });

  it("maps a network failure to a recoverable network_error", async () => {
    const tools = createRobodepoTools({
      fetch: async () => {
        throw new Error("connection refused");
      },
      origin: "",
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    });

    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("network_error");
    expect(envelope.messages[0].severity).toBe("recoverable");
    expect(envelope.next_actions.length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------- *
 * cancel_checkout, get_order, submit_feedback
 * ---------------------------------------------------------------------- */

describe("a custom store is what a search returns, and evidence lives on the product", () => {
  const REMOVED = ["create_custom_store", "get_evidence_pack"];

  it("registers neither removed tool anywhere, and mentions neither", () => {
    for (const name of REMOVED) {
      expect(catalogue.map((tool) => tool.name), name).not.toContain(name);
      expect(
        (TOOL_CATALOGUE_JSON() as Array<{ name: string }>).map((entry) => entry.name),
        name,
      ).not.toContain(name);
      // A description or guide that still names a tool nobody can call would
      // send an agent somewhere that does not exist.
      expect(JSON.stringify(catalogue), name).not.toContain(name);
    }
  });

  it("lists exactly the twelve remaining names when a guide lookup misses", async () => {
    const { tools } = makeTools([]);

    const envelope = (await tools.call("get_tool_guide", {
      tool_name: "get_evidence_pack",
    })) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("not_found");
    const named = [...OPERATIONAL, ...PREVIEW].filter((name) =>
      envelope.messages[0].content.includes(name),
    );
    expect(named).toHaveLength(12);
  });

  it("re-describes search_by_activity as the storefront a request returns", () => {
    const tool = catalogue.find((entry) => entry.name === "search_by_activity")!;

    expect(tool.description).toContain("custom storefront");
    expect(tool.description).toContain("checkout-ready shortlist");
    expect(tool.guide.summary).toContain("it is what a search returns");
    expect(tool.guide.caveats).toContain("The full catalogue would stay open");
    expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
  });

  it("shows a storefront, not a result page, in the preview's roadmap", async () => {
    const { tools } = makeTools([]);

    const envelope = (await tools.call("search_by_activity", {
      activity: "keep the sun off on a boat",
      constraints: null,
    })) as Envelope;
    const roadmap = (envelope.resource as { roadmap: Roadmap }).roadmap;

    expect(envelope.status).toBe("not_available");
    expect(roadmap.what_it_will_do).toContain("custom storefront");
    expect(roadmap.planned_output_fields.join(" ")).toContain("chosen_because");
    expect(roadmap.illustrative).toBe(true);
  });

  it("attaches the cited pack when the product has one", async () => {
    const pack = {
      product_id: PRODUCT_ID,
      checked_at: "2026-09-03T00:00:00Z",
      sources: [{ id: "s1" }, { id: "s2" }],
      gaps: ["nothing on packability"],
    };
    const { calls, tools } = makeTools([
      jsonResponse(200, PRODUCT_PAYLOAD),
      jsonResponse(200, pack),
    ]);

    const envelope = (await tools.call("get_product", {
      product_id: PRODUCT_ID,
      response_format: null,
      include_evidence: true,
    })) as Envelope;

    expect(calls.map((call) => call.url)).toEqual([
      `/api/v1/products/${PRODUCT_ID}`,
      `/agent/evidence/${PRODUCT_ID}`,
    ]);
    expect(calls[1].credentials).toBe("same-origin");
    expect((envelope.resource as { evidence: typeof pack }).evidence).toEqual(pack);

    const attached = envelope.messages.find((entry) => entry.code === "evidence_attached");
    expect(attached?.type).toBe("info");
    expect(attached?.path).toBe("$.resource.evidence");
    // The counts have to be read off the pack, never asserted from memory.
    expect(attached?.content).toContain("2 cited sources");
    expect(attached?.content).toContain("2026-09-03T00:00:00Z");
    // An empty section is not a negative answer, and the message says so.
    expect(attached?.content).toContain("not that the answer is no");
  });

  it("says no pack exists rather than returning a product that looks unevidenced", async () => {
    const { tools } = makeTools([
      jsonResponse(200, PRODUCT_PAYLOAD),
      jsonResponse(404, { error: { code: "EVIDENCE_NOT_FOUND", message: "none" } }),
    ]);

    const envelope = (await tools.call("get_product", {
      product_id: PRODUCT_ID,
      response_format: null,
      include_evidence: true,
    })) as Envelope;

    expect(envelope.status).toBe("ok");
    expect(envelope.resource).not.toHaveProperty("evidence");
    const notice = envelope.messages.find(
      (entry) => entry.code === "evidence_not_available",
    );
    expect(notice?.path).toBe("$.include_evidence");
    expect(notice?.content).toContain("Building packs for every product is the roadmap");
  });

  it("asks for no evidence, and fetches nothing extra, when the field is null", async () => {
    const { calls, tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);

    const envelope = (await tools.call("get_product", {
      product_id: PRODUCT_ID,
      response_format: null,
      include_evidence: null,
    })) as Envelope;

    expect(calls).toHaveLength(1);
    expect(envelope.messages.map((entry) => entry.code)).toEqual(["price_disclosure"]);
    expect(envelope.resource).not.toHaveProperty("evidence");
  });

  it("declares include_evidence as a nullable, bounded field that tells the truth", () => {
    const tool = catalogue.find((entry) => entry.name === "get_product")!;
    const property = (tool.inputSchema.properties as Record<string, {
      type: string[];
      description: string;
    }>).include_evidence;

    expect(property.type).toEqual(["boolean", "null"]);
    expect(property.description).toContain("if the product has one");
    expect(property.description).toContain("roadmap");
    expect(property.description.length).toBeLessThanOrEqual(MAX_PROPERTY_DESCRIPTION);
    expect(tool.inputSchema.required).toContain("include_evidence");
    expect(tool.guide.parameters).toContain("returns the cited evidence pack where one exists");
    expect(tool.guide.parameters).toContain("Building packs for every product is the roadmap");
    expect(tool.description).toContain("include_evidence returns the cited evidence pack");
  });
});

/** A confirmation page the store could actually have rendered. */
function confirmationDocument(overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    action: "/api/v1/mandates/mandate-1/confirm",
    csrf: "Y3NyZi12YWx1ZQ",
    idempotency_key: "human-a1B2c3",
    ...overrides,
  };
  return {
    querySelector: (selector: string) =>
      selector !== "form"
        ? null
        : {
            getAttribute: (name: string) => (name === "action" ? fields.action : null),
            querySelector: (inner: string) => {
              const match = /input\[name="([^"]+)"\]/.exec(inner);
              const key = match?.[1] ?? "";
              return key in fields
                ? { getAttribute: (name: string) => (name === "value" ? fields[key] : null) }
                : null;
            },
          },
  };
}

describe("approving from the page itself", () => {
  it("is not a tool, and can never be reached as one", async () => {
    // The whole design refuses an agent taking the irreversible step. This is
    // the assertion that keeps it refused.
    expect(catalogue.map((tool) => tool.name)).not.toContain("approve_checkout");
    expect(catalogue.map((tool) => tool.name)).not.toContain("approveCheckout");
    expect(catalogue.map((tool) => tool.name)).not.toContain("complete_checkout");
    expect(JSON.stringify(TOOL_CATALOGUE_JSON())).not.toContain("approveCheckout");

    const { tools } = makeTools([]);
    const registered: string[] = [];
    const withContext = createRobodepoTools({
      modelContext: {
        registerTool: async (descriptor: { name: string }) => {
          registered.push(descriptor.name);
          return undefined;
        },
      },
    });
    await withContext.register();
    expect(registered).toEqual([...OPERATIONAL, ...PREVIEW]);

    const refused = (await tools.call("approve_checkout", {})) as Envelope;
    expect(refused.status).toBe("error");
    expect(refused.messages[0].code).toBe("unknown_tool");
  });

  it("reads the store's two single-use values and posts exactly them", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const order = {
      order_id: "order-9",
      status: "sandbox_payment_confirmed",
      item: { title: "Holiday Bucket - Beige Canvas", variant: "L-XL / Beige" },
      total_cents: 12585,
      delivery_region: "WA 6019",
    };
    const queue = [
      ...checkoutResponses(),
      new Response("<html><body>the confirmation page</body></html>", { status: 200 }),
      Object.assign(new Response(null, { status: 200 }), {}),
      jsonResponse(200, { data: order, meta: {} }),
    ];
    // `fetch` follows the 303, so the POST's response.url is the order page.
    Object.defineProperty(queue[6], "url", { value: "http://localhost/orders/order-9" });

    const tools = createRobodepoTools({
      fetch: async (url: string, init: Record<string, unknown> = {}) => {
        calls.push({ url, init });
        return queue.shift()!;
      },
      origin: "",
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      parseDocument: () => confirmationDocument(),
      gesture: { available: async () => true, request: async () => true },
    });

    await tools.call("create_checkout", goodCheckoutInput());
    const envelope = (await tools.approveCheckout("mandate-1")) as Envelope;

    const [confirmGet, confirmPost, orderRead] = calls.slice(5);
    expect(confirmGet.url).toBe("/confirm/mandate-1");
    expect(confirmGet.init.credentials).toBe("same-origin");

    expect(confirmPost.url).toBe("/api/v1/mandates/mandate-1/confirm");
    expect(confirmPost.init.method).toBe("POST");
    // The browser adds Origin and Sec-Fetch-Site on a same-origin fetch POST;
    // neither is settable from script. The cookies ride on credentials.
    expect(confirmPost.init.credentials).toBe("same-origin");
    expect(
      (confirmPost.init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(confirmPost.init.body));
    expect(body.get("csrf")).toBe("Y3NyZi12YWx1ZQ");
    expect(body.get("idempotency_key")).toBe("human-a1B2c3");

    expect(orderRead.url).toBe("/api/v1/orders/order-9");
    expect(envelope.status).toBe("completed");
    expect(envelope.resource).toMatchObject({
      order_id: "order-9",
      formatted_total: "A$125.85",
      approved_with_gesture: true,
    });
    expect(envelope.links).toContainEqual({
      type: "order_page",
      url: "/agent/order/order-9",
    });

    // The order is on the record, so get_order by checkout_id now works.
    expect(tools.getCheckout("mandate-1")).toMatchObject({
      order_id: "order-9",
      status: "completed",
    });
  });

  it("fails closed rather than post a page it did not understand", async () => {
    for (const [label, parsed] of [
      ["no form at all", { querySelector: () => null }],
      ["another route's action", confirmationDocument({ action: "/api/v1/mandates/other/confirm" })],
      ["an off-site action", confirmationDocument({ action: "https://elsewhere.test/confirm" })],
      ["a csrf outside the alphabet", confirmationDocument({ csrf: "not a token" })],
      ["a missing issued key", confirmationDocument({ idempotency_key: "" })],
    ] as const) {
      const calls: string[] = [];
      const queue = [
        ...checkoutResponses(),
        new Response("<html></html>", { status: 200 }),
      ];
      const tools = createRobodepoTools({
        fetch: async (url: string) => {
          calls.push(url);
          return queue.shift() ?? new Response(null, { status: 500 });
        },
        origin: "",
        randomUUID: () => "00000000-0000-4000-8000-000000000000",
        parseDocument: () => parsed,
        gesture: { available: async () => false, request: async () => true },
      });

      await tools.call("create_checkout", goodCheckoutInput());
      const envelope = (await tools.approveCheckout("mandate-1")) as Envelope;

      expect(envelope.status, label).toBe("error");
      expect(envelope.messages[0].code, label).toBe("confirmation_unreadable");
      // Nothing was posted anywhere.
      expect(calls.filter((url) => url.includes("/confirm")), label).toEqual([
        "/confirm/mandate-1",
      ]);
      expect(envelope.messages[0].content, label).not.toBe("failed");
      expect(envelope.messages[0].content.length, label).toBeGreaterThan(40);
    }
  });

  it("stops at a refused gesture without ordering anything", async () => {
    const calls: string[] = [];
    const queue = [...checkoutResponses(), new Response("<html></html>", { status: 200 })];
    const tools = createRobodepoTools({
      fetch: async (url: string) => {
        calls.push(url);
        return queue.shift() ?? new Response(null, { status: 500 });
      },
      origin: "",
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      parseDocument: () => confirmationDocument(),
      gesture: {
        available: async () => true,
        request: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });

    await tools.call("create_checkout", goodCheckoutInput());
    const envelope = (await tools.approveCheckout("mandate-1")) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("approval_gesture_incomplete");
    expect(envelope.messages[0].content).toContain("nothing was ordered");
    expect(calls.some((url) => url.includes("/confirm/mandate-1/confirm"))).toBe(false);
    // The standalone page stays offered as the way through.
    expect(envelope.links.some((link) => link.type === "approval_page")).toBe(true);
  });

  it("explains a store refusal instead of saying nothing", async () => {
    const queue = [
      ...checkoutResponses(),
      new Response(null, { status: 409 }),
    ];
    const tools = createRobodepoTools({
      fetch: async () => queue.shift() ?? new Response(null, { status: 500 }),
      origin: "",
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      parseDocument: () => confirmationDocument(),
      gesture: { available: async () => false, request: async () => true },
    });

    await tools.call("create_checkout", goodCheckoutInput());
    const envelope = (await tools.approveCheckout("mandate-1")) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("confirmation_unavailable");
    expect(envelope.messages[0].content).toContain("15 minutes");
  });

  it("refuses a checkout this page never prepared", async () => {
    const { tools } = makeTools([]);
    const envelope = (await tools.approveCheckout("never-made")) as Envelope;
    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("not_found");
  });
});

describe("readConfirmationForm", () => {
  it("returns the action and both values from a page it recognises", () => {
    expect(readConfirmationForm(confirmationDocument(), "mandate-1")).toEqual({
      action: "/api/v1/mandates/mandate-1/confirm",
      csrf: "Y3NyZi12YWx1ZQ",
      idempotencyKey: "human-a1B2c3",
    });
  });

  it("returns null for anything else", () => {
    expect(readConfirmationForm(null, "mandate-1")).toBeNull();
    expect(readConfirmationForm({}, "mandate-1")).toBeNull();
    expect(readConfirmationForm({ querySelector: () => null }, "mandate-1")).toBeNull();
    // The expected action is built from the page's own mandate id, so a page
    // for a different mandate is refused even though it is well-formed.
    expect(readConfirmationForm(confirmationDocument(), "mandate-2")).toBeNull();
  });
});

describe("the published cart budget", () => {
  it("quotes the contract's number from one constant, never a written-down copy", async () => {
    expect(typeof CART_CREATE_LIMIT_PER_HOUR).toBe("number");
    // Mirrors the `cart.create` row of the contract's rate-limits table. This
    // file cannot import server code, so the drift guard is that every
    // sentence quoting it is built from the constant.
    expect(CART_CREATE_LIMIT_PER_HOUR).toBe(30);

    const { tools } = makeTools([
      jsonResponse(429, {
        error: { code: "RATE_LIMITED", message: "too many", request_id: "req-r" },
      }),
    ]);
    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;

    expect(envelope.messages[0].code).toBe("rate_limited");
    expect(envelope.messages[0].content).toContain(
      `limited to ${CART_CREATE_LIMIT_PER_HOUR} per hour`,
    );
    // The figure the tests caught wrong once already.
    expect(envelope.messages[0].content).not.toContain("10 per hour");
  });

  it("states no cart figure in the guide, so there is nothing there to go stale", () => {
    const guide = catalogue.find((tool) => tool.name === "create_checkout")!.guide;
    expect(guide.error_recovery).toContain("`rate_limited` means the cart budget is spent");
    expect(guide.error_recovery).not.toMatch(/cart budget of \d+/);
  });
});

describe("catalogue order", () => {
  /** Where the working tools stop and the roadmap ones start. */
  function boundary(names: string[]): { operational: string[]; preview: string[] } {
    const firstPreview = names.findIndex((name) => PREVIEW.includes(name));
    return {
      operational: names.slice(0, firstPreview),
      preview: names.slice(firstPreview),
    };
  }

  it("puts all eight operational tools before all four previews, everywhere", () => {
    const surfaces: Record<string, string[]> = {
      TOOLS: catalogue.map((tool) => tool.name),
      ORDERED_TOOLS: (ORDERED_TOOLS as unknown as ToolDescriptor[]).map((tool) => tool.name),
      TOOL_CATALOGUE_JSON: (TOOL_CATALOGUE_JSON() as Array<{ name: string }>).map(
        (entry) => entry.name,
      ),
    };

    for (const [surface, names] of Object.entries(surfaces)) {
      expect(names, surface).toEqual([...OPERATIONAL, ...PREVIEW]);
      const { operational, preview } = boundary(names);
      expect(operational, surface).toHaveLength(8);
      expect(preview, surface).toHaveLength(4);
      // No preview may sit above a tool that actually works.
      expect(operational.some((name) => PREVIEW.includes(name)), surface).toBe(false);
      expect(preview.some((name) => OPERATIONAL.includes(name)), surface).toBe(false);
    }
  });

  it("lists and registers in that same order", async () => {
    const { tools } = makeTools([]);
    expect((tools.list() as ToolDescriptor[]).map((tool) => tool.name)).toEqual([
      ...OPERATIONAL,
      ...PREVIEW,
    ]);

    const registered: string[] = [];
    const withContext = createRobodepoTools({
      modelContext: {
        registerTool: async (descriptor: { name: string }) => {
          registered.push(descriptor.name);
          return undefined;
        },
      },
    });
    await withContext.register();
    expect(registered).toEqual([...OPERATIONAL, ...PREVIEW]);
  });

  it("labels the boundary in words, not just position", () => {
    expect(PREVIEW_DIVIDER_LABEL).toBe("Preview tools: roadmap only, not for real use");
  });
});

/**
 * Just enough DOM to mount the page against. Deliberately small: the point is
 * what `mountAgentPage` builds, not what a browser does with it, and the real
 * rendering is covered end to end in Playwright.
 */
type FakeElement = {
  tag: string;
  className: string;
  textContent: string;
  value: string;
  hidden: boolean;
  open: boolean;
  children: FakeElement[];
  append: (...nodes: FakeElement[]) => void;
  replaceChildren: (...nodes: FakeElement[]) => void;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  dispatch: (type: string, event?: unknown) => void;
  closest: () => FakeElement | null;
  classes: Set<string>;
  classList: { toggle: (name: string, force: boolean) => void };
  focused: boolean;
  focus: () => void;
  disabled: boolean;
  id: string;
  href: string;
  type: string;
  dataset: Record<string, string>;
};

function element(tag: string): FakeElement {
  const listeners = new Map<string, (event: unknown) => void>();
  const node: FakeElement = {
    tag,
    className: "",
    textContent: "",
    value: "",
    hidden: false,
    open: false,
    children: [],
    append: (...nodes) => void node.children.push(...nodes),
    replaceChildren: (...nodes) => {
      node.children = [...nodes];
    },
    addEventListener: (type, handler) => void listeners.set(type, handler),
    dispatch: (type, event) => listeners.get(type)?.(event ?? { preventDefault: () => undefined }),
    closest: () => null,
    focused: false,
    focus: () => {
      node.focused = true;
    },
    disabled: false,
    id: "",
    href: "",
    type: "",
    dataset: {},
    classes: new Set<string>(),
    classList: {
      toggle: (name, force) => {
        if (force) {
          node.classes.add(name);
        } else {
          node.classes.delete(name);
        }
      },
    },
  };
  return node;
}

function fakeDocument(present: string[]) {
  const byId = new Map(present.map((id) => [id, element("div")]));
  return {
    byId,
    doc: {
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: (tag: string) => element(tag),
    },
  };
}

function flatten(node: FakeElement): FakeElement[] {
  return [node, ...node.children.flatMap(flatten)];
}

describe("the rendered catalogue", () => {
  const PAGE_IDS = ["webmcp-status", "tool-list", "handoff", "activity"];

  it("draws one divider, once, where the previews begin", () => {
    const { byId, doc } = fakeDocument(PAGE_IDS);
    const { tools } = makeTools([]);

    mountAgentPage(tools, doc, { available: true, registered: 12 });

    const list = byId.get("tool-list")!;
    expect(list.children).toHaveLength(12);

    const dividers = flatten(list).filter((node) => node.className === "tool-divider");
    expect(dividers).toHaveLength(1);
    expect(dividers[0].textContent).toBe(PREVIEW_DIVIDER_LABEL);

    // It belongs to the first preview row, and every row above it works.
    const rowWithDivider = list.children.findIndex((row) =>
      row.children.some((child) => child.className === "tool-divider"),
    );
    expect(rowWithDivider).toBe(OPERATIONAL.length);
    expect(list.children[rowWithDivider].children[0].className).toBe("tool-divider");
  });

  it("shows the short description and the guide behind a disclosure", () => {
    const { byId, doc } = fakeDocument(PAGE_IDS);
    const { tools } = makeTools([]);

    mountAgentPage(tools, doc, { available: false, registered: 0 });

    const list = byId.get("tool-list")!;
    const summaries = flatten(list).filter((node) => node.className === "tool-summary");
    expect(summaries).toHaveLength(12);
    expect(summaries[0].textContent).toBe(catalogue[0].description);
    expect(flatten(list).filter((node) => node.className === "tool-guide")).toHaveLength(12);
  });

  it("says who approves, and that no tool can, on the handoff panel", async () => {
    const { byId, doc } = fakeDocument(PAGE_IDS);
    const handoff = byId.get("handoff")!;
    // The page markup ships this section hidden; it appears only once there
    // is something for a person to approve.
    handoff.hidden = true;

    const { tools } = makeTools(checkoutResponses());
    mountAgentPage(tools, doc, { available: true, registered: 12 });
    expect(handoff.hidden).toBe(true);

    await tools.call("create_checkout", goodCheckoutInput());

    expect(handoff.hidden).toBe(false);
    const note = flatten(handoff).find((node) => node.className === "note");
    expect(note?.textContent).toBe(
      "The human approves on Robodepo's own page. No tool can do it for them.",
    );
    // The panel shows what will be ordered, and no address.
    const serialised = JSON.stringify(flatten(handoff).map((node) => node.textContent));
    expect(serialised).toContain("WA 6019");
    expect(serialised).toContain("A$125.85");
    expect(serialised).not.toContain("10 Example Street");
  });

  it("shows the live call, opens the log, and goes quiet when nothing happens", async () => {
    vi.useFakeTimers();
    try {
      const { byId, doc } = fakeDocument([...PAGE_IDS, "live-call"]);
      const log = element("details");
      byId.get("activity")!.closest = () => log;

      const { tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
      mountAgentPage(tools, doc, { available: true, registered: 12 });

      const live = byId.get("live-call")!;
      expect(log.open).toBe(false);

      await tools.call("search_catalog", {
        query: "sun hat",
        limit: 5,
        response_format: null,
      });

      // The log opens itself, so a person watching need not know to expand it.
      expect(log.open).toBe(true);
      expect(live.textContent).toContain("search_catalog");
      expect(live.textContent).toContain("→ ok");
      expect(live.textContent).toMatch(/\d+s$/);
      expect(live.classes.has("is-active")).toBe(true);

      // And it goes quiet again rather than leaving a stale call on screen.
      vi.advanceTimersByTime(29_000);
      expect(live.textContent).toContain("search_catalog");
      vi.advanceTimersByTime(2_000);
      expect(live.textContent).toBe(IDLE_LABEL);
      // The styling must not outlast the fact it was styling.
      expect(live.classes.has("is-active")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts the declarative form to the same endpoint the tool uses", async () => {
    const posted: Array<{ url: string; init: RequestInit }> = [];
    const stub = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: unknown, init: unknown) => {
        posted.push({ url: String(url), init: init as RequestInit });
        return jsonResponse(201, {
          data: { feedback_id: "fb-form-1", received_at: "now", stored_as: "server_log" },
          meta: { api_version: "agent-preview" },
        });
      });

    try {
      const { byId, doc } = fakeDocument([
        ...PAGE_IDS,
        "feedback-form",
        "feedback-result",
        "feedback-sentiment",
        "feedback-struggle",
        "feedback-text",
      ]);
      byId.get("feedback-sentiment")!.value = "negative";
      byId.get("feedback-struggle")!.value = "address_rejected";
      byId.get("feedback-text")!.value = "  The accepted address was not obvious.  ";

      const { tools } = makeTools([]);
      mountAgentPage(tools, doc, { available: true, registered: 12 });

      let prevented = false;
      byId.get("feedback-form")!.dispatch("submit", {
        preventDefault: () => {
          prevented = true;
        },
      });
      await vi.waitFor(() => expect(posted.length).toBe(1));

      expect(prevented).toBe(true);
      expect(posted[0].url).toBe("/api/agent/feedback");
      expect(posted[0].init.method).toBe("POST");
      expect(posted[0].init.credentials).toBe("same-origin");
      expect(JSON.parse(String(posted[0].init.body))).toEqual({
        kind: "feedback",
        context: { checkout_id: null, order_id: null },
        sentiment: "negative",
        free_text: "The accepted address was not obvious.",
        struggle_points: ["address_rejected"],
        reason: null,
      });

      await vi.waitFor(() =>
        expect(byId.get("feedback-result")!.textContent).toContain("fb-form-1"),
      );
    } finally {
      stub.mockRestore();
    }
  });

  it("sends nothing empty, and says so", async () => {
    const stub = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("must not be called");
    });
    try {
      const { byId, doc } = fakeDocument([
        ...PAGE_IDS,
        "feedback-form",
        "feedback-result",
        "feedback-sentiment",
        "feedback-struggle",
        "feedback-text",
      ]);
      byId.get("feedback-text")!.value = "   ";

      const { tools } = makeTools([]);
      mountAgentPage(tools, doc, { available: true, registered: 12 });
      byId.get("feedback-form")!.dispatch("submit");

      expect(stub).not.toHaveBeenCalled();
      expect(byId.get("feedback-result")!.textContent).toContain("Say what happened first");
    } finally {
      stub.mockRestore();
    }
  });

  it("brings the panel into view and puts the keyboard on the approve button", async () => {
    const { byId, doc } = fakeDocument(PAGE_IDS);
    const handoff = byId.get("handoff")!;
    handoff.hidden = true;
    let scrolled = false;
    (handoff as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      scrolled = true;
    };

    const { tools } = makeTools(checkoutResponses());
    mountAgentPage(tools, doc, { available: true, registered: 12 });
    await tools.call("create_checkout", goodCheckoutInput());

    // Neither needs a user gesture, and the panel is the thing to look at now.
    expect(scrolled).toBe(true);
    const button = flatten(handoff).find((node) => node.className === "handoff-button")!;
    expect(button.focused).toBe(true);
    // No platform authenticator in this fixture, so neither the label nor the
    // class may promise a fingerprint.
    expect(button.textContent).toBe("Approve this sandbox purchase");
    expect(button.classes.has("has-fingerprint")).toBe(false);
    // The standalone page stays offered next to it.
    const secondary = flatten(handoff).find(
      (node) => node.className === "handoff-secondary",
    );
    expect(secondary).toBeDefined();
    expect(flatten(handoff).some((node) => node.className === "handoff-status")).toBe(true);
  });

  it("marks the approve button only where the device really has a fingerprint", async () => {
    const { byId, doc } = fakeDocument(PAGE_IDS);
    const handoff = byId.get("handoff")!;
    const { calls, fetchImpl } = recordingFetch(checkoutResponses());
    const tools = createRobodepoTools({
      fetch: fetchImpl,
      origin: "",
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      gesture: { available: async () => true, request: async () => true },
    });

    mountAgentPage(tools, doc, { available: true, registered: 12 });
    await tools.call("create_checkout", goodCheckoutInput());
    // The label is set from a promise, so let it settle.
    await vi.waitFor(() => {
      const node = flatten(handoff).find((entry) => entry.className === "handoff-button")!;
      expect(node.textContent).toBe("Approve with fingerprint or face");
    });

    const button = flatten(handoff).find((node) => node.className === "handoff-button")!;
    expect(button.classes.has("has-fingerprint")).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it("mounts without the feedback form or the live strip", () => {
    const { byId, doc } = fakeDocument(PAGE_IDS);
    const { tools } = makeTools([]);

    expect(() =>
      mountAgentPage(tools, doc, { available: true, registered: 12 }),
    ).not.toThrow();
    expect(byId.get("tool-list")!.children).toHaveLength(12);
  });

  it("renders the whole page when the sample-prompt block is absent", () => {
    // The prompt block is page furniture the design may drop at any time; its
    // absence must not cost the tool list.
    const { byId, doc } = fakeDocument(PAGE_IDS);
    const { tools } = makeTools([]);

    expect(() =>
      mountAgentPage(tools, doc, { available: true, registered: 12 }),
    ).not.toThrow();
    expect(byId.get("tool-list")!.children).toHaveLength(12);
    expect(byId.get("webmcp-status")!.textContent).toContain("12 tools registered");
  });
});

describe("get_tool_guide", () => {
  it("returns one tool's complete guide without touching the network", async () => {
    const { calls, tools } = makeTools([]);

    const envelope = (await tools.call("get_tool_guide", {
      tool_name: "create_checkout",
    })) as Envelope;

    expect(calls).toHaveLength(0);
    expect(envelope.status).toBe("ok");
    const resource = envelope.resource as {
      type: string;
      name: string;
      operational: boolean;
      guide: Guide;
    };
    expect(resource.type).toBe("tool_guide");
    expect(resource.name).toBe("create_checkout");
    expect(resource.operational).toBe(true);
    for (const field of GUIDE_FIELDS) {
      expect(resource.guide[field].length, field).toBeGreaterThan(0);
    }
    expect(resource.guide.examples[0].input).toHaveProperty("line_items");
    expect(envelope.next_actions.map((action) => action.tool)).toContain("create_checkout");
  });

  it("says a preview is a preview and names the tool to use instead", async () => {
    const { tools } = makeTools([]);

    const envelope = (await tools.call("get_tool_guide", {
      tool_name: "search_by_activity",
    })) as Envelope;

    const resource = envelope.resource as { operational: boolean; guide: Guide };
    expect(envelope.status).toBe("ok");
    expect(resource.operational).toBe(false);
    expect(envelope.instructions.for_agent).toContain("returns not_available");
    // Never point an agent back at a tool that cannot do the work.
    expect(envelope.next_actions.map((action) => action.tool)).not.toContain(
      "search_by_activity",
    );
    for (const action of envelope.next_actions) {
      if (action.tool !== null) {
        expect(OPERATIONAL).toContain(action.tool);
      }
    }
  });

  it("refuses an unknown name with the list of valid ones", async () => {
    const { tools } = makeTools([]);

    const envelope = (await tools.call("get_tool_guide", {
      tool_name: "complete_checkout",
    })) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("not_found");
    expect(envelope.messages[0].path).toBe("$.tool_name");
    for (const name of [...OPERATIONAL, ...PREVIEW]) {
      expect(envelope.messages[0].content, name).toContain(name);
    }
    expect(envelope.next_actions.length).toBeGreaterThan(0);
  });

  it("returns the same guide the catalogue document publishes", () => {
    const printed = TOOL_CATALOGUE_JSON() as Array<{ name: string; guide: Guide }>;
    for (const tool of catalogue) {
      const document = printed.find((entry) => entry.name === tool.name);
      expect(document?.guide, tool.name).toEqual(tool.guide);
    }
  });
});

describe("response_format", () => {
  it("defaults to concise when the property is null or absent", async () => {
    for (const input of [
      { product_id: PRODUCT_ID, response_format: null },
      { product_id: PRODUCT_ID },
    ]) {
      const { tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
      const resource = ((await tools.call("get_product", input)) as Envelope)
        .resource as Record<string, unknown>;

      expect(resource.source, JSON.stringify(input)).toBeUndefined();
      expect(resource.source_retailer, JSON.stringify(input)).toBe("Lack of Color");
      expect(resource.price_may_differ, JSON.stringify(input)).toBe(true);
    }
  });

  it("still returns the full source block when detail is asked for", async () => {
    const { tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
    const resource = ((await tools.call("get_product", {
      product_id: PRODUCT_ID,
      response_format: "detailed",
    })) as Envelope).resource as Record<string, unknown>;

    expect(resource.source).toBeDefined();
    expect(resource.source_retailer).toBeUndefined();
  });

  it("keeps an ordinary read small enough to be worth an agent's context", async () => {
    const sizes: Record<string, number> = {};
    for (const [name, input, payload] of [
      ["search_catalog", { query: "sun hat", limit: 5, response_format: null }, PRODUCT_PAYLOAD],
      ["get_product", { product_id: PRODUCT_ID, response_format: null }, PRODUCT_PAYLOAD],
    ] as const) {
      const { tools } = makeTools([jsonResponse(200, payload)]);
      sizes[name] = JSON.stringify(await tools.call(name, input)).length;
    }
    // A budget, not a cliff: the remaining bulk is create_checkout's
    // args_hint, which prefills the one accepted sandbox address on purpose.
    for (const [name, size] of Object.entries(sizes)) {
      expect(size, `${name} serialised ${size}`).toBeLessThan(1_600);
    }
  });
});

describe("the approval handoff", () => {
  it("builds the approval url on the origin the store issued, never another", async () => {
    const { tools } = makeTools(checkoutResponses());
    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;
    const resource = envelope.resource as Record<string, string>;

    expect(new URL(resource.confirmation_url).origin).toBe(
      new URL(resource.plain_confirmation_url).origin,
    );
    expect(new URL(resource.confirmation_url).pathname).toBe("/approve/mandate-1");
    expect(new URL(resource.plain_confirmation_url).pathname).toBe("/confirm/mandate-1");
  });

  it("falls back to this page's own origin when the store returns a relative link", () => {
    expect(approvalUrlFor("/confirm/m-1", "m-1", "")).toBe("/approve/m-1");
    expect(approvalUrlFor(null, "m-1", "https://example.test")).toBe(
      "https://example.test/approve/m-1",
    );
  });

  it("tells the truth about what the biometric touch does and does not do", () => {
    const createCheckout = catalogue.find((tool) => tool.name === "create_checkout");
    // The short description says who approves; the guide carries the whole
    // claim, including what the gesture is not.
    expect(createCheckout?.description).toContain(
      "the person approves on the Robodepo page",
    );
    // A "sandbox" an agent reads as "no purchase possible" is a refusal
    // waiting to happen, so the description says what it actually means.
    expect(createCheckout?.description).toContain("Use when asked to buy, purchase or order");
    expect(createCheckout?.description).toContain(
      "sandbox means a Stripe test-mode order the human can safely approve",
    );
    expect(createCheckout?.guide.use_when).toContain(
      "preparing a checkout is the expected response to a purchase request",
    );
    for (const name of ["search_catalog", "get_product"]) {
      const tool = catalogue.find((entry) => entry.name === name)!;
      expect(tool.description, name).toContain(
        "Sandbox orders are safe to prepare; use create_checkout when asked to buy.",
      );
      expect(tool.guide.use_when, name).toContain("rather than declining");
    }
    expect(createCheckout?.guide.outputs).toContain("one biometric touch");
    expect(createCheckout?.guide.outputs).toContain("adds no server-side authority");
    expect(createCheckout?.guide.outputs).toContain("single-use CSRF value");
    expect(createCheckout?.guide.outputs).toContain("No tool can submit either page");
  });
});

describe("cancel_checkout", () => {
  it("closes a known checkout and records the decline as feedback", async () => {
    const { calls, tools } = makeTools([
      ...checkoutResponses(),
      jsonResponse(201, {
        data: {
          feedback_id: "fb-1",
          received_at: "2026-09-03T02:00:00.000Z",
          stored_as: "server_log",
        },
        meta: { api_version: "agent-preview" },
      }),
    ]);

    await tools.call("create_checkout", goodCheckoutInput());
    const envelope = (await tools.call("cancel_checkout", {
      checkout_id: "mandate-1",
      reason: "Over the person's ceiling",
    })) as Envelope;

    const declineCall = calls[calls.length - 1];
    expect(declineCall.url).toBe("/api/agent/feedback");
    expect(declineCall.method).toBe("POST");
    expect(declineCall.body).toMatchObject({
      kind: "checkout_declined",
      context: { checkout_id: "mandate-1", order_id: null },
      reason: "Over the person's ceiling",
    });

    expect(envelope.status).toBe("canceled");
    expect(envelope.resource).toMatchObject({
      checkout_id: "mandate-1",
      state: "canceled",
      feedback_recorded: true,
    });
    expect(envelope.messages[0].content).toContain("no server-side cancel route");
  });

  it("reports an unknown checkout id as not_found with a way forward", async () => {
    const { tools } = makeTools([]);

    const envelope = (await tools.call("cancel_checkout", {
      checkout_id: "never-created",
      reason: null,
    })) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.messages[0].code).toBe("not_found");
    expect(envelope.next_actions.map((action) => action.tool)).toContain("create_checkout");
  });
});

describe("get_order", () => {
  it("returns the order envelope for a known order id", async () => {
    const order = {
      order_id: "order-1",
      run_id: "run-1",
      status: "sandbox_payment_confirmed",
      currency: "AUD",
      item: {
        product_id: PRODUCT_ID,
        title: "Holiday Bucket - Beige Canvas",
        variant: "L-XL / Beige",
        quantity: 1,
        unit_price_cents: 11385,
      },
      shipping_cents: 1200,
      total_cents: 12585,
      delivery_region: "WA 6019",
      created_at: "2026-09-03T02:00:00.000Z",
    };
    const { calls, tools } = makeTools([
      jsonResponse(200, { data: order, meta: { request_id: "r", api_version: "v1" } }),
    ]);

    const envelope = (await tools.call("get_order", {
      order_id: "order-1",
      checkout_id: null,
    })) as Envelope;

    expect(calls[0].url).toBe("/api/v1/orders/order-1");
    expect(envelope.status).toBe("completed");
    expect(envelope.resource).toMatchObject({
      type: "order",
      order_id: "order-1",
      total_cents: 12585,
      formatted_total: "A$125.85",
      delivery_region: "WA 6019",
    });
    // Robodepo's readable page first, the store's own record alongside it.
    expect(envelope.links).toContainEqual({
      type: "order_page",
      url: "/agent/order/order-1",
    });
    expect(envelope.links).toContainEqual({
      type: "order_record",
      url: "/orders/order-1",
    });
  });

  it("waits for the person rather than calling it an error", async () => {
    const { calls, tools } = makeTools(checkoutResponses());

    await tools.call("create_checkout", goodCheckoutInput());
    const before = calls.length;
    const envelope = (await tools.call("get_order", {
      order_id: null,
      checkout_id: "mandate-1",
    })) as Envelope;

    expect(calls).toHaveLength(before);
    expect(envelope.status).toBe("awaiting_human_confirmation");
    expect(envelope.links).toContainEqual({
      type: "approval_page",
      url: "https://robodepo.shop/approve/mandate-1",
    });
    expect(envelope.links).toContainEqual({
      type: "confirmation_page",
      url: "https://robodepo.shop/confirm/mandate-1",
    });
    expect(envelope.instructions.for_human).toContain("Nothing is charged");
  });

  it("does not send the agent round a loop a new checkout cannot close", async () => {
    for (const [code, expected] of [
      ["RUN_AUTH_REQUIRED", "run_authority_missing"],
      ["NOT_FOUND", "not_found"],
    ] as const) {
      const { tools } = makeTools([
        jsonResponse(code === "NOT_FOUND" ? 404 : 401, {
          error: { code, message: "safe", request_id: "req-x" },
        }),
      ]);

      const envelope = (await tools.call("get_order", {
        order_id: "order-1",
        checkout_id: null,
      })) as Envelope;

      expect(envelope.status, code).toBe("error");
      expect(envelope.messages[0].code, code).toBe(expected);
      // An order belongs to the run that created it; a new checkout issues a
      // new run and cannot reach it, so create_checkout must not lead here.
      expect(envelope.next_actions.map((action) => action.tool), code).toEqual([
        "submit_feedback",
        "search_catalog",
      ]);
    }
  });

  it("keeps the shared mapping for tools a new checkout really can fix", async () => {
    const { tools } = makeTools([
      jsonResponse(401, {
        error: { code: "RUN_AUTH_REQUIRED", message: "safe", request_id: "req-y" },
      }),
    ]);

    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;

    expect(envelope.next_actions[0].tool).toBe("create_checkout");
  });

  it("says in its guide what its envelopes actually do", () => {
    const getOrder = catalogue.find((tool) => tool.name === "get_order");
    expect(getOrder?.guide.error_recovery).toContain(
      "a new checkout issues a new run rather than recovering the old one",
    );
    expect(getOrder?.guide.error_recovery).toContain(
      "`submit_feedback` is the honest next step",
    );
  });

  it("recognises either readback when polling the handoff window", async () => {
    const order = {
      order_id: "order-1",
      status: "sandbox_payment_confirmed",
      total_cents: 12585,
      delivery_region: "WA 6019",
    };

    for (const pathname of ["/orders/order-1", "/agent/order/order-1"]) {
      const { calls, fetchImpl } = recordingFetch([
        ...checkoutResponses(),
        jsonResponse(200, { data: order, meta: {} }),
      ]);
      const tools = createRobodepoTools({
        fetch: fetchImpl,
        origin: "",
        randomUUID: () => "00000000-0000-4000-8000-000000000000",
        // The approval page can land on either page, so a poll must read both.
        openWindow: () => ({ location: { pathname } }),
      });

      await tools.call("create_checkout", goodCheckoutInput());
      tools.openConfirmation("mandate-1");
      const envelope = (await tools.call("get_order", {
        order_id: null,
        checkout_id: "mandate-1",
      })) as Envelope;

      expect(envelope.status, pathname).toBe("completed");
      expect(calls[calls.length - 1].url, pathname).toBe("/api/v1/orders/order-1");
    }
  });

  it("needs at least one identifier", async () => {
    const { tools } = makeTools([]);
    const envelope = (await tools.call("get_order", {
      order_id: null,
      checkout_id: null,
    })) as Envelope;

    expect(envelope.status).toBe("incomplete");
    expect(envelope.messages[0].path).toBe("$.order_id");
  });
});

describe("submit_feedback", () => {
  it("posts to the feedback endpoint and returns the acknowledgement", async () => {
    const { calls, tools } = makeTools([
      jsonResponse(201, {
        data: {
          feedback_id: "fb-9",
          received_at: "2026-09-03T02:00:00.000Z",
          stored_as: "server_log",
        },
        meta: { api_version: "agent-preview" },
      }),
    ]);

    const envelope = (await tools.call("submit_feedback", {
      context: { checkout_id: null, order_id: null },
      sentiment: "positive",
      free_text: "The checkout tool did the whole path in one call.",
      struggle_points: [],
    })) as Envelope;

    expect(calls[0].url).toBe("/api/agent/feedback");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].credentials).toBe("same-origin");
    expect(calls[0].body).toMatchObject({ kind: "feedback", sentiment: "positive" });
    expect(envelope.status).toBe("ok");
    expect(envelope.resource).toMatchObject({ type: "feedback", feedback_id: "fb-9" });
  });
});

/* ---------------------------------------------------------------------- *
 * next_actions are computed from state
 * ---------------------------------------------------------------------- */

describe("next_actions computed from state", () => {
  it("rule 1: with no checkout, points at the catalogue", async () => {
    const { tools } = makeTools([jsonResponse(200, PRODUCT_PAYLOAD)]);
    const envelope = (await tools.call("get_trust_manifest", {})) as Envelope;
    expect(envelope.next_actions.map((action) => action.tool)).toEqual([
      "search_catalog",
      "get_product",
    ]);
  });

  it("rule 2: a ready checkout puts the human handoff first", async () => {
    const { tools } = makeTools(checkoutResponses());
    const envelope = (await tools.call("create_checkout", goodCheckoutInput())) as Envelope;

    const [handoff, ...rest] = envelope.next_actions as Array<
      NextAction & { action?: string; url?: string }
    >;
    expect(handoff.tool).toBeNull();
    expect(handoff.action).toBe("open_confirmation_page");
    expect(handoff.url).toBe("https://robodepo.shop/approve/mandate-1");
    expect(handoff.why).toContain("Fallback only");
    expect(handoff.why).toContain("a link opened from a chat will not carry the session");
    expect(rest.map((action) => action.tool)).toEqual(["cancel_checkout", "submit_feedback"]);
  });

  it("rule 3: once an order is known, points at reading it back", async () => {
    const order = {
      order_id: "order-1",
      status: "sandbox_payment_confirmed",
      total_cents: 12585,
      delivery_region: "WA 6019",
    };
    const { tools } = makeTools([
      ...checkoutResponses(),
      jsonResponse(200, { data: order, meta: { request_id: "r", api_version: "v1" } }),
      jsonResponse(200, PRODUCT_PAYLOAD),
    ]);

    await tools.call("create_checkout", goodCheckoutInput());
    await tools.call("get_order", { order_id: "order-1", checkout_id: "mandate-1" });
    const envelope = (await tools.call("get_product", {
      product_id: PRODUCT_ID,
      response_format: "concise",
    })) as Envelope;

    // get_product declares its own recovery route, so the state rule is read
    // from a tool that computes purely from session state.
    expect(envelope.next_actions.map((action) => action.tool)).toContain("create_checkout");

    const manifestTools = makeTools([
      ...checkoutResponses(),
      jsonResponse(200, { data: order, meta: { request_id: "r", api_version: "v1" } }),
      jsonResponse(200, { manifest_version: "1.0.0" }),
    ]);
    await manifestTools.tools.call("create_checkout", goodCheckoutInput());
    await manifestTools.tools.call("get_order", { order_id: "order-1", checkout_id: "mandate-1" });
    const afterOrder = (await manifestTools.tools.call("get_trust_manifest", {})) as Envelope;
    expect(afterOrder.next_actions.map((action) => action.tool)).toEqual([
      "get_order",
      "submit_feedback",
    ]);
  });

  it("rule 4: a canceled checkout points back at the catalogue and feedback", async () => {
    const { tools } = makeTools([
      ...checkoutResponses(),
      jsonResponse(201, {
        data: { feedback_id: "fb-1", received_at: "now", stored_as: "server_log" },
        meta: { api_version: "agent-preview" },
      }),
    ]);

    await tools.call("create_checkout", goodCheckoutInput());
    const envelope = (await tools.call("cancel_checkout", {
      checkout_id: "mandate-1",
      reason: null,
    })) as Envelope;

    expect(envelope.next_actions.map((action) => action.tool)).toEqual([
      "search_catalog",
      "submit_feedback",
    ]);
  });

  it("rule 5: an error always offers a route out, ending in feedback", async () => {
    const { tools } = makeTools([
      jsonResponse(503, {
        error: {
          code: "PRODUCT_STALE",
          message: "No fresh snapshot",
          request_id: "req-stale",
        },
      }),
    ]);

    const envelope = (await tools.call("get_product", {
      product_id: PRODUCT_ID,
      response_format: "concise",
    })) as Envelope;

    expect(envelope.status).toBe("error");
    expect(envelope.next_actions.length).toBeGreaterThan(0);
    expect(envelope.next_actions[0].tool).toBe("get_product");
    expect(envelope.next_actions[envelope.next_actions.length - 1].tool).toBe("submit_feedback");
  });
});

/* ---------------------------------------------------------------------- *
 * Registration
 * ---------------------------------------------------------------------- */

describe("registration", () => {
  it("registers every tool against a Chrome-shaped model context", async () => {
    const registered: Array<{
      name: string;
      description: string;
      execute: unknown;
      guide?: unknown;
    }> = [];
    const { tools } = makeTools([]);
    const withContext = createRobodepoTools({
      fetch: async () => jsonResponse(200, {}),
      modelContext: {
        registerTool: async (descriptor: {
          name: string;
          description: string;
          execute: unknown;
        }) => {
          registered.push(descriptor);
          return undefined;
        },
      },
    });

    const outcome = await withContext.register();

    expect(outcome).toEqual({ available: true, registered: 12 });
    expect(registered.map((entry) => entry.name)).toEqual([...OPERATIONAL, ...PREVIEW]);
    // Only the short description is registered; the guide is not shipped to
    // the host on every turn.
    for (const entry of registered) {
      expect(entry.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
      expect(entry.guide).toBeUndefined();
    }
    for (const entry of registered) {
      expect(typeof entry.execute).toBe("function");
    }
    expect(tools.list()).toHaveLength(12);
  });

  it("reports honestly when the browser has no model context", async () => {
    const { tools } = makeTools([]);
    expect(await tools.register()).toEqual({ available: false, registered: 0 });
  });
});
