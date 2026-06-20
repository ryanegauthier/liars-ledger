// Liar's Ledger - server/index.js
// Backend proxy server.
//
// Routes:
//   POST /register             - anonymous token registration
//   GET  /api/scan-status      - remaining scans for token
//   POST /api/scan/start       - consume a scan (returns allowed/remaining)
//   POST /api/claude/extract   - Claude extraction (not counted here)
//   POST /api/mistral/extract  - Mistral extraction (not counted here)
//   POST /api/verify-claim     - claim verification (Pro only)
//   GET  /api/congress/*       - Congress.gov proxy
//   GET  /api/votesmart/*      - VoteSmart proxy (Pro only)
//   GET  /api/govtrack/*       - GovTrack proxy (no key)
//   GET  /api/legislators      - congress-legislators dataset (cached)
//   GET  /health               - health check
//   POST /pricing/checkout     - create Square payment link for Pro subscription
//   POST /webhook/square       - Square webhook receiver (subscription lifecycle,
//                                 events: subscription.created, subscription.updated,
//                                 invoice.payment_made, invoice.scheduled_charge_failed)
//   POST /restore-token        - recover Pro access via Square order reference
//   POST /admin/set-tier       - manual tier override (TEMPORARY - pre-Square only)
//   POST /admin/reset-scans    - manual scan count reset (TEMPORARY - pre-Square only)

import "dotenv/config";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { claude }    from "./providers/claude.js";
import { mistral }   from "./providers/mistral.js";
import { congress }  from "./providers/congress.js";
import { votesmart } from "./providers/votesmart.js";
import { govtrack }  from "./providers/govtrack.js";
import { verifyClaim } from "./providers/verify.js";
import { createToken, getToken, getScans, incrementUserCount, getFreeTierLimit, upgradeTier, resetScans, storeOrderTemplateMapping, lookupTokenByOrderTemplate, storeSquareCustomerMapping, lookupTokenBySquareCustomer, storeSquareSubscriptionMapping, lookupTokenBySquareSubscription, recordFailedCharge, clearFailedCharges, setDowngradeReason, clearDowngradeReason, getDowngradeReason } from "./providers/store.js";
import { requireToken, countScan } from "./middleware/auth.js";
import * as square from "./providers/square.js";

const app  = express();
const PORT = process.env.PORT || 3001;

// Render sits behind a single reverse proxy hop, which sets X-Forwarded-For
// on every incoming request. Express's default (trust proxy: false) ignores
// that header entirely and falls back to the proxy's own connection IP for
// anything IP-based — meaning every distinct visitor would resolve to the
// same address as far as express-rate-limit is concerned, silently breaking
// the /register, general API, and /restore-token limiters (all keyed by IP).
// Setting this to 1 means "trust exactly one hop" — correct for Render's
// architecture. Must be set before any rate limiter middleware is registered.
app.set("trust proxy", 1);

// ── Async wrapper - catches rejected promises from async route handlers ────────
// Express 4.x does not catch async errors automatically.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "x-token"],
}));

// Capture raw body before JSON parsing — required for Square webhook signature
// verification. The webhook handler reads req.rawBody; all other routes use
// the parsed req.body as normal. See POST /webhook/square below.
app.use(express.json({
  limit: "64kb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});
app.use("/api", limiter);

// /register gets its own, much stricter limiter, keyed by IP. A real install
// calls this once (occasionally again on startup to refresh state) — there's
// no legitimate reason for one IP to register many tokens quickly. This is
// the main defense against a script mass-creating fake tokens to drain the
// shared scan pool or inflate global:user_count (which lowers everyone's
// daily limit). Not a complete fix — a distributed attacker with many IPs
// or proxies isn't stopped by this — but it closes the trivial single-machine
// case for free, with no user-facing downside for real installs.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Please try again later." },
});
app.use("/register", registerLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: process.env.npm_package_version || "0.14.2", ts: new Date().toISOString() });
});

// ── Registration ──────────────────────────────────────────────────────────────
// POST /register - create an anonymous token for a new extension install
app.post("/register", wrap(async (req, res) => {
  const { tokenId } = req.body;

  if (!tokenId || typeof tokenId !== "string" || tokenId.length < 16) {
    return res.status(400).json({ error: "Valid tokenId required (min 16 chars)." });
  }

  const existing = await getToken(tokenId);
  if (existing) {
    // Scans are pooled across all users regardless of tier — pro changes
    // what data the extension shows, not how many scans are available.
    const [scans, { limit, warn }] = await Promise.all([
      getScans(tokenId),
      getFreeTierLimit(),
    ]);
    return res.json({
      status: "existing",
      tier: existing.tier,
      scansToday: scans,
      limit,
      capacityWarning: warn,
    });
  }

  const [tokenData, { limit, warn }] = await Promise.all([
    createToken(tokenId, "free"),
    getFreeTierLimit(),
  ]);
  await incrementUserCount();
  console.log(`[register] new token: ${tokenId.slice(0, 8)}...`);

  res.json({
    status: "created",
    tier: tokenData.tier,
    scansToday: 0,
    limit,
    capacityWarning: warn,
  });
}));

// ── Scan status ───────────────────────────────────────────────────────────────
app.get("/api/scan-status", requireToken, wrap(async (req, res) => {
  // Scans are pooled across all users regardless of tier — pro changes
  // what data the extension shows (AI summary, VoteSmart), not scan count.
  const [scans, { limit, warn, userCount }, downgrade] = await Promise.all([
    getScans(req.tokenId),
    getFreeTierLimit(),
    // Only meaningful for free tier — a pro user obviously hasn't been
    // downgraded, and any stale marker would already have been cleared on
    // their last successful payment/resubscribe anyway. Skipping the
    // lookup entirely for pro tier avoids an extra Redis round-trip on
    // every single poll for the common case.
    req.tier === "free" ? getDowngradeReason(req.tokenId) : Promise.resolve(null),
  ]);
  const remaining = Math.max(0, limit - scans);

  res.json({
    tier: req.tier,
    scansToday: scans,
    limit,
    remaining,
    capacityWarning: warn,     // true at 2500–4999 users — surface in extension UI
    userCount,
    // Present only when this token was downgraded due to repeated payment
    // failure (not a normal cancellation, and not "never subscribed").
    // Lets the popup show "your card was declined" instead of a generic
    // upgrade pitch. null/absent for everyone else.
    downgradeReason: downgrade?.reason || null,
  });
}));

// ── Scan counting ─────────────────────────────────────────────────────────────
// Single source of truth for "did this user use up a scan today."
// Call this ONCE per page-scan, before kicking off LLM extraction — regardless
// of how many providers run underneath (dual-model Claude+Mistral, single-model
// fallback, etc.) or how many politicians the article ends up returning.
// /api/claude/extract and /api/mistral/extract are pure extraction endpoints
// below — they do NOT count against the limit, by design, so dual-model mode
// never double-charges a single scan.
app.post("/api/scan/start", requireToken, countScan, wrap(async (req, res) => {
  res.json({
    allowed: req.scanAllowed,
    remaining: req.scanRemaining,
    warn: req.scanWarn,
  });
}));

// ── LLM extraction (NOT counted here — see /api/scan/start above) ─────────────

// Strips Pro-only fields from a claude/mistral extraction result before it
// reaches a free-tier client. `lookup_name` and `search_terms` always stay -
// free tier needs those to resolve politicians and search bills. Only the
// article summary and each figure's claim text are gated, matching the
// "PRO-TIER GATING" list in background.js and the upsell copy in
// report.js / content.js.
function gateExtractionResult(result, tier) {
  if (tier === "pro" || !result.ok) return result;
  return {
    ...result,
    summary: "",
    figures: (result.figures || []).map(fig => ({
      lookup_name:  fig.lookup_name,
      search_terms: fig.search_terms,
      claim: null,
    })),
  };
}

// POST /api/claude/extract
app.post("/api/claude/extract", requireToken, wrap(async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await claude.extract(articleText);
  res.status(result.ok ? 200 : 502).json(gateExtractionResult(result, req.tier));
}));

// POST /api/mistral/extract
app.post("/api/mistral/extract", requireToken, wrap(async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await mistral.extract(articleText);
  res.status(result.ok ? 200 : 502).json(gateExtractionResult(result, req.tier));
}));

// ── Pro-tier gating ────────────────────────────────────────────────────────────
// Server-side enforcement — the actual security boundary. Client-side stripping
// in background.js is a UX nicety (avoids flashing gated data before deciding
// not to show it) and a cost-saver (free tier never even calls these routes),
// but a modified or malicious client could call these endpoints directly,
// bypassing any client-side logic entirely. This middleware is what actually
// keeps free-tier responses from containing Pro-only data.
//
// KEEP THIS LIST IN SYNC with background.js's "PRO-TIER GATING" comment block,
// and with the upsell copy in report.js / content.js. If a route here starts
// returning a new field that's supposed to be Pro-only, gate it here too.
function requirePro(req, res, next) {
  if (req.tier !== "pro") {
    return res.status(403).json({
      error: "This feature requires a Pro subscription.",
      upgradeUrl: "https://liarsledger.com/pricing",
    });
  }
  next();
}

app.post("/api/verify-claim", requireToken, requirePro, wrap(async (req, res) => {
  const { claim, member, record } = req.body;

  if (!claim) return res.status(400).json({ error: "claim required" });
  if (!member) return res.status(400).json({ error: "member required" });
  if (!record) return res.status(400).json({ error: "record required" });

  const result = await verifyClaim(claim, member, record);
  res.status(result.ok ? 200 : 502).json(result);
}));

// ── Congress.gov proxy ────────────────────────────────────────────────────────
app.get("/api/congress/*", requireToken, wrap(async (req, res) => {
  const path  = req.params[0];
  const query = new URLSearchParams(req.query);
  query.set("api_key", process.env.CONGRESS_API_KEY);
  query.set("format", "json");

  try {
    const result = await congress.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── VoteSmart proxy ───────────────────────────────────────────────────────────
app.get("/api/votesmart/*", requireToken, requirePro, wrap(async (req, res) => {
  const path  = req.params[0];
  const query = new URLSearchParams(req.query);

  try {
    const result = await votesmart.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── GovTrack proxy ────────────────────────────────────────────────────────────
// GET /api/govtrack/* → https://www.govtrack.us/api/v2/* (no key required)
app.get("/api/govtrack/*", requireToken, wrap(async (req, res) => {
  const path  = req.params[0];
  const query = new URLSearchParams(req.query);

  try {
    const result = await govtrack.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── Congress legislators dataset (static, cached) ─────────────────────────────
// GET /api/legislators → unitedstates.github.io congress-legislators-current.json
app.get("/api/legislators", requireToken, wrap(async (req, res) => {
  try {
    res.json(await govtrack.legislators());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── Admin endpoints (TEMPORARY — testing/manual-override only) ────────────────
// Both routes below exist to unblock testing while Square integration doesn't
// exist yet — there's no real way to become Pro or reset a count otherwise.
// Once /webhook/square is live and handles this automatically, these routes
// should be removed entirely; they're manual bypasses, not features.
//
// Auth: a shared secret via the x-admin-key header, set as ADMIN_SECRET in
// Render's environment variables. Never the same value as any other secret in
// this codebase. If ADMIN_SECRET isn't set, these routes always 403 — they do
// NOT fail open, unlike requireToken elsewhere, since failing open here would
// let anyone grant themselves Pro or unlimited scans for free.
function checkAdminAuth(req, res) {
  const adminSecret = process.env.ADMIN_SECRET;
  const providedKey = req.headers["x-admin-key"];
  if (!adminSecret || !providedKey || providedKey !== adminSecret) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// POST /admin/set-tier
// Body: { "tokenId": "...", "tier": "pro" }  (tier: "free" or "pro")
app.post("/admin/set-tier", express.json(), wrap(async (req, res) => {
  if (!checkAdminAuth(req, res)) return;

  const { tokenId, tier } = req.body || {};
  if (!tokenId || typeof tokenId !== "string") {
    return res.status(400).json({ error: "tokenId required" });
  }
  if (tier !== "free" && tier !== "pro") {
    return res.status(400).json({ error: 'tier must be "free" or "pro"' });
  }

  try {
    let updated = await upgradeTier(tokenId, tier);
    if (!updated) {
      // Token didn't exist or was corrupted (getToken() returns null in both
      // cases) — create it fresh rather than leaving the request stuck.
      updated = await createToken(tokenId, tier);
      console.log(`[admin] token ${tokenId.slice(0, 8)}... did not exist or was corrupted - created fresh as ${tier}`);
    } else {
      console.log(`[admin] token ${tokenId.slice(0, 8)}... set to ${tier}`);
    }
    res.json({ ok: true, tokenId, tier: updated.tier });
  } catch (e) {
    console.error("[admin] set-tier failed:", e.message);
    res.status(500).json({ error: "Failed to update tier" });
  }
}));

// POST /admin/reset-scans — testing convenience, skip waiting until midnight UTC
// Body: { "tokenId": "..." }
app.post("/admin/reset-scans", express.json(), wrap(async (req, res) => {
  if (!checkAdminAuth(req, res)) return;

  const { tokenId } = req.body || {};
  if (!tokenId || typeof tokenId !== "string") {
    return res.status(400).json({ error: "tokenId required" });
  }

  try {
    await resetScans(tokenId);
    console.log(`[admin] scan count reset for token ${tokenId.slice(0, 8)}...`);
    res.json({ ok: true, tokenId, scansToday: 0 });
  } catch (e) {
    console.error("[admin] reset-scans failed:", e.message);
    res.status(500).json({ error: "Failed to reset scan count" });
  }
}));

// ── Square subscription checkout ──────────────────────────────────────────────
// POST /pricing/checkout
// Called from liarsledger.com/pricing when a user clicks "Subscribe to Pro".
// Body: { token }  (the anonymous extension install token)
//
// Flow (per SQUAREDESIGN.md):
//   1. Validate the token exists in Redis
//   2. Create a Square payment link with order.reference_id = token
//   3. Return { url } — frontend navigates to Square's hosted checkout
//   4. Square collects payment + contact info (buyer's email, card) — we never see it
//   5. POST /webhook/square fires on subscription events → upgradeTier
//
// CORS note: called from liarsledger.com. ALLOWED_ORIGINS must include
// https://liarsledger.com in Render env vars.
app.post("/pricing/checkout", wrap(async (req, res) => {
  const { token } = req.body || {};

  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "token is required" });
  }
  // Basic plausibility check — UUIDs are 36 chars; our tokens are similar length
  if (token.length < 16 || token.length > 128) {
    return res.status(400).json({ error: "invalid token format" });
  }

  const tokenData = await getToken(token);
  if (!tokenData) {
    return res.status(404).json({
      error: "Token not found. Check your install token in the extension popup → Account panel.",
    });
  }
  if (tokenData.tier === "pro") {
    return res.status(409).json({
      error: "This token already has Pro access.",
    });
  }

  const locationId      = process.env.SQUARE_LOCATION_ID;
  const planVariationId = process.env.SQUARE_PLAN_VARIATION_ID;
  const backendUrl      = process.env.BACKEND_URL || "https://api.liarsledger.com";
  // Square's CreatePaymentLink requires a populated order.line_items even for
  // subscription checkout — confirmed against live docs (the order/quick_pay
  // distinction is cosmetic; quick_pay's name+price_money map internally to
  // the same order line item shape). This must match the plan variation's
  // actual price set in Square's catalog (see setup-square-catalog.mjs) —
  // per Square's own subscription-checkout docs, a mismatch acts as a price
  // OVERRIDE, not just display text, so these two numbers must stay in sync
  // by hand if the Pro price is ever changed in the Square dashboard.
  const proPriceCents = parseInt(process.env.SQUARE_PRO_PRICE_CENTS || "500", 10); // $5.00 default
  const proPriceName  = process.env.SQUARE_PRO_PRICE_NAME || "Liar's Ledger Pro — Monthly";

  if (!locationId || !planVariationId) {
    console.error("[checkout] SQUARE_LOCATION_ID or SQUARE_PLAN_VARIATION_ID not set");
    return res.status(503).json({ error: "Subscription service is not yet configured. Try again soon." });
  }

  try {
    const result = await square.createPaymentLink({
      locationId,
      referenceId:     token,
      planVariationId,
      priceCents:      proPriceCents,
      priceName:       proPriceName,
      redirectUrl:     `${process.env.PRICING_SITE_URL || "https://liarsledger.com"}/pricing/success`,
    });

    const checkoutUrl = result.payment_link?.url;
    if (!checkoutUrl) {
      throw new Error("Square returned no payment_link.url");
    }

    console.log(`[checkout] payment link created for token ${token.slice(0, 8)}… order_id=${result.payment_link.order_id}`);

    res.json({ ok: true, url: checkoutUrl });
  } catch (err) {
    console.error("[checkout] createPaymentLink failed:", err.message, err.squareErrors);
    res.status(502).json({ error: "Failed to create checkout link. Please try again." });
  }
}));

// ── Square webhook receiver ───────────────────────────────────────────────────
// POST /webhook/square
//
// Register this URL in Square Developer Console → Webhooks → Add endpoint.
// Subscribe to: subscription.created, subscription.updated,
//               invoice.payment_made, invoice.scheduled_charge_failed
//
// Token resolution path (per SQUAREDESIGN.md §3):
//   1. subscription.created fires with phases[0].order_template_id
//   2. Check Redis cache (square:ordertemplate:{id}) — skip RetrieveOrder if hit
//   3. Cache miss: call RetrieveOrder → order.reference_id = our token
//   4. Cache the resolution + write customer/subscription recovery mappings
//   5. upgradeTier(token, "pro") or downgradeTier based on subscription.status
//
// SQUARE_WEBHOOK_NOTIFICATION_URL must exactly match what's in the Square
// Dashboard (including scheme and trailing slash, if any). Set in Render env vars.
app.post("/webhook/square", wrap(async (req, res) => {
  const signature       = req.headers["x-square-hmacsha256-signature"];
  const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL
    || `${process.env.BACKEND_URL || "https://api.liarsledger.com"}/webhook/square`;

  const isValid = await square.verifyWebhookSignature({
    rawBody: req.rawBody,
    signature,
    notificationUrl,
  });

  if (!isValid) {
    console.warn("[webhook/square] signature mismatch — rejecting");
    return res.status(403).send();
  }

  // Acknowledge immediately — Square retries on non-2xx (up to 24h).
  // We process the event after responding to minimize Square's retry window
  // on transient internal errors (e.g. brief Redis downtime). Don't let a
  // downstream failure become a Square retry storm.
  res.status(200).send();

  try {
    await handleSquareEvent(req.body);
  } catch (err) {
    console.error("[webhook/square] event handler error:", err.message);
  }
}));

/**
 * Process a Square webhook event.
 * Called after the 200 response has been sent.
 */
async function handleSquareEvent(event) {
  const type = event?.type;
  const obj  = event?.data?.object;

  // ── subscription.created / subscription.updated ──────────────────────────
  if (type === "subscription.created" || type === "subscription.updated") {
    const sub = obj?.subscription;
    if (!sub) return;

    const { id: subscriptionId, customer_id: customerId, status } = sub;
    const orderTemplateId = sub.phases?.[0]?.order_template_id;

    if (status === "ACTIVE" || status === "PENDING") {
      const tokenId = await resolveTokenFromOrderTemplate(orderTemplateId, subscriptionId, customerId);
      if (tokenId) {
        await upgradeTier(tokenId, "pro");
        console.log(`[webhook/square] ${type} status=${status} → token ${tokenId.slice(0, 8)}… → pro`);
      } else {
        console.error(`[webhook/square] ${type}: could not resolve token for sub=${subscriptionId?.slice(0, 8)}…`);
      }
      if (status === "ACTIVE") {
        // Reaching ACTIVE (e.g. after a card update following failed
        // charges, or a fresh resubscribe) means whatever retry sequence
        // was in progress is over — clear both the failure count and any
        // stale "you were downgraded" marker so it doesn't resurface after
        // the person has already fixed things.
        await clearFailedCharges(subscriptionId);
        if (tokenId) await clearDowngradeReason(tokenId);
      }
    } else if (status === "CANCELED" || status === "DEACTIVATED") {
      // User-initiated (or otherwise not failure-driven) — the person
      // already knows why (they cancelled, or Square/we deactivated it for
      // some other reason unrelated to a declined card). No downgrade-
      // reason marker here; that's reserved for the failure-driven path.
      const tokenId = await resolveTokenFromOrderTemplate(orderTemplateId, subscriptionId, customerId);
      if (tokenId) {
        await upgradeTier(tokenId, "free");
        await clearDowngradeReason(tokenId); // in case a stale marker exists from an earlier failed-payment episode
        console.log(`[webhook/square] ${type} status=${status} → token ${tokenId.slice(0, 8)}… → free`);
      }
      await clearFailedCharges(subscriptionId);
    } else if (status === "FAILED") {
      // Square's own subscription-level FAILED status — this IS
      // failure-driven (distinct from an individual invoice.scheduled_
      // charge_failed event, but same underlying cause), so set the marker.
      const tokenId = await resolveTokenFromOrderTemplate(orderTemplateId, subscriptionId, customerId);
      if (tokenId) {
        await upgradeTier(tokenId, "free");
        await setDowngradeReason(tokenId, "payment_failed");
        console.log(`[webhook/square] ${type} status=${status} → token ${tokenId.slice(0, 8)}… → free (payment_failed)`);
      }
      await clearFailedCharges(subscriptionId);
    } else {
      // PENDING without a start_date, PAUSED, etc.
      console.log(`[webhook/square] ${type} status=${status} — no tier action`);
    }
    return;
  }

  // ── invoice.payment_made ─────────────────────────────────────────────────
  // Idempotent confirmation of Pro status on recurring billing cycles.
  // subscription.created/updated already handles the initial upgrade, but
  // invoice.payment_made is a belt-and-suspenders confirmation each cycle.
  // Also clears any failed-charge tracking — a successful payment means
  // whatever retry sequence was in progress resolved itself.
  if (type === "invoice.payment_made") {
    const subscriptionId = obj?.invoice?.subscription_id;
    if (!subscriptionId) return;

    const tokenId = await lookupTokenBySquareSubscription(subscriptionId);
    if (tokenId) {
      await upgradeTier(tokenId, "pro");
      await clearDowngradeReason(tokenId);
      console.log(`[webhook/square] invoice.payment_made sub=${subscriptionId.slice(0, 8)}… → token ${tokenId.slice(0, 8)}… confirmed pro`);
    }
    await clearFailedCharges(subscriptionId);
    return;
  }

  // ── invoice.scheduled_charge_failed ──────────────────────────────────────
  // Fires when an automatic subscription payment attempt fails. This is the
  // correct, documented event for this (payment.updated is too broad and not
  // subscription-specific — see CHANGELOG for the live-docs verification).
  //
  // IMPORTANT: confirmed against Square's own docs — Square does NOT
  // auto-cancel a subscription when payments fail. It retries automatically
  // on day 3, day 6, and day 9 after the initial decline, then simply leaves
  // the subscription ACTIVE with an unpaid invoice indefinitely. There is no
  // guaranteed subscription.updated → CANCELED event to wait for after that.
  //
  // So we track failures ourselves and downgrade proactively once we're past
  // Square's retry window with no successful payment in between. Using
  // count >= 3 as the threshold (matches Square's 3-retry schedule: day 3,
  // 6, 9) rather than a fixed day-9 timer — simpler, and avoids needing a
  // separate scheduled job just to check elapsed time.
  if (type === "invoice.scheduled_charge_failed") {
    const subscriptionId = obj?.invoice?.subscription_id;
    if (!subscriptionId) return;

    const failureRecord = await recordFailedCharge(subscriptionId);
    console.warn(`[webhook/square] invoice.scheduled_charge_failed sub=${subscriptionId.slice(0, 8)}… (failure #${failureRecord.count}, first failed ${failureRecord.firstFailedAt})`);

    // After Square's full retry schedule (3 failures = day 3, 6, 9 all
    // missed) has played out with no intervening payment_made, downgrade.
    // subscription.updated → CANCELED, if it ever arrives, will also
    // downgrade (idempotent) — this just stops us granting Pro forever to a
    // card that's permanently failing while Square leaves it ACTIVE.
    if (failureRecord.count >= 3) {
      const tokenId = await lookupTokenBySquareSubscription(subscriptionId);
      if (tokenId) {
        await upgradeTier(tokenId, "free");
        await setDowngradeReason(tokenId, "payment_failed");
        console.warn(`[webhook/square] sub=${subscriptionId.slice(0, 8)}… exceeded retry window (${failureRecord.count} failures) → token ${tokenId.slice(0, 8)}… downgraded to free`);
      } else {
        console.error(`[webhook/square] sub=${subscriptionId.slice(0, 8)}… exceeded retry window but no token mapping found — could not downgrade`);
      }
    }
    return;
  }

  console.log(`[webhook/square] unhandled event type: ${type}`);
}

/**
 * Resolve a tokenId from a subscription event.
 *
 * Resolution order (per SQUAREDESIGN.md §3):
 *   1. Redis cache: square:ordertemplate:{orderTemplateId} → token (fast)
 *   2. Cache miss: RetrieveOrder(orderTemplateId) → order.reference_id → token
 *   3. Cache the resolution; write all three recovery mappings
 *   4. Last resort: square:subscription:{subscriptionId} lookup (handles
 *      subscription.updated events after the initial created event is cached)
 *
 * @param {string|undefined} orderTemplateId - phases[0].order_template_id
 * @param {string}           subscriptionId
 * @param {string}           customerId
 * @returns {Promise<string|null>}
 */
async function resolveTokenFromOrderTemplate(orderTemplateId, subscriptionId, customerId) {
  // Fast path 1: subscription already resolved on a prior event
  let tokenId = await lookupTokenBySquareSubscription(subscriptionId);
  if (tokenId) return tokenId;

  // Fast path 2: order template already resolved (e.g. created event cached it)
  if (orderTemplateId) {
    tokenId = await lookupTokenByOrderTemplate(orderTemplateId);
    if (tokenId) {
      // Backfill subscription mapping for future fast-path hits
      await storeSquareSubscriptionMapping(subscriptionId, tokenId);
      return tokenId;
    }

    // Slow path: RetrieveOrder to read reference_id = our token
    try {
      const orderResult = await square.retrieveOrder(orderTemplateId);
      // batch-retrieve returns an array; grab the first match
      const order = (orderResult.orders || [])[0] || orderResult.order;
      tokenId = order?.reference_id ?? null;

      if (tokenId && tokenId.length >= 16) {
        // Cache all three mappings to avoid future RetrieveOrder calls
        await Promise.all([
          storeOrderTemplateMapping(orderTemplateId, tokenId),
          storeSquareCustomerMapping(customerId, tokenId),
          storeSquareSubscriptionMapping(subscriptionId, tokenId),
        ]);
        console.log(`[webhook/square] resolved token ${tokenId.slice(0, 8)}… via orderTemplate=${orderTemplateId.slice(0, 8)}…`);
      } else {
        console.error(`[webhook/square] RetrieveOrder(${orderTemplateId.slice(0, 8)}…) returned no usable reference_id`);
        tokenId = null;
      }
    } catch (err) {
      console.error("[webhook/square] RetrieveOrder failed:", err.message);
      tokenId = null;
    }
  } else {
    console.warn(`[webhook/square] subscription event has no order_template_id — cannot resolve token`);
  }

  return tokenId;
}

// ── Token restore (lost-token recovery) ───────────────────────────────────────
// POST /restore-token
// Called from popup.js when a subscriber has lost their token (e.g., after
// reinstalling Chrome) and wants to recover Pro access.
// Body: { orderReference }  — Square order ID from their receipt email
//
// Resolution path (per SQUAREDESIGN.md §4):
//   1. Call RetrieveOrder(orderReference) — validates the order exists
//   2. Get order.customer_id
//   3. Look up square:customer:{customer_id} in Redis → tokenId
//   4. Return { token: tokenId } to the extension popup
//   5. Extension swaps chrome.storage.sync to use the recovered token
//
// Rate limited separately to prevent brute-forcing Square order IDs.
const restoreTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many restore attempts. Please wait 15 minutes and try again." },
});

app.post("/restore-token", restoreTokenLimiter, wrap(async (req, res) => {
  const { orderReference } = req.body || {};

  if (!orderReference || typeof orderReference !== "string") {
    return res.status(400).json({ error: "orderReference is required" });
  }
  if (orderReference.length < 8 || orderReference.length > 128) {
    return res.status(400).json({ error: "Invalid order reference format" });
  }

  try {
    const orderResult = await square.retrieveOrder(orderReference.trim());
    const order = (orderResult.orders || [])[0] || orderResult.order;

    if (!order) {
      return res.status(404).json({ error: "Order not found. Double-check your Square receipt." });
    }

    // Only accept completed/paid orders — not OPEN or CANCELED
    if (order.state !== "COMPLETED") {
      return res.status(404).json({
        error: "No completed payment found for that reference. Check your receipt and try again.",
      });
    }

    const customerId = order.customer_id;
    if (!customerId) {
      console.error(`[restore-token] order ${orderReference.slice(0, 8)}… has no customer_id`);
      return res.status(404).json({ error: "Could not find your account. Contact support@liarsledger.com." });
    }

    const tokenId = await lookupTokenBySquareCustomer(customerId);
    if (!tokenId) {
      // Mapping not in Redis — possibly an edge case where the webhook fired
      // before the mapping was written, or Redis was flushed.
      console.error(`[restore-token] no token mapping for customer ${customerId.slice(0, 8)}…`);
      return res.status(404).json({
        error: "Account record not found. Please contact support@liarsledger.com with your order number.",
      });
    }

    console.log(`[restore-token] token ${tokenId.slice(0, 8)}… restored via order ${orderReference.slice(0, 8)}…`);
    res.json({ ok: true, token: tokenId });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: "Order not found. Double-check the order number from your receipt." });
    }
    console.error("[restore-token] error:", err.message);
    res.status(502).json({ error: "Failed to look up your order. Please try again." });
  }
}));

// ── Global error middleware ───────────────────────────────────────────────────
// Catches any unhandled errors from async route handlers (via wrap())
// and ensures the client always gets a JSON response instead of hanging.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[Liar's Ledger API] unhandled error:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Liar's Ledger API] listening on port ${PORT}`);
  console.log(`[Liar's Ledger API] Claude:    ${process.env.CLAUDE_API_KEY   ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] Mistral:   ${process.env.MISTRAL_API_KEY  ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] Congress:  ${process.env.CONGRESS_API_KEY ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] VoteSmart: ${process.env.VOTESMART_EMAIL  ? "✓" : "✗ missing"}`);
  console.log(`[Liar's Ledger API] Redis:     ${process.env.UPSTASH_REDIS_REST_URL ? "✓" : "✗ missing"}`);
});