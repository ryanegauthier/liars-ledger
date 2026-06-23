# Security Policy

## Current Status
Liar's Ledger v0.14.1 has completed its pre-release security checklist. v0.13.0 (Chrome Web Store launch, no functional changes from v0.12.1 beyond store-listing metadata) was approved and is live. v0.15.0–0.16.0 (Square subscription integration and the scan-token hardening pass) are deployed to Render; the full subscription-creation handler logic has been verified end-to-end against real sandbox order data, and the scan-limit bypass found in the June 2026 security review has been fixed and verified live (see "Known Gaps - Scan Limit Bypassable" below). The deprecated admin tier-override endpoints have been removed now that the Square webhook path is confirmed working in production.

---

## Architecture

### API Keys
All API keys (Congress.gov, Claude, Mistral, VoteSmart) are held server-side on the backend proxy at `api.liarsledger.com`. The extension never holds, transmits, or exposes API keys. `src/config.js` contains only the proxy URL and is gitignored - distributed builds auto-generate it from `config.example.js` during the build process.

### Permissions
- **`activeTab`** - reads page content only when the user clicks "Scan This Page"
- **`storage`** - session storage for scan result caching (cleared on browser close); local storage for a single enabled/disabled toggle
- **`host_permissions`** - limited to `https://api.liarsledger.com/*` only
- **`content_scripts`** - runs on all URLs to enable scanning on any news site; does not transmit data until the user initiates a scan
- **`web_accessible_resources`** - limited to `report.html` and `report.js` (opened in new tab from content script)

### Data Flow
```
User clicks Scan → content script reads article text
  → background worker sends text to api.liarsledger.com
    → proxy forwards to Claude + Mistral (claim extraction)
    → proxy queries Congress.gov, GovTrack, VoteSmart (voting records)
    → proxy sends claim + record to Claude (verdict verification)
  → results displayed in sidebar
```

Article text is processed in real time and is not logged or stored by the proxy.

### CORS
The backend proxy validates request origins via `ALLOWED_ORIGINS` environment variable, restricted to authorized Chrome extension IDs.

### Free/Pro Tier Enforcement
Enforcement of scan limits and Pro-only features happens server-side, not in the extension. This matters because client-side code is fully visible to anyone who installs the extension and reads its source (it's open source, deliberately) - any check that only existed in `background.js` or `content.js` could be bypassed by a modified build of the extension talking to our real backend.

- **Scan limits** are tracked per anonymous token in Redis (`scans:{tokenId}:{date}`), checked and incremented via `POST /api/scan/start`. The daily limit is shared across all users and tiers (Pro does not mean unlimited scans - see README) and scales down automatically as the registered-user count grows.
- **Pro-only data** (AI claim verdicts, VoteSmart vote history and ratings) is gated at the response layer in `server/index.js`: `/api/verify-claim` and `/api/votesmart/*` require Pro via `requirePro` middleware and reject free-tier requests with a 403 *before* the verdict or VoteSmart data is ever computed - not just before it's displayed. `/api/claude/extract` and `/api/mistral/extract` strip the claim text and article summary from the response for free tier, server-side, before the response leaves the server.
- The extension's own client-side gating in `background.js` is a defensive fallback layer, not the security boundary. It exists for UX reasons (avoid briefly rendering data the user then loses) and as a safety net, not to enforce the actual restriction.

### Known Gaps - Scan Limit Bypassable on Extraction Endpoints (RESOLVED in v0.16.0)
**Status: fixed and verified live in production.** Originally identified via a structured principal-engineer-style code review pass (June 2026), rated High. Kept this entry rather than deleting it, per this file's own convention of converting Known Gaps to resolved records instead of erasing the history of what was found and how.

- **The gap, as found**: `POST /api/claude/extract` and `POST /api/mistral/extract` were intentionally designed not to count scans themselves - the comment in `server/index.js` explained this was so dual-model mode (both providers firing for one page-scan) didn't double-charge a single scan against the daily limit. The design intent was that `POST /api/scan/start` is called first by the extension, which counts the scan, and the extraction endpoints are called after. But nothing enforced that ordering server-side: both extraction endpoints only ran `requireToken` (confirms the token exists) with no check that a scan was actually counted for this request. A client holding any valid registered token could skip `/api/scan/start` entirely and call either extraction endpoint directly, repeatedly, with no scan-limit enforcement at all.
- **The fix**: `POST /api/scan/start` now issues a short-lived (60s), single-use scan token alongside the existing daily count (`server/providers/store.js`: `incrementScansWithToken`, `consumeScanToken`). Both extraction endpoints now run a new `requireScanToken` middleware (`server/middleware/auth.js`) that requires a valid, unconsumed scan token in the request body - there is no way to fabricate one without Redis having issued it via a real, counted call. Dual-model mode reuses the SAME scan token for both the Claude and Mistral calls; whichever request reaches the server first consumes it, the second is rejected by `requireScanToken` rather than re-counted - this preserves the original no-double-charge design intent while actually enforcing it server-side instead of just hoping the client behaves. `extension/background.js` and `src/llm.js` thread the scan token from `/api/scan/start`'s response through to both extraction fetch calls.
- **Folded into the same release**: `requireToken` and `countScan` were also changed to fail CLOSED on Redis errors by default (previously failed open - any Bearer token, including unregistered ones, would pass as free-tier during an outage, which was the same underlying cost-abuse exposure as the bypass above, just reached via an outage instead of a direct call). `AUTH_FAIL_OPEN=true` restores the old behavior for local dev only; never set in production.
- **Two real bugs found only through live testing, not code review** - worth recording honestly since they're a useful reminder that this kind of change needs real verification, not just review: (1) the rate limiter for `/pricing/checkout` (added in the same pass) was initially defined after the route that referenced it in `server/index.js`, throwing `ReferenceError: Cannot access 'checkoutLimiter' before initialization` on every server boot - `node --check` (syntax validation) does not catch this class of bug, since `const`-before-use is a runtime initialization error, not a syntax error. (2) `consumeScanToken` was originally implemented via `redis.getdel(key)`; live curl testing showed every consumption attempt failing, including on tokens used within one second of issuance, ruling out TTL expiry. Root cause not fully confirmed - direct inspection of the installed `@upstash/redis` package showed `getdel` does exist as a method, contradicting an initial assumption that it didn't - but switching to plain `get` then `del` (both unambiguously standard, individually verified) empirically resolved the failure in live testing.
- **Verified via**: real curl sequence against production - confirmed a call with no `scanToken` returns 403; confirmed a freshly-issued `scanToken` consumed within ~1 second returns 200 with real extraction output; confirmed re-presenting that same `scanToken` a second time returns 403 (single-use property holds).

### Known Gaps - Anonymous Token Abuse
The anonymous per-install token model (no email, no account, no payment verification tying a token to anything) trades verification for privacy and zero-friction onboarding. This has a real, accepted limitation:

- **Token farming**: nothing currently prevents a script from calling `POST /register` directly (bypassing the extension entirely) to mass-create fake tokens, each with its own daily scan allowance. This both drains API budget directly (if the bot also calls the scan endpoints) and indirectly degrades the experience for real users, since each new registration increments the global user count that the dynamic scan-limit table is based on.
- **Mitigation in place**: `POST /register` is rate-limited to 5 requests/hour per IP (separate from and stricter than the general 60/minute API limiter). This closes the trivial single-machine bot case.
- **Not mitigated**: a distributed attacker using many IPs or proxies, registering slowly, is not stopped by IP-based rate limiting. A more complete fix (CAPTCHA, proof-of-work, or some form of identity verification on registration) would close this further but adds friction for legitimate users and hasn't been built. This is an accepted tradeoff at the current scale and userbase size, revisit if abuse is observed in practice.
- **Admin override endpoints** (`/admin/set-tier`, `/admin/reset-scans`) existed as temporary, manual testing tools predating Square integration. **Removed in this release** - `POST /webhook/square` (added in v0.15.0) is the real tier-management path, and has now been verified live in production (real sandbox subscription test, full token-resolution-to-tier-upgrade chain confirmed - see v0.15.0/v0.16.0 CHANGELOG entries), satisfying the condition under which removal was planned. No remaining manual override path exists; tier changes only happen via Square webhooks or direct Redis access.

### Known Gaps - Token in URL Query Parameters (v0.15.0)
The install token is passed as `?token=<uuid>` in links from the extension to `liarsledger.com/pricing` - the extension popup's pricing link, the sidebar's rate-limited upgrade prompt, the capacity-warning nudge, and the standalone report page's Pro upsell card all build this URL so the person doesn't have to manually copy/paste their token at checkout. This is a deliberate tradeoff, not an oversight, made because the no-accounts model leaves the anonymous token as a bearer credential with no second factor - some transport mechanism is needed to carry it from extension storage into a page the browser is being navigated to, and a URL parameter is the simplest one available without new backend infrastructure.

This does not contradict "No User Data Collection" below - the token isn't *collected from* the user, it's generated locally on install and never tied to identity. It is, however, the closest thing this system has to a credential, so its handling gets the same scrutiny a real credential would.

- **Real exposure paths, accepted**: the token is written to local browser history at navigation time (before `history.replaceState` can strip it from the visible address bar); it's logged in plaintext in Render's (and any upstream proxy's) access logs for every `GET /pricing?token=...` request, for as long as logs are retained - this is the most certain exposure path, since it happens on every use rather than only under adversarial conditions; and it's visible in the browser's status bar on link hover and briefly in the address bar before JS strips it.
- **Found via security review (June 2026), not yet fixed**: the sidebar's upgrade link is a distinct, more direct exposure path than the ones above. `content.js` injects the token-bearing URL directly into a DOM anchor's `href` inside the sidebar, which is itself appended to the host page's document. Since the sidebar shares the host page's DOM, JavaScript running on that page (a malicious or compromised news site) can read it directly - e.g. `document.querySelector('[href*="pricing"]')?.href`. This wasn't fixed in the same pass as the rest of this section's tradeoff write-up because the real fix is structural, not a quick patch: routing the upgrade link through `chrome.tabs.create` from the background script (which never exposes the URL to host-page-accessible DOM at all) instead of a content-script-injected anchor. Deferred to a future release; the accepted-blast-radius reasoning below already covers this path too, since it doesn't grant anything beyond what the other exposure paths already accept.
- **Mitigated, not eliminated**: the token is stripped from the visible URL bar via `history.replaceState` immediately on page load; the actual checkout request (`POST /pricing/checkout`) sends the token in the request body rather than a second GET, so it isn't logged a second time at submission; `pricing.html` and `report.html` load no third-party scripts before the strip occurs, so `Referer`-header leakage to an external host is not currently a live path.
- **Why this is acceptable given the actual blast radius**: the token is a random UUID, not predictable or guessable, and not reusable to extract anything beyond what it already grants - shared scan pool access, the ability to subscribe that token to Pro, or `/restore-token` access (which itself requires possession of a real completed Square order reference). Worst case if a token leaks is someone else uses the associated scan allowance, or - paradoxically harmlessly - subscribes that token to Pro using their own card. No PII, payment data, or account access is tied to the token itself.
- **Considered and rejected (for now)**: a short-lived, single-use exchange nonce (the backend mints a temporary value tied to the real token; the URL carries the nonce instead; `/pricing/checkout` exchanges nonce→token server-side) would close the server-log exposure path specifically. Not implemented - meaningful new backend surface (a Redis key with a tight TTL, a new exchange step) for a risk profile this low. Revisit if the token model ever changes to carry higher stakes (e.g. if accounts or email are ever added).

---

## No User Data Collection (By Design)

Liar's Ledger does not collect, store, or transmit:
- Browsing history or article URLs
- User identity, names, or email addresses
- Location or geolocation data
- Authentication credentials
- Financial information

This is a core design principle enforced at every layer.

---

## Pre-Release Checklist

- [x] API keys moved to backend proxy
- [x] Claude / Mistral access only via proxy - no provider keys in extension
- [x] `host_permissions` narrowed to `api.liarsledger.com` only
- [x] `src/config.js` removed from `web_accessible_resources`
- [x] Privacy policy published at liarsledger.com/privacy.html
- [x] COPPA compliance section added
- [x] Permissions justified in Chrome Web Store listing
- [x] `web_accessible_resources` limited to report files only
- [x] Free/Pro tier gating enforced server-side, not just client-side (v0.14.1 - verified via direct API calls bypassing the extension entirely, confirmed 403 on `/api/verify-claim` and `/api/votesmart/*` for free tier, confirmed claim/summary stripped from extraction responses)
- [x] `POST /register` rate-limited separately and more strictly than general API traffic (v0.14.1)
- [x] Admin override endpoints (`/admin/set-tier`, `/admin/reset-scans`) fail closed when `ADMIN_SECRET` is unset - confirmed they 403 rather than fail open
- [x] Admin override endpoints (`/admin/set-tier`, `/admin/reset-scans`) removed from `server/index.js` - `POST /webhook/square` verified live in production as the real tier-management path (v0.16.0)
- [ ] No automated test suite exists yet - all verification in this checklist was done by manual API calls during this release. A real regression test suite covering tier gating would catch issues like the v0.14.0→v0.14.1 pooled-scan-limit bug (see CHANGELOG) automatically.
- [ ] Distributed token-farming (many IPs, slow registration rate) is not mitigated - see "Known Gaps" above
- [ ] Token passed as a URL query parameter to liarsledger.com/pricing is logged in plaintext in server access logs - accepted tradeoff given the token's low blast radius, see "Known Gaps - Token in URL Query Parameters" above

---

## Reporting a Vulnerability

To report a security issue, open a GitHub issue marked **[SECURITY]** or email [security@liarsledger.com](mailto:security@liarsledger.com).