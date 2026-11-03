// Liar's Ledger - server/providers/store.js
// Token and scan count storage via Upstash Redis.
//
// Data model:
//   token:{id}                        → JSON { tier, createdAt }
//   scans:{id}:{date}                 → integer (daily scan count, TTL 48h)
//   global:user_count                 → integer (total registered tokens, drives free tier limit)
//   square:ordertemplate:{templateId} → tokenId  (resolved at webhook time via RetrieveOrder)
//   square:customer:{customerId}      → tokenId  (written alongside ordertemplate mapping)
//   square:subscription:{subId}       → tokenId  (written when subscription lifecycle events fire)
//   square:failedcharge:{subId}       → JSON { count, firstFailedAt, lastFailedAt } (TTL 14d)
//   square:downgradereason:{tokenId}  → JSON { reason, at } (TTL 30d) - set only on
//                                        failure-driven downgrade, lets the popup
//                                        explain why Pro was lost (vs. never subscribed)
//   scantoken:{scanToken}:{provider}  → tokenId (TTL 60s, single-use) - server-issued
//                                        authorization for extraction calls, one slot
//                                        per provider (claude, mistral) per scan, closes
//                                        the scan-limit bypass (see SECURITY.md)
//
// The square:* keys contain only opaque IDs - no PII. They exist to:
//   - route tier upgrades/downgrades when subscription webhooks fire
//   - allow manual token recovery if a subscriber loses their token
//     (subscriber provides their Square order reference; we look up their customer)
//   - track repeated invoice.scheduled_charge_failed events so we can downgrade
//     ourselves after Square's automatic retry window closes - Square does NOT
//     auto-cancel a subscription on payment failure (confirmed against live
//     docs: retries fire on day 3, 6, 9 after the initial decline, then Square
//     just leaves the subscription ACTIVE indefinitely with an unpaid invoice).
//     Without our own tracking, a permanently-failing card would stay "pro"
//     forever, since the CANCELED event we'd otherwise wait for may never come.
//
// Swap this file to migrate to PostgreSQL later -
// the interface (exported functions) stays the same.

import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SCAN_TTL_SECONDS = 60 * 60 * 48; // 48h - covers timezone edge cases

// ---------------------------------------------------------------------------
// Free tier limit table, matches brother's scaling plan.
// Evaluated against global:user_count at scan time. Free tier only - see
// PRO_DAILY_LIMIT below for the separate, flat Pro number.
// ---------------------------------------------------------------------------
const FREE_TIER_TABLE = [
  { threshold: 5000, limit: 1,  warn: false },
  { threshold: 2500, limit: 2,  warn: true  }, // capacity warning surfaced in /api/scan-status
  { threshold: 2000, limit: 3,  warn: false },
  { threshold: 1000, limit: 6,  warn: false },
  { threshold: 500,  limit: 13, warn: false },
  { threshold: 0,    limit: 30, warn: false }, // early launch, generous default
];

// Pro tier gets a flat, non-scaling daily limit. This is a deliberate
// product change from the original design, which pooled scans across every
// tier and let Pro change only what data was shown (AI summary, claim
// verdict), not how many scans were available. Pro now gets a real,
// separate scan allowance. Free tier keeps the scaling table above
// unchanged. Not capacity-scaled the way Free is, since Pro subscriber
// count is expected to stay small relative to free tier for a long time,
// and the number is small enough not to be a meaningful cost driver even
// if it doesn't scale down later.
const PRO_DAILY_LIMIT = 100;

// Aggregate daily cap across ALL anonymous web-page visitors combined
// (liarsledger.com/scan), separate from and on top of each visitor's own
// per-token free-tier limit above. Exists purely to bound total Claude/
// Mistral cost exposure from the fully anonymous, no-signup web surface -
// not a per-visitor fairness mechanism, so unlike FREE_TIER_TABLE this
// doesn't scale with userCount. Deliberately NOT a separate credential -
// see CHANGELOG.md for why a single shared token would just be a bigger,
// easier target than the per-visitor design it would replace. Identified
// as "web-originated" via the Origin header (see reserveScan below and
// countScan in middleware/auth.js) rather than anything the client sends,
// so there is nothing new for scan.js to construct or for an attacker to
// steal.
const WEB_DAILY_SITE_LIMIT = 1000;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-06-13"
}

// ---------------------------------------------------------------------------
// User count, incremented once per new token registration
// ---------------------------------------------------------------------------

/**
 * Increment the global registered-user count and return the new value.
 * Call this once from /register, only when the token is newly created.
 */
export async function incrementUserCount() {
  return await redis.incr("global:user_count");
}

/**
 * Return the current registered-user count.
 */
export async function getUserCount() {
  const count = await redis.get("global:user_count");
  return parseInt(count || "0", 10);
}

/**
 * Derive the current daily scan limit for a given tier.
 * Returns { limit, warn, userCount }.
 *   limit     - scans/day for this tier right now
 *   warn      - true when we're in the 2500-4999 capacity warning band
 *               (free tier only - Pro's flat limit never triggers this)
 *   userCount - raw count for monitoring / admin display
 *
 * RENAMED from getFreeTierLimit (no args) to getScanLimit(tier) when Pro
 * stopped sharing Free's scan pool. Every call site must now pass the
 * actual token's tier - a call site that forgets to pass tier and relies
 * on the old default would silently apply Free's scaling table to a Pro
 * user, capping them far below the intended 100/day. There is no default
 * tier argument on purpose, to make a missing argument a loud error
 * (undefined !== "pro", falls through to the free-tier branch, which is
 * the safer of the two wrong outcomes but still wrong) rather than a
 * silent one.
 */
export async function getScanLimit(tier) {
  const userCount = await getUserCount();

  if (tier === "pro") {
    return { limit: PRO_DAILY_LIMIT, warn: false, userCount };
  }

  for (const row of FREE_TIER_TABLE) {
    if (userCount >= row.threshold) {
      return { limit: row.limit, warn: row.warn, userCount };
    }
  }
  // Fallback - should never be reached given threshold: 0 entry above
  return { limit: 30, warn: false, userCount };
}

// ---------------------------------------------------------------------------
// Token CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new anonymous token.
 * @param {string} tokenId - UUID generated by the extension
 * @param {string} tier - "free" or "pro"
 */
export async function createToken(tokenId, tier = "free") {
  const data = {
    tier,
    createdAt: new Date().toISOString(),
  };
  await redis.set(`token:${tokenId}`, JSON.stringify(data));
  return data;
}

/**
 * Look up a token. Returns { tier, createdAt } or null.
 * Returns null (not a throw) if the stored value is corrupted/malformed JSON -
 * callers already treat null as "token not found," and a parse failure here
 * should degrade the same way rather than crashing the request.
 */
export async function getToken(tokenId) {
  const raw = await redis.get(`token:${tokenId}`);
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[store] corrupted token data for ${tokenId}:`, e.message);
    return null;
  }
}

/**
 * Upgrade a token's tier (e.g., after Square payment).
 */
export async function upgradeTier(tokenId, tier) {
  const existing = await getToken(tokenId);
  if (!existing) return null;

  const updated = { ...existing, tier, upgradedAt: new Date().toISOString() };
  await redis.set(`token:${tokenId}`, JSON.stringify(updated));
  return updated;
}

/**
 * Delete a token (e.g., account cancellation).
 */
export async function deleteToken(tokenId) {
  await redis.del(`token:${tokenId}`);
}

// ---------------------------------------------------------------------------
// Scan counts
// ---------------------------------------------------------------------------

/**
 * Increment today's scan count for a token.
 * Fetches the current scan limit dynamically based on tier, no hardcoded
 * constant. Free tier scales down as the user base grows (FREE_TIER_TABLE
 * above); Pro gets a flat PRO_DAILY_LIMIT regardless of user count.
 * NOTE: this used to say "scans are pooled across all tiers, tier does not
 * change the scan limit," that was true under the original design, no
 * longer true as of the Pro-gets-its-own-allowance change. Tier now
 * directly determines which limit applies, not just which fields get
 * returned elsewhere.
 * Returns { count, limit, remaining, allowed, warn }.
 *   warn: true when the capacity warning band is active (2500-4999 users,
 *         free tier only). Pass this through to /api/scan-status for UI
 *         surfacing.
 */
export async function incrementScans(tokenId, tier = "free") {
  const key = `scans:${tokenId}:${todayKey()}`;
  const count = await redis.incr(key);

  // Set TTL on first scan of the day
  if (count === 1) {
    await redis.expire(key, SCAN_TTL_SECONDS);
  }

  const { limit, warn } = await getScanLimit(tier);
  const allowed = count <= limit;

  return {
    count,
    limit,
    remaining: Math.max(0, limit - count),
    allowed,
    warn,
  };
}

// ---------------------------------------------------------------------------
// Scan tokens - single-use, server-issued authorization for extraction calls
// ---------------------------------------------------------------------------
// Found via security review (June 2026): /api/claude/extract and
// /api/mistral/extract never independently verified a scan had been counted
// - a client holding any valid registered token could call them directly,
// repeatedly, bypassing the daily limit entirely. See SECURITY.md "Known
// Gaps - Scan Limit Bypassable" for the full writeup.
//
// Fix: incrementScans (above) now issues a short-lived, single-use scan
// token alongside the count. Extraction endpoints REQUIRE a valid,
// unconsumed scan token to proceed - there is no way to fabricate one
// without Redis having issued it via a real, counted call to
// POST /api/scan/start.
//
// Dual-model mode (background.js calling both /api/claude/extract and
// /api/mistral/extract for one logical scan) sends the SAME scan token to
// both calls. Each scan token carries one single-use slot per provider
// (scantoken:{scanToken}:claude and scantoken:{scanToken}:mistral), so both
// calls of one scan can proceed, each exactly once. Before v0.17.18 a scan
// token was a single slot shared by both providers: whichever call arrived
// second was rejected with 403, so dual mode never actually ran both models.
//
// What a scan token still cannot do: authorize a second scan, or a second
// call to the same provider. Once a provider's slot is consumed, any later
// presentation of the token to that provider gets the same 403 as a token
// that never existed. The scan is counted once, at reserve time, no matter
// how many provider slots it carries.
//
// Short TTL (60s) is a backstop, not the primary mechanism - a client that
// requests a scan token and never uses it just lets it expire; this isn't a
// timing-window security boundary, the single-use consumption is.

const SCAN_TOKEN_TTL_SECONDS = 60;

// Providers each scan token carries a slot for. Every scan gets both today
// (dual mode for all tiers). Issuing fewer slots per tier is the hook for
// running the second model only for some tiers, if that is ever decided.
export const SCAN_TOKEN_PROVIDERS = ["claude", "mistral"];

function scanSlotKey(scanToken, provider) {
  return `scantoken:${scanToken}:${provider}`;
}

/**
 * Issue a new scan token with one single-use slot per provider. Called
 * internally alongside an actual counted (or reserved) scan - not exported
 * standalone, since a scan token should never exist without one.
 */
async function issueScanToken(tokenId, providers = SCAN_TOKEN_PROVIDERS) {
  const scanToken = `st_${tokenId.slice(0, 8)}_${randomUUID()}`;
  for (const provider of providers) {
    await redis.set(scanSlotKey(scanToken, provider), tokenId, { ex: SCAN_TOKEN_TTL_SECONDS });
  }
  return scanToken;
}

/**
 * Increment today's scan count AND issue a scan token in one call.
 * This is what POST /api/scan/start should call instead of bare
 * incrementScans - the returned scanToken is what background.js threads
 * through to both extraction calls.
 * Returns the same shape as incrementScans, plus { scanToken }.
 * scanToken is null when !allowed - no point issuing a token for a scan
 * that was just rejected for being over the daily limit.
 */
export async function incrementScansWithToken(tokenId, tier = "free") {
  const result = await incrementScans(tokenId, tier);
  if (!result.allowed) {
    return { ...result, scanToken: null };
  }
  const scanToken = await issueScanToken(tokenId);
  return { ...result, scanToken };
}

// ---------------------------------------------------------------------------
// Two-phase scan counting: reserve → commit
// ---------------------------------------------------------------------------
// Instead of counting a scan at /api/scan/start and losing it if congress.gov
// or govtrack time out, scan/start now RESERVES a scan (pending) and issues
// a commitToken alongside the scanToken. The client calls /api/scan/commit
// with the commitToken only when at least one external source responded --
// if all sources timed out, the client skips commit and the pending entry
// expires harmlessly after SCAN_COMMIT_TTL_SECONDS.
//
// Pending scans count toward the daily limit at reserve time so a client
// cannot accumulate unlimited reservations. The sorted set
// scans:pending:{tokenId}:{date} tracks outstanding reservations keyed by
// expiry timestamp (ms as score), enabling O(log N) expiry cleanup via
// ZREMRANGEBYSCORE before each limit check.
//
// Data model additions:
//   scancommit:{commitToken}               -> tokenId  (TTL SCAN_COMMIT_TTL_SECONDS)
//   scans:pending:{tokenId}:{date}         -> sorted set { score: expiresAtMs, member: commitToken }

const SCAN_COMMIT_TTL_SECONDS = 180; // 3 min -- covers full pipeline incl. Pro verify

/**
 * Reserve a scan slot and issue both tokens needed for the two-phase flow.
 * Replaces incrementScansWithToken as what POST /api/scan/start calls.
 *
 * @param {boolean} isWebOrigin - true when this request came from
 *   liarsledger.com/scan (see countScan in middleware/auth.js, which
 *   derives this from the Origin header - nothing the client sends
 *   explicitly). Gates against WEB_DAILY_SITE_LIMIT, the aggregate cap
 *   across all anonymous web visitors combined, BEFORE touching this
 *   token's own per-token count/pending state below - a rejection here is
 *   the site's shared budget being out, not this visitor's own allowance,
 *   so it must not consume any of theirs. Checked at reserve time, not
 *   commit time, same reasoning as the per-token limit already below: the
 *   actual Claude/Mistral cost happens once a scanToken is issued,
 *   regardless of whether the client ever calls /api/scan/commit
 *   afterward, so gating only on committed counts would undercount real
 *   exposure. Unlike the per-token pending-set mechanism, an abandoned
 *   web-origin reservation is NOT reclaimed back into the site's daily
 *   budget - acceptable here since this is a soft aggregate ceiling, not
 *   a per-visitor guarantee; revisit with proper pending/expiry tracking
 *   (mirroring pendingKey below) if abandonment rate turns out to matter
 *   in practice. Always false for the extension (chrome-extension://
 *   origin) and for direct/non-browser API callers (no Origin header) -
 *   both fall through to the existing per-token-only behavior, unchanged.
 *
 * Returns the same shape as incrementScansWithToken plus { commitToken }.
 * Both scanToken and commitToken are null when !allowed. When rejected
 * specifically by the site-wide cap, siteCapacityReached is true so
 * countScan (middleware/auth.js) can return a distinct error code instead
 * of the per-token "Daily scan limit reached" message.
 *
 * remaining reflects slots not yet taken by either real or pending scans.
 */
export async function reserveScan(tokenId, tier = "free", isWebOrigin = false) {
  const date = todayKey();

  if (isWebOrigin) {
    const webKey = `web:scans:${date}`;
    const webCount = Number((await redis.get(webKey)) || 0);
    if (webCount >= WEB_DAILY_SITE_LIMIT) {
      return {
        count: 0, limit: 0, remaining: 0, allowed: false, warn: false,
        scanToken: null, commitToken: null, siteCapacityReached: true,
      };
    }
  }

  const scanKey    = `scans:${tokenId}:${date}`;
  const pendingKey = `scans:pending:${tokenId}:${date}`;
  const now = Date.now();

  const rawCount = await redis.get(scanKey);
  const currentCount = Number(rawCount || 0);

  // Remove expired pending entries, then count remaining
  await redis.zremrangebyscore(pendingKey, 0, now - 1);
  const pendingCount = Number((await redis.zcard(pendingKey)) || 0);

  const { limit, warn } = await getScanLimit(tier);
  const allowed = (currentCount + pendingCount) < limit;

  if (!allowed) {
    return { count: currentCount, limit, remaining: 0, allowed: false, warn, scanToken: null, commitToken: null };
  }

  const scanToken   = await issueScanToken(tokenId);
  const commitToken = `sc_${tokenId.slice(0, 8)}_${randomUUID()}`;
  const expiresAt   = now + SCAN_COMMIT_TTL_SECONDS * 1000;

  await redis.set(`scancommit:${commitToken}`, tokenId, { ex: SCAN_COMMIT_TTL_SECONDS });
  await redis.zadd(pendingKey, { score: expiresAt, member: commitToken });
  await redis.expire(pendingKey, SCAN_TTL_SECONDS); // keep the set alive through the day

  // Links the scan token back to its reservation so the server can release
  // the reservation itself if every provider call for this scan fails (see
  // recordProviderFailure). Never sent to the client.
  await redis.set(
    `scanres:${scanToken}`,
    JSON.stringify({ commitToken, pendingKey, webKey: isWebOrigin ? `web:scans:${date}` : null }),
    { ex: SCAN_COMMIT_TTL_SECONDS },
  );

  if (isWebOrigin) {
    const webKey = `web:scans:${date}`;
    const webCount = await redis.incr(webKey);
    if (webCount === 1) await redis.expire(webKey, SCAN_TTL_SECONDS);
  }

  return {
    count: currentCount,
    limit,
    remaining: Math.max(0, limit - currentCount - pendingCount - 1),
    allowed: true,
    warn,
    scanToken,
    commitToken,
  };
}

/**
 * Finalize a reserved scan -- converts it from pending to counted.
 * Call this from POST /api/scan/commit when the scan produced usable results.
 *
 * Returns { committed: true } on success, { committed: false } if the
 * commitToken was missing, expired, or already used.
 *
 * Does NOT return remaining/limit -- the caller should invoke syncTier()
 * client-side (which hits /api/scan-status) rather than trying to derive
 * the updated count here without knowing the current tier.
 */
export async function commitScan(commitToken) {
  if (!commitToken) return { committed: false };

  const commitKey = `scancommit:${commitToken}`;
  const tokenId   = await redis.get(commitKey);
  if (!tokenId) return { committed: false };
  // DEL's result decides, so a commit and a concurrent release (or two
  // commits) can never both finalize the same reservation.
  if ((await redis.del(commitKey)) !== 1) return { committed: false };

  const date       = todayKey();
  const scanKey    = `scans:${tokenId}:${date}`;
  const pendingKey = `scans:pending:${tokenId}:${date}`;

  const count = await redis.incr(scanKey);
  if (count === 1) await redis.expire(scanKey, SCAN_TTL_SECONDS);
  await redis.zrem(pendingKey, commitToken);

  return { committed: true };
}

/**
 * Record that one provider call for this scan failed. When every provider
 * the scan token was issued for has failed, release the scan's reservation
 * right away instead of letting it hold a slot for SCAN_COMMIT_TTL_SECONDS,
 * so a scan whose analysis failed completely never costs the user a scan,
 * not even temporarily.
 *
 * Only the server calls this, from the extraction routes, after a provider
 * actually returned a failure. The client cannot request a release, so it
 * cannot run an extraction and then cancel its charge.
 *
 * Returns { released } - true only when this call released the reservation.
 */
export async function recordProviderFailure(scanToken) {
  if (!scanToken) return { released: false };
  const failKey  = `scanfail:${scanToken}`;
  const failures = await redis.incr(failKey);
  if (failures === 1) await redis.expire(failKey, SCAN_COMMIT_TTL_SECONDS);
  if (failures < SCAN_TOKEN_PROVIDERS.length) return { released: false };
  return releaseReservation(scanToken);
}

async function releaseReservation(scanToken) {
  const raw = await redis.get(`scanres:${scanToken}`);
  if (!raw) return { released: false };
  const { commitToken, pendingKey, webKey } = typeof raw === "string" ? JSON.parse(raw) : raw;
  // Same DEL gate as commitScan: an already-committed scan stays committed.
  if ((await redis.del(`scancommit:${commitToken}`)) !== 1) return { released: false };
  await redis.zrem(pendingKey, commitToken);
  if (webKey) await redis.decr(webKey);
  await redis.del(`scanres:${scanToken}`);
  return { released: true };
}

/**
 * Consume one provider's slot on a scan token. Returns the tokenId the scan
 * token was issued for if that provider's slot was valid and unconsumed, or
 * null if the scan token is invalid, expired, has no slot for this
 * provider, or that slot was already used.
 *
 * Does not throw or distinguish "never existed" from "already consumed" -
 * both return null, and requireScanToken (auth.js) rejects both with 403.
 *
 * Single use is enforced by DEL's return value, not by the GET: two
 * concurrent requests can both read the slot, but only one DEL removes the
 * key and returns 1, and only that request proceeds. This closes the race
 * window the original get-then-del accepted (see below), without getdel or
 * a Lua script.
 *
 * History: originally implemented via redis.getdel(key). Live curl
 * testing showed every consumption attempt failing - including on tokens
 * used within one second of issuance, ruling out TTL expiry as the cause.
 * Root cause not fully confirmed (direct package inspection shows getdel
 * IS a real method on @upstash/redis's client, contradicting an earlier,
 * incorrect assumption that it wasn't) - but switching to plain get+del,
 * both unambiguously standard and verified methods, empirically resolved
 * the failure in live testing. Documenting this honestly rather than
 * asserting a root cause that was never fully nailed down: something about
 * getdel's behavior on the deployed version didn't work as expected, and
 * rather than keep investigating, the safer fix is two calls built on
 * primitives with no remaining doubt about their correctness.
 *
 * That plain get-then-del left a small race window (two concurrent reads
 * of the same key could both succeed). As of v0.17.18 the DEL result
 * decides, which removes that window using the same two verified commands.
 */
export async function consumeScanToken(scanToken, provider) {
  if (!scanToken || !provider) return null;
  const key = scanSlotKey(scanToken, provider);
  const tokenId = await redis.get(key);
  if (!tokenId) return null;
  const deleted = await redis.del(key);
  return deleted === 1 ? tokenId : null;
}

/**
 * Get today's scan count without incrementing.
 */
export async function getScans(tokenId) {
  const key = `scans:${tokenId}:${todayKey()}`;
  const count = (await redis.get(key)) || 0;
  return Number(count);
}

/**
 * Reset today's scan count for a token to zero (deletes the Redis key
 * entirely, same effect as it never having been incremented today).
 * Admin/testing use only - see /admin/reset-scans in index.js.
 */
export async function resetScans(tokenId) {
  const key = `scans:${tokenId}:${todayKey()}`;
  await redis.del(key);
}

// ---------------------------------------------------------------------------
// Square recovery mappings
// ---------------------------------------------------------------------------
// Written at webhook resolution time (not at checkout time - Square creates
// the customer/subscription after the hosted checkout, not before).
// Read during webhook processing and by /restore-token.
// All keys contain only opaque IDs - no PII.

/**
 * Store a Square order-template ID → anonymous tokenId mapping.
 * This is the primary resolution path: subscription.created webhook gives us
 * phases[0].order_template_id → we call RetrieveOrder → read reference_id
 * (our token) → store this mapping so future events can skip the RetrieveOrder.
 */
export async function storeOrderTemplateMapping(orderTemplateId, tokenId) {
  await redis.set(`square:ordertemplate:${orderTemplateId}`, tokenId);
}

export async function lookupTokenByOrderTemplate(orderTemplateId) {
  const val = await redis.get(`square:ordertemplate:${orderTemplateId}`);
  return val ?? null;
}

/**
 * Store a Square customer ID → anonymous tokenId mapping.
 * Written alongside the ordertemplate mapping. Used by /restore-token:
 * subscriber provides a Square order reference → RetrieveOrder → customer_id
 * → look up this mapping → return token.
 */
export async function storeSquareCustomerMapping(customerId, tokenId) {
  await redis.set(`square:customer:${customerId}`, tokenId);
}

export async function lookupTokenBySquareCustomer(customerId) {
  const val = await redis.get(`square:customer:${customerId}`);
  return val ?? null;
}

/**
 * Store a Square subscription ID → anonymous tokenId mapping.
 * Written when the subscription is first resolved. Used by lifecycle events
 * (subscription.updated, invoice.payment_made, invoice.scheduled_charge_failed)
 * to route to the correct token without an additional RetrieveOrder call.
 */
export async function storeSquareSubscriptionMapping(subscriptionId, tokenId) {
  await redis.set(`square:subscription:${subscriptionId}`, tokenId);
}

export async function lookupTokenBySquareSubscription(subscriptionId) {
  const val = await redis.get(`square:subscription:${subscriptionId}`);
  return val ?? null;
}

// ---------------------------------------------------------------------------
// Failed-charge tracking - self-managed downgrade after Square's retry window
// ---------------------------------------------------------------------------
// Square's automatic retry schedule for a failed subscription payment is
// day 3, day 6, day 9 after the initial decline (3 retries over 9 days).
// Square does NOT auto-cancel the subscription afterward - it stays ACTIVE
// with an unpaid invoice indefinitely unless the buyer pays or we cancel it
// ourselves. So `invoice.scheduled_charge_failed` events are the only signal
// we get; there's no guaranteed CANCELED event to wait for. We track failure
// count/timing here so the webhook handler can decide when enough retries
// have failed to downgrade proactively, rather than granting Pro forever to
// a permanently-failing card.
//
// 14-day TTL: comfortably past the 9-day retry window, so a stale failure
// record doesn't linger past the point where it's still relevant. If a fresh
// payment_made event comes in, callers should clear this record entirely
// (see clearFailedCharges) rather than letting it expire on its own.

const FAILED_CHARGE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

/**
 * Record a failed scheduled charge for a subscription.
 * Returns the updated { count, firstFailedAt, lastFailedAt }.
 */
export async function recordFailedCharge(subscriptionId) {
  const key = `square:failedcharge:${subscriptionId}`;
  const now = new Date().toISOString();

  const raw = await redis.get(key);
  let record;
  if (raw) {
    const existing = typeof raw === "string" ? JSON.parse(raw) : raw;
    record = {
      count: (existing.count || 0) + 1,
      firstFailedAt: existing.firstFailedAt || now,
      lastFailedAt: now,
    };
  } else {
    record = { count: 1, firstFailedAt: now, lastFailedAt: now };
  }

  await redis.set(key, JSON.stringify(record));
  await redis.expire(key, FAILED_CHARGE_TTL_SECONDS);
  return record;
}

/**
 * Look up the current failed-charge record for a subscription.
 * Returns { count, firstFailedAt, lastFailedAt } or null if no failures
 * are on record (or the record expired).
 */
export async function getFailedCharges(subscriptionId) {
  const raw = await redis.get(`square:failedcharge:${subscriptionId}`);
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[store] corrupted failedcharge record for ${subscriptionId}:`, e.message);
    return null;
  }
}

/**
 * Clear the failed-charge record for a subscription.
 * Call this whenever invoice.payment_made fires - a successful payment
 * means whatever retry sequence was in progress resolved itself, so the
 * count should reset rather than carry forward into the next billing cycle.
 */
export async function clearFailedCharges(subscriptionId) {
  await redis.del(`square:failedcharge:${subscriptionId}`);
}

// ---------------------------------------------------------------------------
// Downgrade reason - lets the extension explain *why* a token lost Pro
// ---------------------------------------------------------------------------
// There's no grace period beyond Square's own 3-attempt/9-day retry window
// (day 3, 6, 9) - Square emails the buyer on each failed attempt, so by the
// time we downgrade, the person has already had 9 days and 3 emails of
// warning from Square directly. What they DON'T get without this marker is
// any signal from US, in the one place they'll actually notice - the
// extension popup, the moment they look for it. Without this, "never
// subscribed" and "subscribed, then a card declined three times" render
// identically as plain "Free" - this lets the popup tell those apart and
// show the right message ("update your card" vs. a generic upgrade pitch).
//
// Stored on the token itself (not the subscription) since that's what the
// popup already has in hand via getToken(tokenId) - no extra lookup needed.
// Set ONLY at the moment of the automatic, failure-driven downgrade in the
// webhook handler - NOT on a normal user-initiated cancellation, where the
// person already knows why (they clicked cancel).

const DOWNGRADE_REASON_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days - long enough
// for someone to notice on their own schedule, short enough that it doesn't
// linger forever for an account that's since resubscribed and lapsed again
// for an unrelated reason.

/**
 * Mark a token as downgraded due to repeated payment failure (as opposed to
 * a normal cancellation). Call this at the same point upgradeTier(tokenId,
 * "free") is called for a payment-failure-driven downgrade.
 */
export async function setDowngradeReason(tokenId, reason) {
  const key = `square:downgradereason:${tokenId}`;
  await redis.set(key, JSON.stringify({ reason, at: new Date().toISOString() }));
  await redis.expire(key, DOWNGRADE_REASON_TTL_SECONDS);
}

/**
 * Look up why a token was downgraded, if it was due to payment failure.
 * Returns { reason, at } or null - null means either no downgrade marker
 * exists, or the token was never downgraded this way (e.g. it cancelled
 * normally, or it's simply never been Pro).
 */
export async function getDowngradeReason(tokenId) {
  const raw = await redis.get(`square:downgradereason:${tokenId}`);
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[store] corrupted downgradereason record for ${tokenId}:`, e.message);
    return null;
  }
}

/**
 * Clear the downgrade-reason marker for a token.
 * Call this whenever a token upgrades back to "pro" - once they've fixed
 * the billing issue (or resubscribed fresh), the old reason is stale and
 * showing it again after a successful resubscribe would be confusing.
 */
export async function clearDowngradeReason(tokenId) {
  await redis.del(`square:downgradereason:${tokenId}`);
}
