// server/providers/providerFetch.js
// Shared fetch for the LLM providers (claude.js, mistral.js): bounded retry
// with backoff on upstream 429 and 5xx, and a short error category on every
// failure so the extension can tell "busy" from other failures.
//
// Categories returned on failure:
//   rate_limited - the provider answered 429 (its rate limit, not the user's quota)
//   upstream     - 5xx, any other non-OK status, network error, or an unusable body
//   timeout      - the attempt ran out of time
// ("auth", the fourth category the extension uses, is decided by
// requireScanToken before a provider is ever called, not here.)
//
// Never retries a 4xx other than 429: those will not succeed on retry
// (bad request, or our own key rejected).
//
// The whole call, retries included, stays inside BUDGET_MS so it finishes
// before the extension's own 30s timeout on the proxy request.

const BUDGET_MS          = 25000;
const MAX_ATTEMPT_MS     = 20000;
const MAX_RETRIES        = 2;
const BASE_DELAY_MS      = 1000;
const MAX_RETRY_AFTER_MS = 4000;
const MIN_ATTEMPT_MS     = 3000;  // don't start an attempt with less time than this left

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function categoryForStatus(status) {
  return status === 429 ? "rate_limited" : "upstream";
}

function retryDelay(res, attempt) {
  const retryAfter = Number(res?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

/**
 * POST to a provider with bounded retry.
 * Returns { ok: true, res, attempts } with the successful Response, or
 * { ok: false, error, category, attempts }.
 * `label` is the provider name used in error text ("Claude", "Mistral").
 * fetchImpl / sleep / now are injectable for tests.
 */
export async function fetchWithRetry(url, init, { label, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, budgetMs = BUDGET_MS } = {}) {
  const deadline = now() + budgetMs;
  let attempt = 0;
  let last = null;

  while (true) {
    attempt++;
    const remaining = deadline - now();
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.min(MAX_ATTEMPT_MS, remaining)) });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      last = {
        ok: false,
        error: timedOut ? `${label} timed out` : `${label} request failed: ${e?.message || e}`,
        category: timedOut ? "timeout" : "upstream",
        attempts: attempt,
      };
      // A timed-out attempt used most of the budget; a network error is worth one more try.
      if (timedOut || attempt > MAX_RETRIES) return last;
      const delay = retryDelay(null, attempt);
      if (deadline - now() < delay + MIN_ATTEMPT_MS) return last;
      await sleep(delay);
      continue;
    }

    if (res.ok) return { ok: true, res, attempts: attempt };

    const body = await res.text().catch(() => "");
    last = {
      ok: false,
      error: `${label} HTTP ${res.status}: ${body.slice(0, 120)}`,
      category: categoryForStatus(res.status),
      attempts: attempt,
    };
    if (!RETRYABLE.has(res.status) || attempt > MAX_RETRIES) return last;
    const delay = retryDelay(res, attempt);
    if (deadline - now() < delay + MIN_ATTEMPT_MS) return last;
    console.warn(`[${label.toLowerCase()}] HTTP ${res.status}, retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
    await sleep(delay);
  }
}
