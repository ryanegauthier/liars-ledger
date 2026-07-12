// Liar's Ledger - server/index.js
// Backend proxy server.
//
// Routes:
//   POST /register             - anonymous token registration
//   GET  /api/scan-status      - remaining scans for token
//   POST /api/scan/start       - reserve a scan slot (returns scanToken + commitToken)
//   POST /api/scan/commit      - finalize a reserved scan (called when sources responded)
//   POST /api/claude/extract   - Claude extraction (not counted here)
//   POST /api/mistral/extract  - Mistral extraction (not counted here)
//   POST /api/verify-claim     - claim verification (Pro only)
//   GET  /api/congress/*       - Congress.gov proxy
//   GET  /api/votesmart/*      - VoteSmart proxy (free - sourced data, not AI-generated)
//   GET  /api/govtrack/*       - GovTrack proxy (no key)
//   GET  /api/legislators      - congress-legislators dataset (cached)
//   GET  /health               - health check
//   POST /pricing/checkout     - create Square payment link for Pro subscription
//   POST /webhook/square       - Square webhook receiver (subscription lifecycle,
//                                 events: subscription.created, subscription.updated,
//                                 invoice.payment_made, invoice.scheduled_charge_failed)
//   POST /restore-token        - recover Pro access via Square order reference

import "dotenv/config";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import nodemailer from "nodemailer";
import { claude }    from "./providers/claude.js";
import { mistral }   from "./providers/mistral.js";
import { congress }  from "./providers/congress.js";
import { votesmart } from "./providers/votesmart.js";
import { govtrack }  from "./providers/govtrack.js";
import { verifyClaim } from "./providers/verify.js";
import { createToken, getToken, getScans, incrementUserCount, getScanLimit, upgradeTier, commitScan, storeOrderTemplateMapping, lookupTokenByOrderTemplate, storeSquareCustomerMapping, lookupTokenBySquareCustomer, storeSquareSubscriptionMapping, lookupTokenBySquareSubscription, recordFailedCharge, clearFailedCharges, setDowngradeReason, clearDowngradeReason, getDowngradeReason } from "./providers/store.js";
import { requireToken, countScan, requireScanToken } from "./middleware/auth.js";
import * as square from "./providers/square.js";

const app  = express();
const PORT = process.env.PORT || 3001;
const supportEmail = process.env.SUPPORT_EMAIL || "support@liars-ledger.com";
const supportWebhookUrl = process.env.SUPPORT_WEBHOOK_URL || null;

const mailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
    })
  : null;

// Render sits behind a single reverse proxy hop, which sets X-Forwarded-For
// on every incoming request. Express's default (trust proxy: false) ignores
// that header entirely and falls back to the proxy's own connection IP for
// anything IP-based - meaning every distinct visitor would resolve to the
// same address as far as express-rate-limit is concerned, silently breaking
// the /register, general API, and /restore-token limiters (all keyed by IP).
// Setting this to 1 means "trust exactly one hop" - correct for Render's
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

// Capture raw body before JSON parsing - required for Square webhook signature
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

const supportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many support requests. Please wait and try again later." },
});

app.post("/api/support/debug-log", supportLimiter, wrap(async (req, res) => {
  const payload = req.body || {};
  const logs = Array.isArray(payload.logs) ? payload.logs : [];
  // Full log, not a tail slice - a busy scan easily produces 40-50+ entries
  // (one "fetching:" log per Congress.gov/GovTrack request alone), so the
  // previous last-20 truncation cut off exactly the useful early narrative
  // (LLM provider choice, search terms, resolved names) and kept only
  // late-scan noise. logger.js's MAX_ENTRIES=200 client-side cap already
  // bounds this to a reasonable size - no need to truncate again here. The
  // webhook payload below was never truncated; this just brings the email
  // in line with it.
  const preview = logs.join("\n") || "(no logs)";
  const bodyText = [
    `Support request from Liars Ledger`,
    `Version: ${payload.version || "unknown"}`,
    `Token: ${payload.tokenId || "unknown"}`,
    "",
    "Full session log:",
    preview,
  ].join("\n");

  console.log(`[support] token=${payload.tokenId || "unknown"} version=${payload.version || "unknown"}`);
  console.log(`[support] logs:\n${preview}`);

  // Retry helper for transient webhook failures (429, 5xx)
  const SUPPORT_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
  const SUPPORT_MAX_RETRIES = 2;
  const SUPPORT_RETRY_BASE_MS = 200;
  const SUPPORT_RETRY_JITTER_MS = 100;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const retryDelay = (attempt) => SUPPORT_RETRY_BASE_MS * attempt + Math.floor(Math.random() * SUPPORT_RETRY_JITTER_MS);

  async function fetchWithRetries(url, opts) {
    let attempt = 0;
    while (true) {
      try {
        const r = await fetch(url, opts);
        if (r.ok) return r;
        const status = r.status;
        if (SUPPORT_RETRYABLE_STATUS.has(status) && attempt < SUPPORT_MAX_RETRIES) {
          attempt += 1;
          await sleep(retryDelay(attempt));
          continue;
        }
        return r; // non-ok and non-retryable or retries exhausted
      } catch (e) {
        // network/other errors - retry as well
        if (attempt < SUPPORT_MAX_RETRIES) {
          attempt += 1;
          await sleep(retryDelay(attempt));
          continue;
        }
        throw e;
      }
    }
  }

  const delivery = {
    email: { attempted: false, success: false, error: null },
    webhook: { attempted: false, success: false, error: null },
  };

  if (mailTransport) {
    delivery.email.attempted = true;
    try {
      await mailTransport.sendMail({
        from: process.env.SMTP_FROM || supportEmail,
        to: supportEmail,
        subject: `Liars Ledger support request (${payload.version || "unknown"})`,
        text: bodyText,
      });
      delivery.email.success = true;
    } catch (e) {
      delivery.email.error = e.message;
      console.error(`[support] email delivery failed: ${e.message}`);
      if (e.stack) console.error(e.stack);
    }
  }

  if (supportWebhookUrl) {
    delivery.webhook.attempted = true;
    try {
      const webhookRes = await fetchWithRetries(supportWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenId: payload.tokenId || null,
          version: payload.version || null,
          logs,
        }),
      });

      if (!webhookRes.ok) {
        let text = "";
        if (webhookRes && typeof webhookRes.text === "function") {
          text = await webhookRes.text().catch(() => "");
        }
        throw new Error(`webhook responded ${webhookRes.status}${text ? `: ${text.slice(0, 240)}` : ""}`);
      }

      delivery.webhook.success = true;
    } catch (e) {
      delivery.webhook.error = e.message;
      console.error(`[support] webhook delivery failed: ${e.message}`);
      if (e.stack) console.error(e.stack);
    }
  }

  const deliveryOk = (delivery.email.attempted ? delivery.email.success : false)
    || (delivery.webhook.attempted ? delivery.webhook.success : false)
    || (!delivery.email.attempted && !delivery.webhook.attempted);

  if (!deliveryOk) {
    return res.status(502).json({
      ok: false,
      received: logs.length,
      delivery,
    });
  }

  res.json({ ok: true, received: logs.length, delivery });
}));

app.use("/api", limiter);

// /register gets its own, much stricter limiter, keyed by IP. A real install
// calls this once (occasionally again on startup to refresh state) - there's
// no legitimate reason for one IP to register many tokens quickly. This is
// the main defense against a script mass-creating fake tokens to drain the
// shared scan pool or inflate global:user_count (which lowers everyone's
// daily limit). Not a complete fix - a distributed attacker with many IPs
// or proxies isn't stopped by this - but it closes the trivial single-machine
// case for free, with no user-facing downside for real installs.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Please try again later." },
});
app.use("/register", registerLimiter);

// /pricing/checkout calls Square's CreatePaymentLink on every invocation -
// previously had no dedicated limiter at all (only the general /api/* one,
// which doesn't even apply here since this route isn't under /api/). Found
// via security review: unbounded calls could exhaust Square API quotas and
// clutter the dashboard with junk orders. Keyed by token rather than IP -
// more precise for this route, since the meaningful identity here is the
// token, not the network address. Falls back to IP if no token is present
// in the body (e.g. a malformed request that requireToken/manual checks
// below will reject anyway, but the limiter itself shouldn't error out
// trying to build a key from undefined).
//
// NOTE: defined here, early in the file alongside the other rate limiters,
// rather than near the /pricing/checkout route itself further down - a
// previous version of this file had it defined AFTER the route that uses
// it, which threw "Cannot access 'checkoutLimiter' before initialization"
// on startup (const hoisting puts the binding in an uninitialized state
// until its declaration line actually executes top-to-bottom). Keep all
// rate limiter definitions grouped here, before any route registrations,
// to avoid this class of bug recurring.
const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // generous for any legitimate use - a handful of "Get Pro" clicks
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.token || req.ip,
  message: { error: "Too many checkout attempts. Please wait an hour and try again." },
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: process.env.npm_package_version || "0.17.9", ts: new Date().toISOString() });
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
    // Scan limit now depends on tier - free scales down as the user base
    // grows, pro gets a flat daily allowance. See store.js's getScanLimit.
    const [scans, { limit, warn }] = await Promise.all([
      getScans(tokenId),
      getScanLimit(existing.tier),
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
    getScanLimit("free"), // new tokens always start free
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
  // Scan limit now depends on tier - free scales down as the user base
  // grows, pro gets a flat daily allowance separate from free's pool.
  const [scans, { limit, warn, userCount }, downgrade] = await Promise.all([
    getScans(req.tokenId),
    getScanLimit(req.tier),
    // Only meaningful for free tier - a pro user obviously hasn't been
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
    capacityWarning: warn,     // true at 2500–4999 users - surface in extension UI
    userCount,
    // Present only when this token was downgraded due to repeated payment
    // failure (not a normal cancellation, and not "never subscribed").
    // Lets the popup show "your card was declined" instead of a generic
    // upgrade pitch. null/absent for everyone else.
    downgradeReason: downgrade?.reason || null,
  });
}));

// ── Scan counting (two-phase: reserve then commit) ───────────────────────────
// POST /api/scan/start  -- reserves a scan slot and issues two tokens:
//   scanToken   (single-use, required by /api/claude|mistral/extract)
//   commitToken (passed to POST /api/scan/commit when results are useful)
//
// The scan is not counted against the daily limit until /api/scan/commit is
// called. If the client never commits -- because congress.gov and govtrack
// both timed out and returned nothing -- the pending reservation expires after
// 3 minutes and the slot is returned to the user for free.
//
// Pending reservations count toward the limit at reserve time, so a client
// cannot accumulate unlimited free reservations to bypass the cap.
//
// Dual-model mode: the same scanToken is passed to both /api/claude/extract
// and /api/mistral/extract; the first call to arrive consumes it, the second
// is rejected by requireScanToken (not re-counted). One commitToken per scan.
app.post("/api/scan/start", requireToken, countScan, wrap(async (req, res) => {
  res.json({
    allowed:     req.scanAllowed,
    remaining:   req.scanRemaining,
    warn:        req.scanWarn,
    scanToken:   req.scanToken,
    commitToken: req.commitToken,
  });
}));

// POST /api/scan/commit -- finalizes a reserved scan, converting it from
// pending to counted. Called by background.js after lookupAll confirms at
// least one external source (congress.gov or govtrack) responded successfully.
// If all sources timed out, background.js skips this call and the reservation
// expires on its own.
app.post("/api/scan/commit", requireToken, wrap(async (req, res) => {
  const { commitToken } = req.body || {};
  if (!commitToken) {
    return res.status(400).json({ error: "commitToken required" });
  }
  const result = await commitScan(commitToken);
  if (!result.committed) {
    // Expired, already committed, or never issued -- not an error worth
    // surfacing to the user; the reservation just lapsed.
    return res.status(200).json({ committed: false });
  }
  res.json({ committed: true });
}));

// ── LLM extraction (requires a valid scan token from /api/scan/start above,
//    NOT counted again here - requireScanToken consumes the token issued
//    there; see its doc comment in auth.js for the dual-model handling) ────

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
app.post("/api/claude/extract", requireToken, requireScanToken, wrap(async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await claude.extract(articleText);
  res.status(result.ok ? 200 : 502).json(gateExtractionResult(result, req.tier));
}));

// POST /api/mistral/extract
app.post("/api/mistral/extract", requireToken, requireScanToken, wrap(async (req, res) => {
  const { articleText } = req.body;
  if (!articleText) return res.status(400).json({ error: "articleText required" });
  const result = await mistral.extract(articleText);
  res.status(result.ok ? 200 : 502).json(gateExtractionResult(result, req.tier));
}));

// ── Pro-tier gating ────────────────────────────────────────────────────────────
// Server-side enforcement - the actual security boundary. Client-side stripping
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

// /api/verify-claim input limits - found via security review: claim/member
// were only checked for truthiness, with no length cap. A Pro user could
// send an arbitrarily large claim/member string (bounded only by the 64KB
// JSON body limit), inflating per-call LLM cost and opening a narrow,
// self-contained prompt-injection surface (the blast radius is limited to
// that same Pro user's own verification result - not a cross-user issue).
// record's individual fields aren't capped here; server/providers/verify.js
// already truncates the assembled prompt via MAX_RECORD_CHARS before it
// reaches the LLM, so the existing truncation covers that side.
const MAX_CLAIM_LENGTH  = 500;
const MAX_MEMBER_LENGTH = 100;

app.post("/api/verify-claim", requireToken, requirePro, wrap(async (req, res) => {
  const { claim, member, record } = req.body;

  if (!claim) return res.status(400).json({ error: "claim required" });
  if (!member) return res.status(400).json({ error: "member required" });
  if (!record) return res.status(400).json({ error: "record required" });

  if (typeof claim !== "string" || claim.length > MAX_CLAIM_LENGTH) {
    return res.status(400).json({ error: `claim must be a string of ${MAX_CLAIM_LENGTH} characters or fewer` });
  }
  if (typeof member !== "string" || member.length > MAX_MEMBER_LENGTH) {
    return res.status(400).json({ error: `member must be a string of ${MAX_MEMBER_LENGTH} characters or fewer` });
  }

  const result = await verifyClaim(claim, member, record);
  res.status(result.ok ? 200 : 502).json(result);
}));

// ── Congress.gov proxy ────────────────────────────────────────────────────────
// Query-parameter allowlist for the Congress.gov and GovTrack proxies below.
// Found via security review: both proxies previously forwarded req.query
// verbatim, letting callers inject arbitrary parameters into the upstream
// request. No SSRF risk (base URL is hardcoded, ../ in a path segment
// doesn't change the host in a normalized HTTPS URL) - the actual concern
// is unpredictable proxy behavior and requesting unnecessarily large
// result sets.
const CONGRESS_ALLOWED_PARAMS = new Set(["offset", "limit", "fromDateTime", "toDateTime", "sort"]);
// Congress.gov's own docs confirm `limit` is capped at 250 server-side
// regardless of what's requested, which already bounds the worst case on
// their end - this allowlist is still worth having for predictability and
// defense-in-depth, not because that cap alone was insufficient.
// Source: https://github.com/LibraryOfCongress/api.congress.gov (confirmed
// June 2026: offset, limit, fromDateTime, toDateTime, sort are the
// documented list-endpoint parameters).
const CONGRESS_MAX_LIMIT = 250;
const VOTESMART_ALLOWED_PARAMS = new Set(["lastName", "candidateId", "officeId", "stateId", "perPage", "page"]);

function buildAllowlistedQuery(reqQuery, allowedParams, { extraParams = {}, maxLimit = null } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(reqQuery || {})) {
    if (allowedParams.has(key)) {
      if (key === "limit" && maxLimit != null) {
        const n = parseInt(value, 10);
        query.set("limit", String(Number.isFinite(n) && n > 0 ? Math.min(n, maxLimit) : maxLimit));
      } else {
        query.set(key, value);
      }
    }
  }
  for (const [key, value] of Object.entries(extraParams)) {
    query.set(key, value);
  }
  return query;
}

app.get("/api/congress/*", requireToken, wrap(async (req, res) => {
  const path  = req.params[0];
  const query = buildAllowlistedQuery(req.query, CONGRESS_ALLOWED_PARAMS, {
    extraParams: { api_key: process.env.CONGRESS_API_KEY, format: "json" },
    maxLimit: CONGRESS_MAX_LIMIT,
  });

  try {
    const result = await congress.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── VoteSmart proxy ───────────────────────────────────────────────────────────
// Free tier as of the AI-vs-sourced-data tier split: VoteSmart ratings and
// vote history are sourced facts (same category as roll-call votes and bill
// links, both already free), not AI-generated content - only the AI article
// summary and AI claim-vs-record verdict are Pro. requirePro removed below.
//
// IMPORTANT - revisit the allowlist decision: the note below about leaving
// query-parameter passthrough un-allowlisted was written when this route
// was Pro-gated, on the reasoning that a smaller, paying caller pool bounded
// the risk. That assumption no longer holds now that any registered token
// (the entire free tier, not just Pro subscribers) can reach this route -
// the un-allowlisted passthrough is now exposed to a much larger pool than
// when this was last assessed. Worth allowlisting properly (lastName,
// candidateId, confirmed against VoteSmart's actual API docs) rather than
// carrying the old, now-stale risk assessment forward.
//
// VoteSmart proxy is now safely allowlisted to the only known query params
// used by the extension: lastName, candidateId, officeId, stateId, page, and
// perPage. page/perPage added v0.17.0+ to fix a silent truncation bug:
// VoteSmart's by-lastname endpoint defaults to 10 results/page, which was
// burying common and compound surnames (e.g. "Warren") past page 1 and
// causing them to silently resolve as "no candidate found" with no error.
// The client now paginates through every page (confirmed via the response's
// `meta.lastPage`/`meta.next` fields) rather than requesting one larger page
// and hoping it's enough. officeId/stateId remain allowlisted for a planned
// office+state-scoped lookup (currently disabled client-side pending an
// endpoint/param mismatch investigation - see src/votesmart.js for details)
// but are otherwise unused today.
app.get("/api/votesmart/*", requireToken, wrap(async (req, res) => {
  const path  = req.params[0];
  const invalidParam = Object.keys(req.query || {}).find((key) => !VOTESMART_ALLOWED_PARAMS.has(key));
  if (invalidParam) {
    return res.status(400).json({ error: `Invalid VoteSmart query parameter: ${invalidParam}` });
  }

  const query = buildAllowlistedQuery(req.query, VOTESMART_ALLOWED_PARAMS);

  try {
    const result = await votesmart.fetch(`/${path}?${query.toString()}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// ── GovTrack proxy ────────────────────────────────────────────────────────────
// GET /api/govtrack/* → https://www.govtrack.us/api/v2/* (no key required)
// GovTrack allowlist is intentionally conservative: only the parameters
// actually used by the extension are permitted (person, limit, order_by).
// The upstream API accepts much larger page sizes than the old 100-element
// cap, and this limit is now based on live endpoint verification rather than
// an educated guess. Keep this bounded to avoid unbounded page-size abuse.
const GOVTRACK_ALLOWED_PARAMS = new Set(["person", "limit", "order_by"]);
const GOVTRACK_MAX_LIMIT = 1000;

app.get("/api/govtrack/*", requireToken, wrap(async (req, res) => {
  const path  = req.params[0];
  const query = buildAllowlistedQuery(req.query, GOVTRACK_ALLOWED_PARAMS, {
    maxLimit: GOVTRACK_MAX_LIMIT,
  });

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

// ── Square subscription checkout ──────────────────────────────────────────────
// POST /pricing/checkout
// Called from liarsledger.com/pricing when a user clicks "Subscribe to Pro".
// Body: { token }  (the anonymous extension install token)
//
// Flow (per SQUAREDESIGN.md):
//   1. Validate the token exists in Redis
//   2. Create a Square payment link with order.reference_id = token
//   3. Return { url } - frontend navigates to Square's hosted checkout
//   4. Square collects payment + contact info (buyer's email, card) - we never see it
//   5. POST /webhook/square fires on subscription events → upgradeTier
//
// CORS note: called from liarsledger.com. ALLOWED_ORIGINS must include
// https://liarsledger.com in Render env vars.
app.post("/pricing/checkout", checkoutLimiter, wrap(async (req, res) => {
  const { token } = req.body || {};

  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "token is required" });
  }
  // Basic plausibility check - UUIDs are 36 chars; our tokens are similar length
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
  // subscription checkout - confirmed against live docs (the order/quick_pay
  // distinction is cosmetic; quick_pay's name+price_money map internally to
  // the same order line item shape). This must match the plan variation's
  // actual price set in Square's catalog (see setup-square-catalog.mjs) -
  // per Square's own subscription-checkout docs, a mismatch acts as a price
  // OVERRIDE, not just display text, so these two numbers must stay in sync
  // by hand if the Pro price is ever changed in the Square dashboard.
  const proPriceCents = parseInt(process.env.SQUARE_PRO_PRICE_CENTS || "500", 10); // $5.00 default
  const proPriceName  = process.env.SQUARE_PRO_PRICE_NAME || "Liar's Ledger Pro - Monthly";

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
      redirectUrl:     `${process.env.PRICING_SITE_URL || "https://liarsledger.com"}/pro/success`,
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
//   2. Check Redis cache (square:ordertemplate:{id}) - skip RetrieveOrder if hit
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
    console.warn("[webhook/square] signature mismatch - rejecting");
    return res.status(403).send();
  }

  // Acknowledge immediately - Square retries on non-2xx (up to 24h).
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
        // was in progress is over - clear both the failure count and any
        // stale "you were downgraded" marker so it doesn't resurface after
        // the person has already fixed things.
        await clearFailedCharges(subscriptionId);
        if (tokenId) await clearDowngradeReason(tokenId);
      }
    } else if (status === "CANCELED" || status === "DEACTIVATED") {
      // User-initiated (or otherwise not failure-driven) - the person
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
      // Square's own subscription-level FAILED status - this IS
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
      console.log(`[webhook/square] ${type} status=${status} - no tier action`);
    }
    return;
  }

  // ── invoice.payment_made ─────────────────────────────────────────────────
  // Idempotent confirmation of Pro status on recurring billing cycles.
  // subscription.created/updated already handles the initial upgrade, but
  // invoice.payment_made is a belt-and-suspenders confirmation each cycle.
  // Also clears any failed-charge tracking - a successful payment means
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
  // subscription-specific - see CHANGELOG for the live-docs verification).
  //
  // IMPORTANT: confirmed against Square's own docs - Square does NOT
  // auto-cancel a subscription when payments fail. It retries automatically
  // on day 3, day 6, and day 9 after the initial decline, then simply leaves
  // the subscription ACTIVE with an unpaid invoice indefinitely. There is no
  // guaranteed subscription.updated → CANCELED event to wait for after that.
  //
  // So we track failures ourselves and downgrade proactively once we're past
  // Square's retry window with no successful payment in between. Using
  // count >= 3 as the threshold (matches Square's 3-retry schedule: day 3,
  // 6, 9) rather than a fixed day-9 timer - simpler, and avoids needing a
  // separate scheduled job just to check elapsed time.
  if (type === "invoice.scheduled_charge_failed") {
    const subscriptionId = obj?.invoice?.subscription_id;
    if (!subscriptionId) return;

    const failureRecord = await recordFailedCharge(subscriptionId);
    console.warn(`[webhook/square] invoice.scheduled_charge_failed sub=${subscriptionId.slice(0, 8)}… (failure #${failureRecord.count}, first failed ${failureRecord.firstFailedAt})`);

    // After Square's full retry schedule (3 failures = day 3, 6, 9 all
    // missed) has played out with no intervening payment_made, downgrade.
    // subscription.updated → CANCELED, if it ever arrives, will also
    // downgrade (idempotent) - this just stops us granting Pro forever to a
    // card that's permanently failing while Square leaves it ACTIVE.
    if (failureRecord.count >= 3) {
      const tokenId = await lookupTokenBySquareSubscription(subscriptionId);
      if (tokenId) {
        await upgradeTier(tokenId, "free");
        await setDowngradeReason(tokenId, "payment_failed");
        console.warn(`[webhook/square] sub=${subscriptionId.slice(0, 8)}… exceeded retry window (${failureRecord.count} failures) → token ${tokenId.slice(0, 8)}… downgraded to free`);
      } else {
        console.error(`[webhook/square] sub=${subscriptionId.slice(0, 8)}… exceeded retry window but no token mapping found - could not downgrade`);
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
    console.warn(`[webhook/square] subscription event has no order_template_id - cannot resolve token`);
  }

  return tokenId;
}

// ── Token restore (lost-token recovery) ───────────────────────────────────────
// POST /restore-token
// Called from popup.js when a subscriber has lost their token (e.g., after
// reinstalling Chrome) and wants to recover Pro access.
// Body: { orderReference }  - Square order ID from their receipt email
//
// Resolution path (per SQUAREDESIGN.md §4):
//   1. Call RetrieveOrder(orderReference) - validates the order exists
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

    // Only accept completed/paid orders - not OPEN or CANCELED
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
      // Mapping not in Redis - possibly an edge case where the webhook fired
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
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[Liar's Ledger API] listening on port ${PORT}`);
    console.log(`[Liar's Ledger API] Claude:    ${process.env.CLAUDE_API_KEY   ? "✓" : "✗ missing"}`);
    console.log(`[Liar's Ledger API] Mistral:   ${process.env.MISTRAL_API_KEY  ? "✓" : "✗ missing"}`);
    console.log(`[Liar's Ledger API] Congress:  ${process.env.CONGRESS_API_KEY ? "✓" : "✗ missing"}`);
    console.log(`[Liar's Ledger API] VoteSmart: ${process.env.VOTESMART_EMAIL  ? "✓" : "✗ missing"}`);
    console.log(`[Liar's Ledger API] Redis:     ${process.env.UPSTASH_REDIS_REST_URL ? "✓" : "✗ missing"}`);
  });
}

export { app };