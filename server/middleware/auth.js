// Liar's Ledger - server/middleware/auth.js
// Extracts the Bearer token from requests, validates it,
// and enforces scan rate limits by tier.
//
// Usage in index.js:
//   import { requireToken, countScan, requireScanToken } from "./middleware/auth.js";
//
//   // On POST /api/scan/start — counts the scan AND issues a scan token:
//   app.post("/api/scan/start", requireToken, countScan, wrap(async (req, res) => { ... }));
//
//   // On scan-triggering extraction routes (claude/extract, mistral/extract):
//   // requireScanToken, NOT countScan — the scan was already counted when
//   // the token was issued above. This just verifies a valid, unconsumed
//   // scan token was presented — see store.js's scan-token module comment
//   // for the full design rationale (closes the bypass found in the June
//   // 2026 security review — see SECURITY.md).
//   app.post("/api/claude/extract", requireToken, requireScanToken, wrap(async (req, res) => { ... }));
//
//   // On read-only routes (congress, govtrack, votesmart, legislators):
//   app.get("/api/congress/*", requireToken, wrap(async (req, res) => { ... }));
//
// AUTH_FAIL_OPEN env var (default: unset = fail CLOSED): set to "true" only
// for local development against a Redis instance you expect to be flaky.
// Production should never set this — see SECURITY.md "Known Gaps" history
// for why fail-open on auth was identified as a real (Medium-severity) gap.

import { getToken, reserveScan, consumeScanToken } from '../providers/store.js';

const FAIL_OPEN = process.env.AUTH_FAIL_OPEN === "true";

/**
 * requireToken - validates the Bearer token exists and is registered.
 * Attaches req.tokenId and req.tier for downstream use.
 *
 * Fails CLOSED on Redis errors by default (returns 503) — a fail-open auth
 * check was identified as a Medium-severity finding in the June 2026
 * security review: any Bearer token, including ones that were never
 * registered, would pass as free-tier during a Redis outage. See
 * SECURITY.md. Set AUTH_FAIL_OPEN=true to restore the old fail-open
 * behavior for local dev only — never in production.
 */
export async function requireToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authorization required. Install the extension or register at liarsledger.com.",
    });
  }

  const tokenId = authHeader.slice(7).trim();
  if (!tokenId) {
    return res.status(401).json({ error: "Invalid token." });
  }

  try {
    const tokenData = await getToken(tokenId);
    if (!tokenData) {
      return res.status(401).json({
        error: "Token not recognized. Reinstall the extension or register at liarsledger.com.",
      });
    }

    req.tokenId = tokenId;
    req.tier = tokenData.tier || "free";
    next();
  } catch (e) {
    console.error("[auth] token lookup failed:", e.message);
    if (FAIL_OPEN) {
      req.tokenId = tokenId;
      req.tier = "free";
      return next();
    }
    return res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
  }
}

/**
 * countScan - increments the daily scan counter, issues a single-use scan
 * token, and blocks if over the daily limit. Only attach this to
 * POST /api/scan/start — NOT to the extraction endpoints themselves, which
 * should use requireScanToken instead (see module comment above).
 *
 * The issued scanToken is returned in the response body and must be passed
 * by the client to the extraction call(s) that follow. Dual-model mode
 * reuses the SAME scanToken for both the Claude and Mistral calls — see
 * store.js's consumeScanToken for how the single-use/no-double-charge
 * property is preserved.
 *
 * Fails CLOSED on Redis errors by default — same rationale as requireToken
 * above. A Redis error here previously meant "scan proceeds, uncounted,
 * unlimited" which is the same cost-abuse exposure as the bypass this
 * whole change is meant to close, just reached via an outage instead of a
 * direct bypass. AUTH_FAIL_OPEN=true restores the old behavior for local
 * dev only.
 */
export async function countScan(req, res, next) {
  // requireToken must run before this -- req.tokenId and req.tier are set by it
  const token = req.tokenId;
  if (!token) return next(); // shouldn't happen if requireToken ran; nothing to count

  try {
    const result = await reserveScan(token, req.tier);

    if (!result.allowed) {
      return res.status(429).json({
        error: "Daily scan limit reached",
        limit: result.limit,
        remaining: 0,
        upgradeUrl: "https://liarsledger.com/pricing",
      });
    }

    req.scanAllowed   = true;
    req.scanWarn      = result.warn;
    req.scanRemaining = result.remaining;
    req.scanToken     = result.scanToken;   // gates extraction calls via requireScanToken
    req.commitToken   = result.commitToken; // returned to client to finalize the count later
    next();
  } catch (err) {
    console.error("[auth] countScan error:", err);
    if (FAIL_OPEN) {
      req.scanAllowed = true;
      return next();
    }
    return res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
  }
}

/**
 * requireScanToken - verifies a valid, unconsumed scan token was presented
 * for this extraction call. This is the actual fix for the bypass found in
 * the June 2026 security review: extraction endpoints previously had no
 * server-side check that a scan had been counted at all.
 *
 * Expects the scan token in the request body as `scanToken`. Atomically
 * consumes it via store.js's consumeScanToken (Redis GETDEL) — the first
 * of the (possibly two, in dual-model mode) extraction calls to arrive
 * consumes it and proceeds; the second finds it already gone.
 *
 * IMPORTANT: a missing/already-consumed scan token is NOT necessarily an
 * attack — it's the expected, correct outcome for the second call in
 * dual-model mode. So this middleware doesn't reject outright on "already
 * consumed AND req.tier exists" — it only rejects when there's no
 * indication this could legitimately be the second of a pair. In practice,
 * since we can't distinguish "legitimate second call" from "replay attack
 * using a stale token value" at this layer alone, the policy is: the FIRST
 * consumption of a given scanToken always proceeds (that's the real,
 * counted scan). Any SUBSEQUENT presentation of that same scanToken value
 * — including a deliberate replay — finds it already deleted from Redis
 * and is rejected with 403, same as a token that never existed. This is
 * safe because a scan token can only ever authorize ONE successful
 * extraction call to proceed past this check; dual-model mode's "second
 * call" and an attacker's "replay" are handled identically (both get
 * rejected) UNLESS the client deliberately sends the SAME scanToken to
 * both Claude and Mistral calls AT THE APPLICATION LAYER before either
 * reaches the server — at which point only one wins the race, which is
 * the intended, correct behavior for closing this gap.
 *
 * Fails CLOSED on Redis errors — same rationale as requireToken/countScan.
 */
export async function requireScanToken(req, res, next) {
  const scanToken = req.body?.scanToken;

  if (!scanToken) {
    return res.status(403).json({
      error: "Missing scan authorization. Call /api/scan/start first.",
    });
  }

  try {
    const issuedForTokenId = await consumeScanToken(scanToken);

    if (!issuedForTokenId) {
      return res.status(403).json({
        error: "Scan authorization invalid, expired, or already used.",
      });
    }

    if (issuedForTokenId !== req.tokenId) {
      // Scan token was issued to a different tokenId than the one presenting
      // it now — should be unreachable in normal operation (tokens are
      // tied to the Bearer token that requested them), but checked
      // explicitly rather than trusting it can't happen.
      console.error(`[auth] scan token tokenId mismatch: issued for ${issuedForTokenId?.slice(0,8)}…, presented by ${req.tokenId?.slice(0,8)}…`);
      return res.status(403).json({ error: "Scan authorization invalid." });
    }

    next();
  } catch (err) {
    console.error("[auth] requireScanToken error:", err);
    if (FAIL_OPEN) return next();
    return res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
  }
}
