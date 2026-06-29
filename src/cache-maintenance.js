// Liars Ledger - src/cache-maintenance.js
// Periodically evicts accumulated request-cache entries from
// browser.storage.session before they exhaust the 10MB quota.
//
// Background: vsFetch() (votesmart.js) and apiFetch() (api.js) both cache
// every request under a "vs:"/"api:" prefixed key in storage.session, with
// no expiry or eviction - confirmed live (2026-06-28) that this grows
// without bound over a browser session and eventually exceeds the quota,
// causing "Session storage quota bytes exceeded. Values were not stored."
// and silently losing that scan's results. Confirmed NOT a one-time/large-
// scan-only issue: recurred on a normal-sized scan after enough additional
// scans had accumulated in between, on an account that had been manually
// cleared once already.
//
// Two triggers, either one fires a selective clear:
//   1. Count-based: every COUNT_THRESHOLD scans (default 30 - chosen to
//      land roughly once/day for a free-tier user at their daily limit,
//      ~3x/day for Pro's higher limit).
//   2. Usage-based safety net: if storage.session is already above
//      USAGE_THRESHOLD_RATIO of its quota when a scan starts, clear
//      immediately regardless of count - covers the case where an
//      unusually heavy run of scans (many politicians/topics each, like
//      the 12-senator scan that first surfaced this) fills the quota
//      faster than the count-based trigger would catch.
//
// Deliberately SELECTIVE, not a full storage.session.clear(): only removes
// "vs:"/"api:" prefixed request-cache keys. Preserves ll_results (so the
// user's last scan results survive a maintenance clear) and the
// vs:id:{bioguideId} candidateId-resolution cache (a different, much
// smaller, high-value cache that's wasteful to throw away on the same
// schedule as the bulk per-request data).
//
// Exports:
//   maybeRunCacheMaintenance() - call once near the start of handleAnalyze,
//                                before any vsFetch/apiFetch calls for this
//                                scan. Fire-and-forget safe (no return value
//                                the caller depends on) but awaited anyway
//                                so a clear-in-progress can't race a fresh
//                                write from this same scan.

const CACHE_MAINTENANCE_COUNT_KEY = "ll_scan_count_since_maintenance";
const COUNT_THRESHOLD = 30;
const USAGE_THRESHOLD_RATIO = 0.85; // trigger at 85% of quota, not 100% - leave headroom for the scan about to run

// Keys eligible for eviction. Deliberately a prefix allowlist (not a
// denylist of what to KEEP) - safer default if a new cache prefix gets
// added later and someone forgets to update this list, it just won't be
// evicted (cache grows a bit faster than ideal) rather than accidentally
// evicting something important (silent data loss) the moment after a
// scan that needed it.
const EVICTABLE_PREFIXES = ["vs:", "api:"];
// Explicit exception within the "vs:" prefix - candidateId resolution
// cache is small (one ID per politician, not per-request page data) and
// expensive to lose (an extra round trip through pagination/compound-
// surname retry logic on next lookup). Excluded from eviction even though
// it starts with "vs:".
const PRESERVE_PREFIX = "vs:id:";

async function isEvictable(key) {
  if (key.startsWith(PRESERVE_PREFIX)) return false;
  return EVICTABLE_PREFIXES.some((p) => key.startsWith(p));
}

async function clearEvictableCacheKeys() {
  const all = await browser.storage.session.get(null); // null = get everything
  const keysToRemove = [];
  for (const key of Object.keys(all)) {
    if (await isEvictable(key)) keysToRemove.push(key);
  }
  if (keysToRemove.length === 0) return 0;
  await browser.storage.session.remove(keysToRemove);
  return keysToRemove.length;
}

async function getScanCountSinceMaintenance() {
  const result = await browser.storage.local.get(CACHE_MAINTENANCE_COUNT_KEY);
  return result[CACHE_MAINTENANCE_COUNT_KEY] || 0;
}

async function setScanCountSinceMaintenance(n) {
  await browser.storage.local.set({ [CACHE_MAINTENANCE_COUNT_KEY]: n });
}

async function getSessionUsageRatio() {
  try {
    const used  = await browser.storage.session.getBytesInUse(null); // null = total usage
    const quota = browser.storage.session.QUOTA_BYTES || 10485760; // fallback to documented ~10MB if the constant isn't exposed for some reason
    return used / quota;
  } catch (e) {
    // getBytesInUse itself failing shouldn't block the scan that's about
    // to run - log and treat as "unknown, assume safe" rather than throw.
    console.warn("[Liars Ledger] cache-maintenance: getBytesInUse failed:", e.message);
    return 0;
  }
}

async function maybeRunCacheMaintenance() {
  try {
    const usageRatio = await getSessionUsageRatio();
    const usageTriggered = usageRatio >= USAGE_THRESHOLD_RATIO;

    let count = await getScanCountSinceMaintenance();
    count += 1;
    const countTriggered = count >= COUNT_THRESHOLD;

    if (!usageTriggered && !countTriggered) {
      await setScanCountSinceMaintenance(count);
      return;
    }

    const removed = await clearEvictableCacheKeys();
    await setScanCountSinceMaintenance(0);

    const reason = usageTriggered
      ? `usage threshold (${(usageRatio * 100).toFixed(0)}% of quota)`
      : `scan count threshold (${count} scans)`;
    console.log(`[Liars Ledger] cache-maintenance: cleared ${removed} cache key(s) - triggered by ${reason}`);
  } catch (e) {
    // Maintenance failing should never block or break the scan it's
    // running ahead of - log and let the scan proceed regardless.
    console.warn("[Liars Ledger] cache-maintenance failed (scan proceeding anyway):", e.message);
  }
}
