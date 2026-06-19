// Liar's Ledger - server/index.js
// Backend proxy server.
//
// Routes:
//   POST /register             - anonymous token registration
//   GET  /api/scan-status      - remaining scans for token
//   POST /api/claude/extract   - Claude extraction (counted)
//   POST /api/mistral/extract  - Mistral extraction (counted)
//   POST /api/verify-claim     - claim verification
//   GET  /api/congress/*       - Congress.gov proxy
//   GET  /api/votesmart/*      - VoteSmart proxy (JWT auth + refresh)
//   GET  /api/govtrack/*       - GovTrack proxy (no key)
//   GET  /api/legislators      - congress-legislators dataset (cached)
//   GET  /health               - health check
//   POST /admin/set-tier       - manual tier override (TEMPORARY - testing only, see warning below)
//   POST /admin/reset-scans    - manual scan count reset (TEMPORARY - testing only)

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
import { createToken, getToken, getScans, incrementUserCount, getFreeTierLimit, upgradeTier, resetScans } from "./providers/store.js";
import { requireToken, countScan } from "./middleware/auth.js";

const app  = express();
const PORT = process.env.PORT || 3001;

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

app.use(express.json({ limit: "64kb" }));

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
  const [scans, { limit, warn, userCount }] = await Promise.all([
    getScans(req.tokenId),
    getFreeTierLimit(),
  ]);
  const remaining = Math.max(0, limit - scans);

  res.json({
    tier: req.tier,
    scansToday: scans,
    limit,
    remaining,
    capacityWarning: warn,     // true at 2500–4999 users — surface in extension UI
    userCount,
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