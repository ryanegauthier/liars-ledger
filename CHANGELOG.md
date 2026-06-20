# Changelog

> **Note:** [0.13.0] (Chrome Web Store launch) was submitted for review before [0.14.0]'s freemium work began, and was actually approved on 2026-06-16 — before any of 0.14.0–0.14.2 was built. The approval went unnoticed for several days (no email confirmation arrived; only found by checking the developer dashboard directly), which is why it's documented here after the fact rather than at the time. Listed below in its correct chronological position by approval date, not by when it was noticed or written up.

## [0.15.0] - Unreleased

### Square subscription integration — full Pro billing pipeline

**Design decisions (per SQUAREDESIGN.md)**

- **No email collection. No pre-created customer.** The anonymous token rides as `order.reference_id` into `CreatePaymentLink`. Square's hosted checkout collects whatever contact info Square requires — Liar's Ledger never sees it.
- **Token resolution path (confirmed Feb 2025, Square engineer + independent dev):** `CreatePaymentLink` → Square-hosted checkout → `subscription.created` webhook → `phases[0].order_template_id` → `RetrieveOrder` → `order.reference_id` = our token → `upgradeTier`.
- **`CreatePaymentLink`'s `subscription_plan_id` field takes the plan *variation* ID**, not the top-level plan ID. Misleading name — gotcha is documented in SQUAREDESIGN.md §1 and `server/providers/square.js`.
- **Customer pre-creation is silently ignored by Square** (confirmed Feb 2025 forum thread). `customer_id` passed to `CreatePaymentLink` doesn't stick; Square derives the customer from checkout-entered info. So we don't attempt it.
- **Token relay uses `?token=` query param** (not hash fragment). JS reads it, strips from URL bar, sends only in POST body — raw token never appears in a GET request line to our server. See SQUAREDESIGN.md §2 for full rationale.
- **Recovery via `customer_id`**, not `reference_id`, because billed-cycle orders (what appears on a receipt) may not carry `reference_id` reliably. `square:customer:*` mapping is written at webhook time from the subscription event.
- **Payment-failure event corrected after live-docs verification: `invoice.scheduled_charge_failed`, not `payment.updated`.** The originally planned `payment.updated` FAILED filter was too broad and not subscription-specific. Confirmed against current Square docs that `invoice.scheduled_charge_failed` is the purpose-built event for this.
- **No grace period beyond Square's own retry window.** Square retries automatically on day 3, 6, and 9 after the initial decline (3 attempts), emailing the buyer on each failure — but does **not** auto-cancel the subscription afterward; it stays ACTIVE with an unpaid invoice indefinitely. So `subscription.updated → CANCELED` is not a guaranteed signal. We track failures ourselves (`recordFailedCharge`) and self-downgrade once `count >= 3`, rather than waiting on an event that may never come.
- **WebhooksHelper from `square` npm package** for signature verification — not hand-rolled HMAC.

**`server/scripts/setup-square-catalog.mjs`** *(new)*
- One-time catalog setup: creates `SUBSCRIPTION_PLAN` ("Liar's Ledger Pro") and `SUBSCRIPTION_PLAN_VARIATION` ("Liar's Ledger Pro Monthly", STATIC pricing, configurable amount, no end date).
- Prints `SQUARE_PLAN_ID` and `SQUARE_PLAN_VARIATION_ID` to stdout. Run sandbox first, then production.

**`server/providers/square.js`** *(new)*
- `createPaymentLink({ locationId, referenceId, planVariationId, redirectUrl })` — creates Square-hosted checkout link; embeds anonymous token as `order.reference_id`.
- `retrieveOrder(orderId)` — used in webhook handler (resolve token from order template) and `/restore-token` (validate receipt order, get `customer_id`).
- `verifyWebhookSignature({ rawBody, signature, notificationUrl })` — delegates to `WebhooksHelper.verifySignature` from `square` npm package.

**`server/providers/store.js`**
- Replaced `sq:cust:` / `sq:sub:` key scheme with: `square:ordertemplate:*`, `square:customer:*`, `square:subscription:*`.
- New functions: `storeOrderTemplateMapping`, `lookupTokenByOrderTemplate`, `storeSquareCustomerMapping`, `lookupTokenBySquareCustomer`, `storeSquareSubscriptionMapping`, `lookupTokenBySquareSubscription`.
- **New: `square:failedcharge:{subId}`** *(JSON `{ count, firstFailedAt, lastFailedAt }`, 14-day TTL)* — `recordFailedCharge`, `getFailedCharges`, `clearFailedCharges`. Tracks repeated `invoice.scheduled_charge_failed` events per subscription so the webhook handler can self-downgrade after Square's 3-retry window, since Square doesn't auto-cancel.
- **New: `square:downgradereason:{tokenId}`** *(JSON `{ reason, at }`, 30-day TTL)* — `setDowngradeReason`, `getDowngradeReason`, `clearDowngradeReason`. Set only on a failure-driven downgrade (not a normal user cancellation), so the extension can tell "never subscribed" apart from "subscribed, then card declined 3x" and show the right message. Cleared on successful payment or resubscribe.
- All keys hold opaque IDs only — no PII.

**`server/index.js`**
- `express.json()` `verify` callback stashes `req.rawBody` before parsing (required for webhook HMAC over raw bytes).
- **`POST /pricing/checkout`** — accepts `{ token }`, validates token in Redis, calls `createPaymentLink`, returns `{ url }`. Frontend navigates to Square's hosted checkout. No email collected. `ALLOWED_ORIGINS` must include `https://liarsledger.com`.
- **`POST /webhook/square`** — verifies signature via SDK, responds 200 immediately, handles event after:
  - `subscription.created/updated` ACTIVE/PENDING → resolve token via `orderTemplateId → RetrieveOrder → reference_id` → `upgradeTier("pro")`; clears failed-charge tracking and any stale downgrade-reason marker on reaching ACTIVE. Resolution cached in Redis; future events skip `RetrieveOrder`.
  - `subscription.updated` CANCELED/DEACTIVATED → `upgradeTier("free")`, no downgrade-reason marker (user-initiated, they already know why).
  - `subscription.updated` FAILED → `upgradeTier("free")` **with** downgrade-reason marker set to `payment_failed`.
  - `invoice.payment_made` → idempotent Pro confirmation; clears failed-charge tracking and downgrade-reason marker.
  - **`invoice.scheduled_charge_failed`** *(replaces planned `payment.updated` FAILED handling)* → records the failure via `recordFailedCharge`; once `count >= 3` (matching Square's day 3/6/9 retry schedule), self-downgrades to free **and sets the downgrade-reason marker** — this is the path expected to actually fire in practice, since Square may never send a terminal CANCELED event on its own.
- **`/api/scan-status`** now also returns `downgradeReason` (only queried for free-tier tokens, to skip an extra Redis round-trip for everyone else) — `"payment_failed"` if the token was downgraded that way, otherwise `null`.
- **`POST /restore-token`** — accepts `{ orderReference }` (Square order ID from receipt), calls `RetrieveOrder`, gets `customer_id`, looks up `square:customer:{id}` mapping, returns `{ token }`. Rate-limited (5 attempts / 15 min).

**`server/.env.example`**
- Added: `BACKEND_URL`, `PRICING_SITE_URL`, `SQUARE_ACCESS_TOKEN`, `SQUARE_ENVIRONMENT`, `SQUARE_LOCATION_ID`, `SQUARE_PLAN_ID`, `SQUARE_PLAN_VARIATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_NOTIFICATION_URL`.

**`extension/src/token.js`**
- `updateScanInfo()` now also copies `downgradeReason` from `/api/scan-status` into `chrome.storage.sync` (falls through to `null` when absent from the response, rather than carrying forward a stale stored value — the field is intentionally omitted server-side once cleared, so the client needs to clear it too).

**`extension/background.js`**
- `handleAnalyze()` now builds a single token-bearing `upgradeUrl` (`https://liarsledger.com/pricing?token=<id>`) right after `getOrCreateToken()`, since the token is already in scope there. Used for both `rate_limited` returns (`upgrade_url` field, consumed by `popup.js` and `content.js`'s `renderRateLimited`) and added to the `"ok"` success response (`upgradeUrl` field, consumed by `content.js`'s VoteSmart upsell card and capacity-warning nudge) — previously both were hardcoded to a bare `/pricing` link with no token attached.

**`extension/content.js`**
- VoteSmart upsell card and capacity-warning nudge (`renderCapacityWarning`) now use the token-bearing `results.upgradeUrl` / `response.upgradeUrl` instead of a hardcoded link.

**`popup.html`** / **`popup.js`**
- Account panel: token display (truncated + hover), copy button.
- Pricing link points to `https://liarsledger.com/pricing?token=<id>` (query param, not hash fragment).
- **"Restore Pro after reinstalling" section**: user enters Square order number from receipt email → `POST /restore-token` → on success, swaps `chrome.storage.sync` to recovered token.
- Rate-limited upgrade prompt's link now also resolves its own token from storage as a fallback, in case `result.upgrade_url` is ever missing.
- **`loadScanInfo()`** now checks `token.downgradeReason === "payment_failed"` and shows "Pro paused — your card was declined. Update it in Square to resume." (reusing the existing `.exhausted` alert-red style) instead of the normal tier/scan-count line.

**`LiarsLedger/pricing.html`** / **`pricing-page.js`** / **`pricing.css`**
- Token field only (no email). When a token arrives via `?token=`, the manual paste field is now **hidden entirely** and replaced with a one-click "token detected" confirmation — no copy/paste needed for anyone arriving from the extension. Falls back to the manual field for direct/bookmarked visits.
- On submit: `POST /pricing/checkout` → redirect to `data.url` (Square hosted checkout).
- Success: Square redirects to `liarsledger.com/pricing/success` after payment; tier flip happens via webhook, not on the success page.
- New FAQ item: lost-token recovery, pointing to the extension's Account panel rather than duplicating the flow on-site (we don't collect email, so the website itself can't look up a lost token).
- Square donate button (one-off, unrelated to the subscription flow) left as a visibly disabled placeholder with a detailed TODO, rather than a dead `href="#"`, pending a real Quick Pay Payment Link URL from the Square dashboard.

**`LiarsLedger/privacy.html`**
- §03 Payment processing rewritten to match SQUAREDESIGN.md §5 language exactly:
  - Square's hosted checkout collects contact/payment info; we never see it.
  - We retain only an opaque identifier pairing (customer + subscription IDs → token). No name, email, or payment data.
  - Purpose: activate Pro features and allow receipt-based token recovery.
- Short-version summary updated to remove email reference.

**`LiarsLedger/js/site-config.js`**
- Split the single `installUrl` (carried a hardcoded `utm_source=ext_sidebar`) into `installUrl` (clean, used by every on-site install button — nav, hero, pricing tier card, footer, bottom CTA) and `installFromExtensionUrl` (keeps `utm_source=ext_sidebar`, reserved for if/when something inside the extension chrome itself links straight to the Chrome Web Store rather than routing through `/pricing` first). Nothing currently uses the latter — every existing install link is on the website, not inside the extension UI.

### Resolved open questions (previously listed below as unconfirmed)
- ~~Exact Square Invoices API webhook event names for payment-succeeded/failed~~ → confirmed: `invoice.payment_made` (correct as originally planned) and `invoice.scheduled_charge_failed` (corrected from the originally planned `payment.updated` FAILED).
- ~~Square's dunning/retry window for failed payments~~ → confirmed: 3 automatic retries on day 3, 6, and 9 after the initial decline; Square emails the buyer on each attempt; no auto-cancellation afterward.

### Known open questions (still not resolved)
- What identifier actually appears on a buyer's Square receipt email, to finalize `/restore-token` input label and validation. Currently labeled as "Square order # from your receipt" — unverified against an actual receipt.
- Whether a billed-cycle order (as opposed to the order template) reliably carries `reference_id` — `/restore-token` currently sidesteps this by keying off `customer_id` instead, which is the safer-but-unconfirmed-as-strictly-necessary path.
- The Square donation Payment Link (one-off, separate from the subscription flow) still needs to be created in the dashboard and its URL dropped into `pricing.html` — see TODO comment in that file.

### Post-deploy verification (after `git push` + Render redeploy of this version)
Three things worth confirming directly in the Upstash console once this is live — no Redis configuration or migration is needed beforehand (all `square:*` keys, including the new `square:failedcharge:*` and `square:downgradereason:*`, are schemaless and created automatically on first write), but it's worth checking the wiring is actually firing rather than assuming it from code review alone:
1. After a real test subscription completes, confirm `square:ordertemplate:*`, `square:customer:*`, and `square:subscription:*` keys appear in the Upstash Data Browser with the expected token value.
2. After deliberately failing a test charge (Square sandbox supports this), confirm `square:failedcharge:{subId}` appears and increments correctly across the simulated retry sequence.
3. After a simulated 3rd failure, confirm `square:downgradereason:{tokenId}` appears with `reason: "payment_failed"`, and that the extension popup actually shows the "card was declined" message rather than the normal free-tier line — this exercises the full round trip (`store.js` → `/api/scan-status` → `token.js`'s `updateScanInfo` → `popup.js`'s `loadScanInfo`), not just the backend half.

---

## [0.13.0] - 2026-06-16

### Chrome Web Store launch — approved

- **Status: approved and live on the Chrome Web Store as of 2026-06-16.** Submitted for review before 0.14.0's freemium work began, and approval landed the day before 0.14.0–0.14.2 were built — it just went unnoticed for several days (no email confirmation arrived from Chrome Web Store; only found by checking the developer dashboard directly). Sequenced here by actual approval date.
- Store listing: screenshots, short/long description, category.
- Developer account ($5 one-time) set up.
- Install Extension links across `liarsledger.com` (nav, hero, pricing tier card, footer, bottom CTA) all point to the live listing via `data-ll-link="install"` → `site-config.js`'s `installUrl`.

---

## [0.14.2] - 2026-06-17

### Automated test suite (Vitest) + first real-world catch

- **`server/test/`** - new Vitest-based test suite, split into two tiers by cost:
  - `test/free/` - runs by default (`npm test`), zero or near-zero API cost. Covers Pro-tier gating (403s on `/api/verify-claim` and `/api/votesmart/*` for free tier, field-stripping on extraction routes), the pooled-scan-limit regression from 0.14.1, admin endpoint fail-closed behavior, and `/register` validation
  - `test/cost/` - opt-in only (`npm run test:cost`), makes real Claude/Mistral extraction calls (~$0.001/call). Basic sanity checks that extraction returns sensible data
  - `test/helpers.js` - shared utilities (`api()`, `setTestTokenTier()`, `resetTestTokenScans()`) wrapping the same admin endpoints used for manual testing in 0.14.0/0.14.1
- **`server/package.json`** - added `vitest` devDependency, `test`/`test:watch`/`test:cost` scripts
- **`server/vitest.config.js`** / **`vitest.cost.config.js`** - separate configs so the two tiers never accidentally run together
- **Deliberately not tested:** the `/register` rate limiter's actual 5/hour threshold. Verifying it would require sending 6+ rapid registrations, which would itself inflate `global:user_count` and degrade the real pooled limit on every test run - the exact harm the limiter exists to prevent. Documented as a known gap rather than worked around.
- **First real catch:** running this suite for the first time immediately surfaced that `/admin/reset-scans` (added in 0.14.1) was returning 404 against the live deployment, and the pooled-scan-limit regression test failed as a direct consequence (it depends on being able to reset the test token's count first). This strongly suggests the 0.14.1 deploy never actually went live on Render before 0.14.2's changes were bundled in - see the "Known limitation" note below.

### Known limitation
- **Deploy status of 0.14.1 is unconfirmed.** The first test run (pre-0.14.2) showed `/admin/reset-scans` returning 404, which only happens if that route isn't deployed. 0.14.1's and 0.14.2's changes are being pushed together as a single deploy rather than verifying 0.14.1 in isolation first. Re-run `npm test` immediately after this deploy goes live and confirm all tests pass before relying on any of 0.14.0/0.14.1/0.14.2's fixes being active in production.

---

## [0.14.1] - 2026-06-17

### Bugfix - pro tier was bypassing the pooled scan limit entirely

- **`server/providers/store.js`** - removed a stale `tier === "pro"` short-circuit in `incrementScans()` that returned `{ limit: "unlimited", allowed: true }` for any pro token, regardless of the actual pooled limit
  - This was a real regression: `/register` and `/api/scan-status` were correctly updated in 0.14.0 to treat scans as pooled across all tiers, but `incrementScans()` - the function that actually gates `/api/scan/start` - never got the same fix. A pro token hitting `/api/scan/start` had no scan limit at all until this fix.
  - Caught during manual pre-ship verification, not by automated tests - there are none yet for this codebase
- **`server/providers/store.js`** - new `resetScans(tokenId)` - deletes a token's scan-count key for the current day
- **`server/index.js`** - new `POST /admin/reset-scans` (testing convenience, skip waiting until midnight UTC to re-test limits)
  - Shares `checkAdminAuth()` with `/admin/set-tier` (added in 0.14.0) - both fail closed if `ADMIN_SECRET` isn't set on Render
- **Note:** both `/admin/*` routes are temporary, meant to unblock testing before Square integration exists. They should be removed once `/webhook/square` (planned 0.15.0) makes manual tier/scan overrides unnecessary.

---

## [0.14.0] - 2026-06-17

### Freemium tier — dynamic scan limits, pro feature gating, upgrade prompts

- **`server/providers/store.js`** - dynamic free-tier limit table replaces flat 5/day constant
  - `FREE_TIER_TABLE`: 30 scans/day under 500 users, scaling down to 13/6/3/2/1 as registered users grow to 5000+
  - `capacityWarning` flag surfaces once user count crosses 2500 (pre-emptive nudge before the harder cutoff at 5000)
  - `incrementUserCount()` / `getUserCount()` / `getFreeTierLimit()` - global registered-user count drives the active tier, evaluated fresh on every scan rather than hardcoded
- **`server/index.js`** - new `/register` and `/api/scan-status` response shape (`limit`, `remaining`, `capacityWarning`, `userCount`)
  - **New `POST /api/scan/start`** - single source of truth for scan counting, called once per page-scan before any LLM provider runs
  - **Bugfix:** `/api/claude/extract` and `/api/mistral/extract` no longer count scans themselves - dual-model mode was previously double-charging one page-scan as two scans, since both providers fire in parallel and each had its own `countScan` middleware
  - `x-token` added to CORS `allowedHeaders` (harmless leftover from an earlier auth-header exploration; extension still sends `Authorization: Bearer`)
- **`server/middleware/auth.js`** - `countScan` reads the dynamic limit via `incrementScans()` instead of a hardcoded constant; `requireToken` unchanged (`Authorization: Bearer`)
- **`src/token.js`** - UUID generated on install, registered with backend, `Authorization: Bearer` on all proxy requests via `authHeaders()`
  - `syncTier()` now also persists `capacityWarning` to `chrome.storage.local` for `content.js` to read
  - Registration fallback no longer hardcodes `limit: 5` - uses server-provided limit or `null`
- **`background.js`** - calls `/api/scan/start` once before LLM extraction; a 429 here aborts before any provider call (saves API cost on blocked scans, where the old design would still burn a Claude + Mistral call before learning the scan wasn't allowed)
  - `syncTier()` fires (fire-and-forget) immediately after every `/api/scan/start` call, so `chrome.storage.sync` - and therefore `popup.js`'s scan-count display - stays current instead of only refreshing on service worker startup
  - **Pro-tier gating**: free tier has `claim`, `verdict`, `verdict_explanation`, `_verification`, `_claude_claim`, `_mistral_claim`, `_similarity`, `voteSmartVotes`, `voteSmartRatings`, `voteSmartId`, and `articleSummary` stripped from records before returning to the extension. See the "PRO-TIER GATING" comment block in `handleAnalyze` - kept deliberately loud since this list must stay in sync with the upsell copy in `report.js` and `content.js`
  - Internal version string in `background.js` (`ping` handler and startup log) still reads "v0.13.0", not "v0.14.0" - was bumped from a stale v0.12.1 mid-session but never advanced to match this release; worth fixing in the next pass
- **`content.js`** / **`report.js`** - VoteSmart sections replaced with a "Pro feature" upsell card for free tier instead of either silently disappearing or showing a broken-looking empty state ("No topic-matched votes found" etc. with no explanation)
  - `content.js` sidebar: single compressed upsell card combining both Vote History and Interest Group Ratings
  - `report.js` full report: combined section header ("Vote History & Interest Group Ratings · VoteSmart") with upgrade button, "Pro features" label, and a bulleted list (VoteSmart vote history, interest group ratings, AI summary, AI claim analysis) - pro tier still gets the original two separate sections with real data
  - `★ Pro` badge added to sidebar footer, shown only when `tier === "pro"`
  - Capacity warning nudge added to sidebar footer, suppressed for pro users
  - **Bugfix:** rate-limited upgrade card in both files still said "Pro accounts get unlimited scans" - corrected to reflect the pooled-scan model below
- **`popup.js`** - `loadScanInfo()` now called from `handleResult()` after every scan, not just once on popup open - previously the displayed scan count went stale the moment a scan completed and never refreshed until the next service worker restart
- **Fonts** - `IBM Plex Mono` replaced with `Inter` across `content.js`, `report.js`, `popup.html`, `report.html` - chosen for legibility at small UI sizes for the 35-55 target demographic, where the mono typeface's uniform character width was making labels and data blend together. `Oswald` retained for headings/brand/logo.
- **`privacy.html`** - new section 03 (Square payment processing - card details never touch our servers, webhook only flips a tier flag), anonymous installation token disclosed in section 02, Square added to the third-party services list and the "what we don't do" list
- **Design decision - scans are pooled, not tiered:** Pro does **not** mean unlimited scans. All users (free and pro) draw from the same daily scan pool sized by `FREE_TIER_TABLE`. Pro instead unlocks AI claim-vs-record analysis (verdicts, claim text) and full VoteSmart data (vote history, interest group ratings). This is a deliberate departure from the original plan below, made mid-implementation once it became clear unlimited scans for paying users didn't fit the actual cost/abuse model.

### Known limitations
- **Square integration is not built.** No `/webhook/square` endpoint, no subscription management, and no `liarsledger.com/pricing` checkout page exist yet. Pro tier can currently only be granted by manually setting a token's `tier` field in Upstash - this is the blocking piece before Pro can actually be sold.
- No account creation flow on liarsledger.com.
- `report.js` does not load its own fonts (now fixed via `report.html`'s own `<link>` tag, confirmed in this release) - flagging here since it was a brief gap mid-session between updating the script and the page shell.

---

## [0.12.1] - 2026-06-12

### Dictionary rebuild + former members + UX polish

- **`scripts/build-dictionary.cjs`** - new dictionary generator
  - Pulls members from congresses 110–119 (2007–2026) via Congress.gov API
  - Condensed format: `{ members: {}, aliases: {} }` - 1340 members, 8968 aliases, 825KB (was 536 members, 2MB flat)
  - 552 current + 788 former members, with `is_current` flag and `congresses` array
  - Collision resolution: current members preferred, then most recent congress
  - Nickname overrides: MTG, AOC, Bernie, Mitch, Nancy, Al Franken
- **`src/lookup.js`** - rewritten for condensed dictionary format
  - Two-step lookup: `aliases[name]` → `members[bioguide_id]`
  - `lookupAlias()` injects `bioguide_id` from key onto returned member
  - New `"former"` status - resolved but not in 119th Congress
  - `resolveAll()` returns `formerMembers` array alongside `resolved`
- **`background.js`** - former members processed through full pipeline
  - `allMembers = [...resolved, ...formerMembers]` - both go through topic matching, bill lookup, and verification
- **`content.js`** / **`report.js`** - "Former Member · Nth–Nth Congress" badge for non-current members
- **`content.js`** - sidebar persistence
  - Close button hides sidebar instead of removing from DOM
  - `showResults` message handler restores sidebar from session storage via `getResults`
  - `initSidebar()` reshows existing sidebar if already in DOM
- **`popup.js`** - auto-restore on reopen
  - Checks session storage for existing results on popup open
  - URL-matched: only reshows results for the same page
  - Stores `ll_results_url` when scan starts
- **`src/api.js`** - parallel member lookups (`Promise.all` instead of serial loop)
- **`src/api.js`** - GovTrack vote URL fix (`h`/`s` prefix instead of `house`/`senate`)
- **`report.js`** - congress.gov bill URL type map fix (`hres` → `house-resolution`)
- **`scripts/build-release.js`** - auto-copies `config.example.js` → `config.js`, includes `src/verify.js`
- **`privacy.html`** - COPPA section expanded, explicit no-geolocation statement
- **Known limitation:** Congress.gov, GovTrack, and VoteSmart APIs may not serve data for former members who left before the 119th Congress

---

## [0.12.0] - 2026-06-10

### Verdict-driven UI + topic expansion + ceremonial bill filter

- **`content.js`** - claim display now driven by `record.verdict` instead of `record._verification`
  - New CSS classes: `ll-verdict-{supported,contradicted,mixed,insufficient}` (replaces `ll-verified`, `ll-ambiguous`)
  - Verdict labels: "✓ Record supports this claim", "✗ Record contradicts this claim", "⚠ Mixed - record partially supports, partially contradicts", "- Insufficient record data to verify"
  - `verdict_explanation` rendered below the claim text on each card
  - Card border-top color reflects verdict: teal (supported), red (contradicted), amber (mixed)
  - Detail panel updated to match - verdict label and explanation in the expanded view
  - Bill list in detail panel sorted by `introducedDate` descending
- **`report.js`** - politician header `border-top-color` now set from verdict (supported=teal, contradicted=red, mixed/fallback=amber)
- **`src/verify.js`** - two bug fixes
  - Claim now falls back to `_claude_claim` / `_mistral_claim` when `record.claim` is absent
  - `record.full_name` → `record.politician.full_name` (politician is a nested object)
- **`background.js`** - same fix: `r.full_name` → `r.politician.full_name` in post-verification log line
- **`src/api.js`** - ceremonial bills filtered out before results are returned
  - `CEREMONIAL_PATTERNS` list: "honoring the life", "congratulating", "commemorating", "national day of", etc.
  - Bill dedup now also hashes by first 80 characters of title (catches URL-distinct but title-duplicate bills)
- **`src/topic-match.js`** - topic keyword expansion (19 → 25 topics)
  - Single-word triggers replaced with precise multi-word phrases to reduce false positives
  - New dedicated topics: `israel`, `china`, `ukraine`, `russia`, `abortion`, `environment`, `agriculture`, `energy`
  - Existing topics (foreign policy, labor, health care, defense, education, etc.) updated with more specific term sets

---

## [0.11.2] - 2026-05-31

### Bugfix - proxy payload + missing function

- **`src/llm.js`** - proxy-aware request/response handling
  - Proxy mode now sends `{ articleText }` instead of raw API payloads
  - Skips client-side API key check when custom endpoint is configured
  - Proxy responses (already parsed) bypass `parseContent`; direct mode unchanged
- **`src/topic-match.js`** - restored `mergeTopicsForMember()` (dropped in 0.11.0 cleanup)
  - Prioritizes LLM search terms + global topics; falls back to keyword extraction only when LLM provides nothing

---

## [0.11.0] - 2026-05-31

### Code quality pass + docs site + privacy policy

- **Code quality** - full linting and cleanup across all source files
- **Docs site** - live at [docs.liarsledger.com](https://docs.liarsledger.com) via GitHub Pages
- **Privacy policy** - live at [liarsledger.com/privacy.html](https://liarsledger.com/privacy.html)
  - Covers article text handling, third-party services, data retention, open source audit
- **Site links** - all `href` values across `index.html` and `privacy.html` corrected
  - Brand → `liarsledger.com`
  - GitHub → `github.com/ryanegauthier/liars-ledger`
  - Added Docs nav link, fixed contact email, Changelog link, privacy policy link
- **`styles.css`** - added `scroll-margin-top` on anchor targets for sticky header offset

---

## [0.10.0] - 2026-05-30

### Backend proxy + VoteSmart + verified/ambiguous UI

- **`server/`** - Node.js/Express backend proxy, deployed to Render at `api.liarsledger.com`
  - `server/index.js` - Express server with CORS, rate limiting, health check
  - `server/providers/claude.js` - Claude Haiku 4.5 extraction, returns standard shape
  - `server/providers/mistral.js` - Mistral Small extraction, returns standard shape
  - `server/providers/congress.js` - Congress.gov proxy (appends API key server-side)
  - `server/providers/votesmart.js` - VoteSmart v2 JWT auth + auto-refresh (CORS blocked from browser - must go through proxy)
  - `server/render.yaml` - Render deployment config
  - All API keys moved to server environment variables - removed from extension
  - `ALLOWED_ORIGINS` env var restricts access to the extension's Chrome ID
- **`src/votesmart.js`** - VoteSmart client integration
  - Educational API license, JWT auth through proxy
  - Interest group ratings (NRA, ACLU, Chamber of Commerce, AFL-CIO, etc.)
  - Historical key votes
  - VoteSmart candidate ID resolution from politician dictionary
- **`src/llm.js`** - proxy-aware request routing
  - Detects proxy vs direct mode based on endpoint URL
  - Proxy mode: sends `{articleText}` - server handles auth and model calls
  - Direct mode: sends full model request with API keys (dev fallback)
  - `AGREEMENT_THRESHOLD` lowered from 0.65 to 0.55 - catches claims that agree on core assertion but differ in supporting detail
  - Pronoun normalization in `jaccardSimilarity` - "He has called" and "Sanders has called" now score on content words, not subject
  - Prompt updated in all three locations (llm.js, claude.js, mistral.js): added deduplication rule - models told never to return the same person twice with different name formats
  - Separate `claudeEndpoint` / `mistralEndpoint` options - each provider routes independently
- **`background.js`** - verification metadata passed through to records
  - `_verification`, `_claude_claim`, `_mistral_claim`, `_similarity` now on each record
  - `memberJobs` passes `claudeEndpoint` and `mistralEndpoint` separately
- **`content.js`** - verified/ambiguous claim UI
  - `dual_verified`: green left border (3px), teal background tint, `✓ Verified Statement` label, green card top border
  - `ambiguous`: amber border, `⚠ Models disagreed` label, Claude and Mistral claims shown separately
  - `single_model`: plain italic claim, no badge
  - Detail panel mirrors same treatment with `✓ DUAL VERIFIED - CLAUDE & MISTRAL AGREE`
- **`manifest.json`** - added `liars-ledger.onrender.com` to `host_permissions`; removed direct `api.anthropic.com` and `api.mistral.ai` (now proxied)
- **DNS** - `api.liarsledger.com` CNAME → `liars-ledger.onrender.com` (DreamHost, propagating)

### Startup cost reference
| Service | Cost |
|---|---|
| Render Starter (always-on) | $7/month at launch |
| Claude API | ~$0.00075/scan |
| Mistral API | ~$0.00024/scan |
| **Total per 1000 scans** | **~$1.00 + $7/month hosting** |

---

## [0.9.0] - 2026-05-17

### Bill matching fix + GovTrack URL fix

- **`src/api.js`** - two-pass bill relevance matching
  - Pass 1: `billMatchesTopic()` keyword category matching (19 topic buckets)
  - Pass 2: direct title substring match against LLM `search_terms`
  - Untitled amendments filtered out; bills deduped by URL/number
  - Keyword search capped at 6 most specific terms per member
- **`background.js`** - `_llm_search_terms` passed through to `api.js`
- **`src/api.js`** - `resolveGovTrackId` URL fixed to `unitedstates.github.io`
- **`src/llm.js`** - `anthropic-dangerous-direct-browser-access: true` header added

---

## [0.8.0] - 2026-05-17

### Dual-model LLM claim extraction - live

- **`src/llm.js`** - Claude + Mistral in parallel, Jaccard similarity merge
- **`src/lookup.js`** - nickname resolution (40+ overrides)
- **`src/api.js`** - GovTrack roll-call vote integration
- **UI** - restyled to match liarsledger.com (Oswald + IBM Plex Mono, navy/gold/red)

---

## [0.7.0] - 2026-05-11
- Ollama article analysis, Congress.gov roll-call vote beta (replaced by GovTrack)

## [0.6.0] - Sidebar UI
- Bottom bar with politician cards, expandable bill detail, congress.gov links

## [0.4.1] - Logger
- Session storage debug log, popup panel with Copy/Clear

## [0.4.0] - Congress.gov API Integration
- Sponsored/cosponsored lookup, topic keywords, session caching

## [0.3.0] - Politician Dictionary
- 536 members, 3606 lookup keys

## [0.2.0] - Article Detection + Name Extraction
## [0.1.0] - Skeleton

---

## Planned

### [0.16.0] - API cost optimization
- Prompt caching on Claude extraction and verification calls - static instruction prefix cached, only article text varies
- Usage monitoring via Claude Console - cost per endpoint tracking
- Evaluate Mistral prompt caching equivalent

### [0.17.0] - GovTrack extended data
- Ideology scores (0.0 = most liberal, 1.0 = most conservative)
- Missed vote rates and committee assignments
- Historical roll-call votes back to 1990s

### [0.18.0] - Social media scanning (X / Facebook)
- **X (Twitter)** — extract claims from individual tweet pages and thread views
  - Platform-specific content extractor targeting tweet text containers
  - Looser name extraction — last-name-only references ("Trump", "Pelosi") without title prefix
  - Handle short-form text: LLM prompt adjusted for claim extraction from single sentences
  - `manifest.json` host permission: `https://x.com/*`, `https://twitter.com/*`
- **Facebook** — extract claims from public post pages
  - Platform-specific extractor targeting post body containers
  - Handle dynamic React-rendered content — MutationObserver or scan-on-demand
  - `manifest.json` host permission: `https://www.facebook.com/*`
- **Shared work** — user-highlight scan mode: select any text on any page → right-click → "Scan with Liar's Ledger"
  - Fallback for sites with no supported extractor
  - Context menu registered via `chrome.contextMenus`

### [0.19.0] - Creator shareable graphics
- One-click image card: politician name, claim, voting record
- Twitter/X (1200×628) and Instagram (1080×1080) formats
- Canvas API, no server render, Creator tier feature

### [Future] - Performance + bundling
- esbuild or Rollup bundler - combine all `importScripts` files into single bundle
- Minification and tree-shaking for smaller extension size
- Service worker startup time optimization
- Evaluate dictionary compression (gzip or binary format)

### [Future] - TypeScript migration
- Convert extension source (`src/*.js`, `background.js`, `content.js`) to TypeScript
- Add interfaces for dictionary, record, verdict, and LLM response shapes
- Type-safe message passing between popup, content script, and service worker
- Convert server (`server/`) to TypeScript with strict mode
- Build step via `tsc` or `esbuild` with type checking
- Goal: learning experience + catch bugs at compile time (e.g., missing `bioguide_id`)

### [Future] - Firefox / Safari
- Firefox: `browser.*` shim in place; publish to AMO
- Safari: Xcode + Apple Developer account required

### [Future] - State legislators via OpenStates
- Goal: empower voters to see what their politicians at *any level* are saying vs. voting
- Phase 1: add governors + all 50 state legislatures via [OpenStates API](https://openstates.org/)
  - New `server/providers/openstates.js` proxy (same pattern as `govtrack.js`)
  - State bill search and roll-call votes via OpenStates
  - Expand `lookup.js` name resolution to cover state legislators
  - Loosen LLM extraction prompt - include governors and state legislators by name
- Phase 2: local officials (mayors, city councils)
  - No consolidated API exists yet - likely manual curation or crowd-sourced data
  - Structured voting records at municipal level are largely unavailable
- No `manifest.json` host permission changes needed - all calls go through the existing proxy