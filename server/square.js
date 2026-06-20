// Liar's Ledger - server/providers/square.js
//
// Square API integration following SQUAREDESIGN.md.
//
// Flow summary:
//   1. pricing.html POSTs { token } to /pricing/checkout
//   2. /pricing/checkout calls createPaymentLink() — embeds the anonymous token
//      as order.reference_id on a Square-hosted checkout for a subscription
//   3. Square hosted page: buyer enters card + contact info (Square collects,
//      we never see it). Subscription created, invoice sent to buyer.
//   4. subscription.created webhook fires:
//        phases[0].order_template_id → resolveTokenFromOrderTemplate()
//        → retrieveOrder() → order.reference_id = our token
//   5. Recovery mappings written to Redis (customer + subscription → token)
//   6. upgradeTier(token, "pro") in Redis
//
// Webhook signature verification uses the official `square` npm package's
// WebhooksHelper.verifySignature() — not hand-rolled HMAC, per SQUAREDESIGN.md.
//
// API calls use the REST API directly (no SDK client needed for three endpoints).

import { WebhooksHelper } from "square";

// Square API version pinned — bump only after reviewing release notes.
const SQUARE_VERSION = "2026-05-20";

function baseUrl() {
  return process.env.SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

async function request(method, path, body) {
  const url = `${baseUrl()}/v2${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization":  `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type":   "application/json",
      "Square-Version": SQUARE_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    const details = (data.errors || [])
      .map(e => `${e.category}/${e.code}: ${e.detail}`)
      .join("; ");
    const err = new Error(`Square ${res.status} on ${method} ${path}: ${details || "unknown error"}`);
    err.squareErrors = data.errors || [];
    err.statusCode   = res.status;
    throw err;
  }

  return data;
}

// ── Checkout ──────────────────────────────────────────────────────────────────

/**
 * Create a Square-hosted payment link for a Pro subscription.
 *
 * The anonymous tokenId is embedded as `order.reference_id`. Square's hosted
 * checkout page collects the buyer's payment and contact info — we never see it.
 * After checkout, the subscription.created webhook reads `order_template_id`
 * from the subscription, calls retrieveOrder(), and recovers the tokenId from
 * `order.reference_id`.
 *
 * IMPORTANT: `checkout_options.subscription_plan_id` must be the PLAN
 * VARIATION ID (SQUARE_PLAN_VARIATION_ID), not the top-level plan ID. Square's
 * field name is misleading — see SQUAREDESIGN.md §1 gotcha.
 *
 * IMPORTANT: Square's CreatePaymentLink requires `order.line_items` to be
 * non-empty even for subscription checkout — confirmed against live docs.
 * `quick_pay` (Square's other top-level option) maps its `name`/`price_money`
 * internally into the exact same order line-item shape, so this isn't a
 * different mechanism, just a different way of supplying the same data —
 * which means it's safe to keep using `order` (and therefore keep
 * `reference_id`) rather than switching to `quick_pay`, which has no
 * `reference_id`-equivalent field and would have broken the whole
 * token-resolution chain this design depends on.
 *
 * The line item's price should match the plan variation's actual catalog
 * price (set via setup-square-catalog.mjs) — per Square's docs, a mismatch
 * acts as a price OVERRIDE on checkout, not just display text.
 *
 * @param {string} locationId      - SQUARE_LOCATION_ID env var
 * @param {string} referenceId     - anonymous extension tokenId
 * @param {string} planVariationId - SQUARE_PLAN_VARIATION_ID env var
 * @param {number} priceCents      - price in cents, must match the plan variation's catalog price
 * @param {string} priceName       - display name for the line item on Square's checkout page
 * @param {string} redirectUrl     - success page URL after payment
 * @returns {Promise<{ paymentLink: { id, url, order_id, ... }, ... }>}
 */
export async function createPaymentLink({ locationId, referenceId, planVariationId, priceCents, priceName, redirectUrl }) {
  return request("POST", "/online-checkout/payment-links", {
    idempotency_key: `${referenceId}-${Date.now()}`,
    order: {
      location_id:  locationId,
      reference_id: referenceId,  // ← our anonymous token; recovered at webhook time
      line_items: [
        {
          name:             priceName,
          quantity:         "1",
          base_price_money: { amount: priceCents, currency: "USD" },
        },
      ],
    },
    checkout_options: {
      subscription_plan_id: planVariationId,  // variation ID, not plan ID (see SQUAREDESIGN.md)
      redirect_url: redirectUrl,
    },
  });
}

// ── Orders ────────────────────────────────────────────────────────────────────

/**
 * Retrieve a Square Order by ID.
 *
 * Used in two places:
 *   1. Webhook handler: resolve token from `order_template_id` on the
 *      subscription object → `order.reference_id` = our anonymous token.
 *   2. Restore-token endpoint: buyer provides their receipt order ID →
 *      `order.customer_id` → Redis mapping → token.
 *
 * @param {string} orderId
 * @returns {Promise<{ order: { id, reference_id, customer_id, state, ... } }>}
 */
export async function retrieveOrder(orderId) {
  return request("POST", "/orders/batch-retrieve", {
    order_ids: [orderId],
  });
}

// ── Webhook signature verification ───────────────────────────────────────────

/**
 * Verify a Square webhook event using the official SDK's WebhooksHelper.
 *
 * Uses SQUAREDESIGN.md's specified approach: the `square` npm package's
 * WebhooksHelper.verifySignature(), which does HMAC-SHA256 over
 * (notificationUrl + rawBodyString) and compares to x-square-hmacsha256-signature.
 *
 * IMPORTANT: `rawBody` must be the raw string from the HTTP request, NOT a
 * re-serialized JSON object (re-serializing changes key ordering). In index.js,
 * raw bytes are captured via express.json's `verify` callback and stored on
 * `req.rawBody`.
 *
 * @param {object} params
 * @param {string|Buffer} params.rawBody         - raw request body
 * @param {string}        params.signature       - x-square-hmacsha256-signature header value
 * @param {string}        params.notificationUrl - exact webhook URL in Square Dashboard
 * @returns {Promise<boolean>}
 */
export async function verifyWebhookSignature({ rawBody, signature, notificationUrl }) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!signatureKey) return false;
  if (!signature)    return false;

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

  return WebhooksHelper.verifySignature({
    requestBody:     body,
    signatureHeader: signature,
    signatureKey,
    notificationUrl,
  });
}
