// Liar's Ledger - server/middleware/auth.js
// Extracts the Bearer token from requests, validates it,
// and enforces scan rate limits by tier.
//
// Usage in index.js:
//   import { requireToken, countScan, requireScanToken } from "./middleware/auth.js";
//
//   // On POST /api/scan/start - counts the scan AND issues a scan token:
//   app.post("/api/scan/start", requireToken, countScan, wrap(async (req, res) => { ... }));
//
//   // On scan-triggering extraction routes (claude/extract, mistral/extract):
//   // requireScanToken(provider), NOT countScan - the scan was already
//   // counted when the token was issued above. This verifies a valid,
//   // unconsumed slot for that provider was presented - see store.js's
//   // scan-token module comment for the full design rationale (closes the
//   // bypass found in the June 2026 security review - see SECURITY.md).
//   app.post("/api/claude/extract", requireToken, requireScanToken("claude"), wrap(async (req, res) => { ... }));
//
//   // On read-only routes (congress, govtrack, votesmart, legislators):
//   app.get("/api/congress/*", requireToken, wrap(async (req, res) => { ... }));
//
// AUTH_FAIL_OPEN env var (default: unset = fail CLOSED): set to "true" only
// for local development against a Redis instance you expect to be flaky.
// Production should never set this - see SECURITY.md "Known Gaps" history
// for why fail-open on auth was identified as a real (Medium-severity) gap.

import { getToken, reserveScan, consumeScanToken } from '../providers/store.js';

const FAIL_OPEN = process.env.AUTH_FAIL_OPEN === "true";

/**
 * requireToken - validates the Bearer token exists and is registered.
 * Attaches req.tokenId and req.tier for downstream use.
 *
 * Fails CLOSED on Redis errors by default (returns 503) - a fail-open auth
 * check was identified as a Medium-severity finding in the June 2026
 * security review: any Bearer token, including ones that were never
 * registered, would pass as free-tier during a Redis outage. See
 * SECURITY.md. Set AUTH_FAIL_OPEN=true to restore the old fail-open
 * behavior for local dev only - never in production.
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

// The site's own marketing domain - matches the website entry in
// ALLOWED_ORIGINS (server/index.js). Used only to identify web-originated
// requests for the aggregate WEB_DAILY_SITE_LIMIT check (see reserveScan's
// doc comment in providers/store.js) - NOT part of CORS enforcement itself,
// which `cors` middleware already handles separately before this ever runs.
// The Origin header is browser-enforced and can't be set by page JS, so
// this is a reliable signal for genuine browser traffic; a non-browser
// caller hitting the API directly can omit or fake it, which just means
// that traffic isn't counted against the site-wide web bucket - it's still
// bound by its own token's per-day limit and extractLimiter exactly as
// before. Soft cost-control signal, not a security boundary.
const WEB_ORIGIN = "https://liarsledger.com";

/**
 * countScan - increments the daily scan counter, issues a single-use scan
 * token, and blocks if over the daily limit. Only attach this to
 * POST /api/scan/start - NOT to the extraction endpoints themselves, which
 * should use requireScanToken instead (see module comment above).
 *
 * The issued scanToken is returned in the response body and must be passed
 * by the client to the extraction call(s) that follow. Dual-model mode
 * sends the SAME scanToken to both the Claude and Mistral calls; it carries
 * one single-use slot per provider (see store.js's consumeScanToken), and
 * the scan is counted once here regardless.
 *
 * Also gates web-originated requests (see WEB_ORIGIN above) against the
 * aggregate WEB_DAILY_SITE_LIMIT in providers/store.js, on top of the
 * per-token limit every caller already gets - returns a distinct
 * ERR-SITE-CAPACITY code when that's what tripped, so the client can tell
 * "the site as a whole is out for today" apart from "you personally hit
 * your own daily limit."
 *
 * Fails CLOSED on Redis errors by default - same rationale as requireToken
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

  const isWebOrigin = req.headers.origin === WEB_ORIGIN;

  try {
    const result = await reserveScan(token, req.tier, isWebOrigin);

    if (!result.allowed) {
      if (result.siteCapacityReached) {
        return res.status(429).json({
          error: "liarsledger.com/scan has reached today's total capacity across all visitors. Try again tomorrow, or install the extension for your own daily allowance.",
          code: "ERR-SITE-CAPACITY",
        });
      }
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
 * requireScanToken(provider) - returns middleware that verifies a valid,
 * unconsumed scan token slot for THIS provider was presented. Attach as
 * requireScanToken("claude") / requireScanToken("mistral") on the matching
 * extraction route. Closes the bypass found in the June 2026 security
 * review: extraction endpoints previously had no server-side check that a
 * scan had been counted at all.
 *
 * Expects the scan token in the request body as `scanToken`. Consumes this
 * provider's slot via store.js's consumeScanToken. Each scan token carries
 * one slot per provider, so in dual-model mode the Claude and Mistral calls
 * of the same scan both proceed, each once. A replay (a second call to the
 * same provider, or reuse for another scan) finds the slot gone and is
 * rejected with 403, same as a token that never existed.
 *
 * Responds with code ERR-SCAN-AUTH on rejection so the client can show
 * "could not be verified" instead of a generic or quota message.
 *
 * Fails CLOSED on Redis errors - same rationale as requireToken/countScan.
 */
export function requireScanToken(provider) {
  return async function requireScanTokenForProvider(req, res, next) {
    const scanToken = req.body?.scanToken;

    if (!scanToken) {
      return res.status(403).json({
        error: "Missing scan authorization. Call /api/scan/start first.",
        code: "ERR-SCAN-AUTH",
      });
    }

    try {
      const issuedForTokenId = await consumeScanToken(scanToken, provider);

      if (!issuedForTokenId) {
        return res.status(403).json({
          error: "Scan authorization invalid, expired, or already used.",
          code: "ERR-SCAN-AUTH",
        });
      }

      if (issuedForTokenId !== req.tokenId) {
        // Scan token was issued to a different tokenId than the one presenting
        // it now - should be unreachable in normal operation (tokens are
        // tied to the Bearer token that requested them), but checked
        // explicitly rather than trusting it can't happen.
        console.error(`[auth] scan token tokenId mismatch: issued for ${issuedForTokenId?.slice(0,8)}..., presented by ${req.tokenId?.slice(0,8)}...`);
        return res.status(403).json({ error: "Scan authorization invalid.", code: "ERR-SCAN-AUTH" });
      }

      next();
    } catch (err) {
      console.error("[auth] requireScanToken error:", err);
      if (FAIL_OPEN) return next();
      return res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
    }
  };
}
