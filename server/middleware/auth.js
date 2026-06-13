// Liar's Ledger - server/middleware/auth.js
// Extracts the Bearer token from requests, validates it,
// and enforces scan rate limits by tier.
//
// Usage in index.js:
//   import { requireToken, countScan } from "./middleware/auth.js";
//
//   // On scan-triggering routes (claude/extract, mistral/extract, verify-claim):
//   app.post("/api/claude/extract", requireToken, countScan, wrap(async (req, res) => { ... }));
//
//   // On read-only routes (congress, govtrack, votesmart, legislators):
//   app.get("/api/congress/*", requireToken, wrap(async (req, res) => { ... }));

import { getToken, incrementScans } from "../providers/store.js";

/**
 * requireToken — validates the Bearer token exists and is registered.
 * Attaches req.tokenId and req.tier for downstream use.
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
    // Fail open — don't block users if Redis is down
    req.tokenId = tokenId;
    req.tier = "free";
    next();
  }
}

/**
 * countScan — increments the daily scan counter and blocks if over limit.
 * Only attach this to routes that count as a "scan" (LLM extraction).
 * Read-only routes (congress, govtrack) don't count against the limit.
 */
export async function countScan(req, res, next) {
  // Pro users skip counting
  if (req.tier === "pro") return next();

  try {
    const result = await incrementScans(req.tokenId, req.tier);

    // Attach scan info for the response
    req.scanInfo = result;

    if (!result.allowed) {
      return res.status(429).json({
        error: "Daily scan limit reached.",
        limit: result.limit,
        remaining: 0,
        upgrade_url: "https://liarsledger.com/pricing",
      });
    }

    next();
  } catch (e) {
    console.error("[auth] scan count failed:", e.message);
    // Fail open — don't block users if Redis is down
    next();
  }
}
