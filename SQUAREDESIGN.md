# Liar's Ledger — Square Subscription Integration: Pseudo-code Design

Status: design only, no implementation yet.
Verified against Square's live docs/forums on 2026-06-19 (see citations inline).

---

## 0. Why this shape (read before implementing)

Two assumptions from the original design don't survive contact with Square's current API:

1. **You cannot pass `customer_id` to `CreatePaymentLink` and have it stick.** Square
   confirmed (Feb 2025 forum thread) that the customer is derived from checkout-entered
   info, not the `customer_id` you pass. So we never pre-create a Square Customer and
   expect it to attach.
2. **Order-level `reference_id` is not in the subscription webhook payload directly** —
   but it IS retrievable. The trick (confirmed working, Square engineer + independent
   dev confirmation, Feb 2025): set `reference_id` on the **order** object passed into
   `CreatePaymentLink`. That order becomes the subscription's **order template** (not
   the per-cycle billed order). The `subscription.created` webhook gives you
   `phases[].order_template_id` → `RetrieveOrder` on that ID → read back `reference_id`.

So the flow is: **token → order.reference_id (at checkout) → order_template_id (in
webhook) → RetrieveOrder → reference_id (recovered) → flip tier.**

No new PII collected by us. Square's hosted checkout will still require the buyer to
enter contact info (their requirement, not ours) — that lives in Square's Customer
Directory, not our Redis. Disclosure language needs to distinguish "what Square
collects to process payment" from "what we retain."

---

## 1. Catalog API — Subscription Plan + Plan Variation

One-time setup script, run manually (not part of request-time code).

```
SCRIPT: scripts/setup-square-catalog.js

CONSTANTS:
  PLAN_NAME = "Liar's Ledger Pro"
  VARIATION_NAME = "Liar's Ledger Pro Monthly"
  PRICE_AMOUNT = <ryan specifies, e.g. 300 = $3.00>
  CURRENCY = "USD"
  CADENCE = "MONTHLY"

FUNCTION setupCatalog():
  # Step 1: create the plan (category-level container)
  planResult = squareClient.catalog.upsertCatalogObject({
    idempotencyKey: uuid(),
    object: {
      type: "SUBSCRIPTION_PLAN",
      id: "#pro-plan",                      # temporary client-side id
      subscriptionPlanData: {
        name: PLAN_NAME
        # no all_items / eligible_category_ids — this isn't tied to
        # physical catalog items, it's a pure access-tier subscription
      }
    }
  })
  planId = planResult.catalogObject.id      # Square-assigned permanent ID

  PRINT "Plan created: " + planId
  PRINT "Save this in your .env as SQUARE_SUBSCRIPTION_PLAN_ID"

  # Step 2: create the plan variation (price + cadence)
  # NOTE: single phase, STATIC pricing — required for Checkout API
  # subscription support (Checkout API only supports 1 paid phase,
  # or 1 free + 1 paid phase)
  variationResult = squareClient.catalog.upsertCatalogObject({
    idempotencyKey: uuid(),
    object: {
      type: "SUBSCRIPTION_PLAN_VARIATION",
      id: "#pro-monthly",
      subscriptionPlanVariationData: {
        name: VARIATION_NAME,
        subscriptionPlanId: planId,
        phases: [
          {
            cadence: CADENCE,
            ordinal: 0,
            pricing: {
              type: "STATIC",
              price: { amount: PRICE_AMOUNT, currency: CURRENCY }
            }
            # no `periods` field => indefinite, recurs until canceled
          }
        ]
      }
    }
  })
  variationId = variationResult.catalogObject.id

  PRINT "Plan variation created: " + variationId
  PRINT "Save this in your .env as SQUARE_PLAN_VARIATION_ID"
  PRINT "IMPORTANT: this is the ID CreatePaymentLink needs as"
  PRINT "subscription_plan_id (confusing name — it wants the VARIATION id,"
  PRINT "not the plan id)"

RUN setupCatalog() against Sandbox first, verify in Square Sandbox
dashboard, THEN re-run against Production credentials once confirmed.
```

**Gotcha to remember when implementing:** `CreatePaymentLink`'s field is literally
named `subscription_plan_id` but documentation explicitly says it must contain the
**plan variation's** ID, not the plan's ID. Easy to get backwards.

---

## 2. `liarsledger.com/pricing` — Checkout Flow

```
ROUTE: GET /pricing  (static page, liarsledger.com — likely same Express app
                       or a thin static site; assume same app for now)

  Renders pricing.html with a "Subscribe" button.
  Button posts to /pricing/checkout, NOT directly to Square — we need to
  build the order server-side so we control reference_id.

  The anonymous token must travel from the Chrome extension to this page.
  Token isn't naturally "in" a browser tab the way a logged-in session
  would be. Options, in order of preference:

    (a) Extension opens /pricing?token=<uuid> in a new tab when user
        clicks "Upgrade to Pro" inside the popup.
    (b) User manually copies token from extension options page and
        pastes it into a field on /pricing.

  Recommend (a) as primary path with (b) as fallback link ("already have
  a token? enter it manually") for cases where the user navigates to
  /pricing directly without going through the extension.

  SECURITY NOTE: token-in-URL means it can land in browser history,
  Render's access logs, referrer headers if the page links out anywhere.
  Mitigate:
    - pricing.html must not load any third-party scripts/fonts that would
      see the URL via referrer
    - the token should be moved out of the URL into a short-lived signed
      param immediately, OR the checkout POST should happen via a same-page
      JS fetch() so the raw token never appears in a GET request line that
      gets logged twice (once for page load, once for checkout creation)
    - simplest fix: GET /pricing?token=X renders the page, JS on the page
      reads it from the URL, stores in memory only, and the actual
      checkout-creation request is a POST with the token in the body, not
      the query string. Then only the page-load GET has it in the URL —
      acceptable, matches how the token already gets handled by
      chrome.storage.sync (still client-controlled, not novel exposure).


ROUTE: POST /pricing/checkout
  BODY: { token: string }

  FUNCTION handleCheckoutRequest(req, res):
    token = req.body.token
    VALIDATE token is a syntactically plausible UUID
      IF NOT valid: return 400

    VALIDATE token exists in our Redis (i.e. was actually issued by /register)
      IF NOT found: return 400 "unrecognized token"
      # prevents someone spamming arbitrary strings into Square's order
      # reference_id field

    idempotencyKey = uuid()   # fresh per checkout attempt, NOT derived
                               # from the token (token could retry checkout
                               # multiple times legitimately — failed card,
                               # abandoned checkout, etc.)

    paymentLinkResult = squareClient.checkout.createPaymentLink({
      idempotencyKey: idempotencyKey,
      order: {
        locationId: SQUARE_LOCATION_ID,
        referenceId: token,              # <-- the whole point
        # do NOT also set customer_id here — confirmed it's ignored /
        # superseded by checkout-entered info for this flow
      },
      checkoutOptions: {
        subscriptionPlanId: SQUARE_PLAN_VARIATION_ID,  # variation ID, see §1 gotcha
        redirectUrl: "https://liarsledger.com/pricing/success"
      }
    })

    paymentLinkUrl = paymentLinkResult.paymentLink.url

    LOG (without logging the token itself in plaintext if avoidable;
         at minimum don't log it alongside PII-adjacent fields)
      "checkout link created, order_id=" + paymentLinkResult.paymentLink.orderId

    return res.redirect(303, paymentLinkUrl)
    # 303 so the browser does a fresh GET to Square's hosted page rather
    # than re-POSTing


ROUTE: GET /pricing/success
  Static "thanks, check your extension in a minute" page.
  Tier flip happens via webhook, NOT here — this page must not be trusted
  to grant Pro. (Square's redirect happens regardless of final payment
  state in some edge cases / can be replayed by the user hitting back-
  forward; webhook is the only source of truth.)
```

---

## 3. `POST /webhook/square` — Express Backend

```
SETUP (once, outside the request handler):
  Use official `square` npm package's WebhooksHelper, not hand-rolled HMAC.
  Confirmed verification inputs: HMAC-SHA256 of (notificationUrl + rawBody),
  signing key = the webhook subscription's signature key (Square dashboard),
  header = `x-square-hmacsha256-signature`, compared as base64, must be
  constant-time (the SDK helper handles this — don't reimplement).

  CRITICAL: Express's express.json() middleware must NOT run on this route
  before we capture the raw body. Signature is computed over raw bytes;
  re-serializing a parsed JSON object will not byte-match in general
  (key ordering, whitespace, etc.) Use express.raw({ type: 'application/json' })
  for this route specifically, or a verify callback in express.json() that
  stashes req.rawBody before parsing.


ROUTE: POST /webhook/square

  FUNCTION handleSquareWebhook(req, res):
    rawBody = req.rawBody          # captured per above, string/buffer
    signatureHeader = req.headers['x-square-hmacsha256-signature']

    isValid = WebhooksHelper.verifySignature({
      requestBody: rawBody,
      signatureHeader: signatureHeader,
      signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      notificationUrl: process.env.SQUARE_WEBHOOK_NOTIFICATION_URL
                        # must exactly match what's registered in Square
                        # dashboard, including scheme/trailing slash
    })

    IF NOT isValid:
      LOG warning "invalid webhook signature, possible spoof attempt"
      return res.status(403).send()

    event = JSON.parse(rawBody)

    # ALWAYS 200 quickly once verified+parsed, even if our downstream
    # processing has an issue — Square retries on non-2xx and we don't
    # want duplicate side effects from naive retries on top of real
    # processing errors. Do real work, but don't let a downstream
    # exception turn into a 500 that triggers pointless retries for
    # something like "Redis was briefly down" — handle that internally
    # (queue/retry ourselves) rather than via Square's retry semantics.

    SWITCH event.type:

      CASE "subscription.created":
      CASE "subscription.updated":
        subscription = event.data.object.subscription
        AWAIT handleSubscriptionUpsert(subscription)

      CASE "invoice.payment_made":   # confirm exact event name against
                                      # Invoices API webhook list before
                                      # implementing — used loosely here
        AWAIT handleInvoicePaid(event.data.object)

      CASE "invoice.payment_failed":  # confirm exact name
        AWAIT handlePaymentFailed(event.data.object)

      DEFAULT:
        LOG info "unhandled event type: " + event.type
        # no-op, but acknowledge receipt regardless

    return res.status(200).send()


FUNCTION handleSubscriptionUpsert(subscription):
  status = subscription.status        # PENDING | ACTIVE | CANCELED | etc.
  customerId = subscription.customerId
  subscriptionId = subscription.id
  orderTemplateId = subscription.phases?[0]?.orderTemplateId

  IF orderTemplateId is missing:
    LOG error "subscription event with no order_template_id, can't resolve token"
    return   # nothing more we can do with this event; don't crash

  # Resolve token. Check Redis cache first (we may have already resolved
  # this order_template_id on a prior event — created fires once, but
  # updated can fire many times over a subscription's life).
  token = AWAIT redis.get("square:ordertemplate:" + orderTemplateId)

  IF token is null:
    order = AWAIT squareClient.orders.retrieveOrder(orderTemplateId)
    token = order.order.referenceId

    IF token is null OR NOT looksLikeOurTokenFormat(token):
      LOG error "order template has no usable reference_id, orderTemplateId=" + orderTemplateId
      return

    # cache the resolution so future events for this subscription
    # don't need another RetrieveOrder call
    AWAIT redis.set("square:ordertemplate:" + orderTemplateId, token)

  # Write/refresh the recovery mapping regardless of status —
  # this is what lets us find the token later from a receipt/customer ID
  AWAIT redis.set("square:customer:" + customerId, token)
  AWAIT redis.set("square:subscription:" + subscriptionId, token)

  IF status == "ACTIVE":
    AWAIT store.upgradeTier(token, "pro")
  ELSE IF status == "CANCELED":
    AWAIT store.downgradeTier(token, "free")
  ELSE IF status == "PENDING":
    # no tier change yet — wait for ACTIVE. PENDING means accepted but
    # not yet billed/started (e.g. future start_date).
    LOG info "subscription pending, no tier change: " + subscriptionId
  ELSE:
    LOG info "subscription status " + status + " — no tier action defined yet"


FUNCTION handleInvoicePaid(invoiceObject):
  # Recurring monthly charges succeed here. Use this (rather than relying
  # solely on subscription.updated) to confirm continued Pro access and
  # to catch a case where a subscription is ACTIVE but a specific cycle's
  # payment is what we actually want to gate on, depending on how strict
  # we want billing-failure handling to be.
  # token resolution: invoice has subscription_id -> look up via
  # "square:subscription:" + subscriptionId in Redis (already populated
  # by handleSubscriptionUpsert, which fires before any invoice event)
  subscriptionId = invoiceObject.subscriptionId
  token = AWAIT redis.get("square:subscription:" + subscriptionId)
  IF token: AWAIT store.upgradeTier(token, "pro")


FUNCTION handlePaymentFailed(invoiceObject):
  subscriptionId = invoiceObject.subscriptionId
  token = AWAIT redis.get("square:subscription:" + subscriptionId)
  IF token:
    LOG warning "payment failed for token (partial, no PII): " + token.slice(0,8) + "..."
    # decide policy: immediate downgrade, or grace period?
    # recommend: do NOT immediately downgrade on first failure — Square
    # itself retries failed payments automatically over some window before
    # the subscription transitions to CANCELED. Downgrading here AND on
    # CANCELED double-punishes a transient card issue. Leave tier as-is;
    # let the eventual subscription.updated -> CANCELED be the real signal.
    # (CONFIRM Square's actual retry/dunning window before finalizing this
    # policy — not yet verified against current docs.)
```

**Event names flagged as unconfirmed above** (`invoice.payment_made`,
`invoice.payment_failed`) — I used plausible names but have not yet verified
these against Square's current Invoices API webhook event list. Need to
confirm before implementation; will check this when we move to actual code.

---

## 4. Extension: "Restore Token" Field

```
FILE: extension/popup.html  (or a new options.html if popup is already dense)

  Add a collapsed/secondary section, not the primary UI:

    <details>
      <summary>Lost your Pro status after reinstalling?</summary>
      <p>Enter your Square order number or receipt email reference:</p>
      <input id="restore-input" placeholder="Order # or receipt reference" />
      <button id="restore-btn">Restore</button>
      <p id="restore-status"></p>
    </details>

FILE: extension/popup.js

  FUNCTION onRestoreClick():
    inputValue = document.getElementById('restore-input').value.trim()
    IF inputValue is empty: show inline error, return

    setStatus("Checking...")

    response = AWAIT fetch(API_BASE + "/restore-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderReference: inputValue })
    })

    IF response.status == 200:
      result = AWAIT response.json()
      newToken = result.token

      AWAIT chrome.storage.sync.set({ token: newToken })
      setStatus("Restored! Your Pro status is back.")
      # trigger whatever re-init logic reads token from storage on popup load

    ELSE IF response.status == 404:
      setStatus("We couldn't find a completed payment matching that. " +
                 "Double check your receipt, or contact support.")
    ELSE:
      setStatus("Something went wrong. Try again in a moment.")
```

```
ROUTE: POST /restore-token   (new backend endpoint, server/index.js)
  BODY: { orderReference: string }

  FUNCTION handleRestoreToken(req, res):
    orderReference = req.body.orderReference

    # "orderReference" from the user could be a Square order ID, a
    # receipt number, or in practice probably whatever's printed on
    # their email receipt — need to confirm what Square actually puts
    # on buyer-facing receipts before finalizing input format/label.
    # Placeholder logic assuming it's resolvable to an order ID:

    order = AWAIT squareClient.orders.retrieveOrder(orderReference)
      # wrap in try/catch — invalid/garbage input will 404 from Square

    IF order not found OR order.state != "COMPLETED":
      return res.status(404).send()

    # Verify this order actually corresponds to a real completed payment
    # — RetrieveOrder alone may not be sufficient proof of payment
    # depending on order state semantics for subscription order templates
    # vs. billed orders. NEEDS VERIFICATION: is the order the user has a
    # receipt for the *order template* (reference_id lives here) or a
    # *billed cycle order* (reference_id may NOT propagate here — same
    # unreliability problem as the original payment-level reference_id
    # issue)? This determines whether we look up token directly via
    # reference_id here, or whether we need order.customerId ->
    # "square:customer:" + customerId in Redis instead.
    #
    # SAFER PATH (use this until verified): use order.customerId,
    # not order.referenceId, since we already maintain
    # "square:customer:" + customerId -> token from the webhook handler,
    # and that mapping doesn't depend on which specific order the user's
    # receipt references.

    customerId = order.customerId
    token = AWAIT redis.get("square:customer:" + customerId)

    IF token is null:
      return res.status(404).send()

    return res.status(200).json({ token: token })
```

**Open question flagged in the pseudocode above**: need to verify exactly
what identifier appears on a buyer's Square receipt/confirmation email, and
whether `RetrieveOrder` on that identifier reliably has a usable
`customer_id`. Will check before writing real code for this endpoint.

---

## 5. `privacy.html` Disclosure Addition

```
New section, placed near existing token-handling language:

  "Pro Subscriptions and Payment

  If you subscribe to Liar's Ledger Pro, you'll be taken to a checkout
  page hosted by Square, our payment processor. Square collects the
  payment and contact information it requires to process your
  transaction (such as a card and contact details) — we never see or
  store this information ourselves.

  To connect your payment to your anonymous token without collecting
  any personal information on our end, we retain a reference linking
  your Square transaction (specifically, your Square customer and
  subscription identifiers) to your anonymous token. This reference
  is used solely to:
    - activate Pro features after payment
    - restore your Pro status if you lose your token and provide proof
      of a completed payment (such as your order or receipt reference)

  This reference does not include your name, email, payment details,
  or any other information Square collects — only an internal
  identifier pairing."

  PLACEMENT NOTE: should sit as its own subsection, not buried inside
  the existing "we don't collect identifying information" paragraph —
  that paragraph's claim needs to stay true on its own for non-Pro
  users; this is a clearly-scoped exception for subscribers only.
```

---

## 6. CHANGELOG.md / SECURITY.md Updates

```
CHANGELOG.md — new entry, file-by-file as per existing project convention:

  ## [0.14.0] - <date TBD>

  ### Added
  - `scripts/setup-square-catalog.js` — one-time Catalog API setup for
    Pro subscription plan + monthly variation
  - `server/routes/pricing.js` — `/pricing/checkout` route, builds Square
    order with anonymous token as `reference_id`, redirects to
    Square-hosted checkout
  - `server/routes/webhook-square.js` — `POST /webhook/square`, verifies
    Square signature, handles subscription lifecycle + invoice events,
    resolves token via order_template_id -> RetrieveOrder -> reference_id,
    writes recovery mapping to Redis
  - `server/routes/restore-token.js` — `POST /restore-token`, manual
    recovery flow for lost tokens via Square order/customer lookup
  - `extension/popup.html` / `popup.js` — "Restore token" UI
  - `privacy.html` — new disclosure section for Pro subscriber data
    retention (Square transaction reference <-> anonymous token mapping)

  ### Changed
  - `server/providers/store.js` — `upgradeTier()` / `downgradeTier()` now
    also invoked from webhook handler, not just `/admin/set-tier`

  ### Decisions
  - Chose order.reference_id (resolved via order_template_id from
    subscription webhooks) over payment-level reference_id, which Square's
    own forums confirm doesn't reliably round-trip on payment.created/
    payment.updated events.
  - Did NOT attempt to pre-create a Square Customer and pass customer_id
    into CreatePaymentLink — confirmed (Square forum, Feb 2025) that this
    is silently ignored; Square derives the customer from checkout-entered
    info instead.
  - Recovery mapping keys on customer_id/subscription_id, written at
    webhook-resolution time, not at "signup time" as originally drafted —
    there's nothing to map until Square has created the customer/
    subscription, which happens after checkout, not before.

  ### Known open questions (not yet resolved as of this entry)
  - Exact Invoices API webhook event names for payment-succeeded/
    payment-failed need confirmation against current docs before
    handleInvoicePaid/handlePaymentFailed are implemented for real.
  - Exact format of buyer-facing Square receipt reference, and whether
    RetrieveOrder on that reference reliably yields a customer_id, needs
    confirmation before /restore-token ships.


SECURITY.md — new note:

  ## Tier Management

  As of v0.14.0, tier upgrades/downgrades are primarily driven by
  `POST /webhook/square` (Square-signature-verified, see webhook handler
  for HMAC verification details) rather than manual intervention.

  `/admin/set-tier` and `/admin/reset-scans` predate this integration and
  were built as temporary manual-override tools before any payment
  processor existed. They remain in place for support/debugging purposes
  but should be considered legacy:
    - TODO: restrict to a stricter auth mechanism than current (specify:
      what's current?) before any wider exposure
    - TODO: consider removing entirely once webhook-driven tier management
      has run reliably in production for some period
```

---

## Summary of what still needs live-doc verification before real code

1. Exact Invoices API webhook event type names (payment succeeded / failed)
2. Whether a billed-cycle order (vs. the order template) carries `reference_id`
   reliably, or whether `/restore-token` must key off `customer_id` only
   (current pseudocode already defaults to the safer `customer_id` path)
3. What identifier actually appears on a Square buyer receipt, to design the
   `/restore-token` input field's label/placeholder/validation correctly
4. Square's dunning/retry window for failed subscription payments, to decide
   grace-period policy in `handlePaymentFailed`

Once you confirm this overall shape looks right, next step is verifying item
1–4 above, then implementing in this order: Catalog setup script → webhook
handler → checkout route → restore-token route → extension UI → docs.