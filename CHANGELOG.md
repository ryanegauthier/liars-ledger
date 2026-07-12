# Changelog

> **Note:** [0.13.0] (Chrome Web Store launch) was submitted for review before [0.14.0]'s freemium work began, and was actually approved on 2026-06-16 - before any of 0.14.0–0.14.2 was built. The approval went unnoticed for several days (no email confirmation arrived; only found by checking the developer dashboard directly), which is why it's documented here after the fact rather than at the time. Listed below in its correct chronological position by approval date, not by when it was noticed or written up.

## Known Issues (Unresolved)

### Session storage quota exhausts cumulatively over normal use, not just on unusually large scans; popup mislabeled the failure as a timeout (partially mitigated in v0.17.6 -- root cause not fixed)

**Discovered**: 2026-06-28, first seen on a real Pro-tier scan covering 12 senators (12 names × ~20-22 topics each, full VoteSmart ratings/votes per member). Originally suspected to be specific to that scan's unusual size - **confirmed otherwise the next day**: the same user hit the identical error again hours later, on what was not an unusually large scan, after the quota had been manually cleared and had been working fine in between. That recurrence is the important data point - see "Confirmed pattern" below.

**Issue 1 - `browser.storage.session` quota exceeded; results never get stored.**
Console showed `Unchecked runtime.lastError: Session storage quota bytes exceeded. Values were not stored.`, followed by an uncaught promise rejection in `background.js`. The scan itself completed successfully end-to-end per the server-side log on the original occurrence (`"analysis complete - 12 record(s) returned, tier=pro"` - all members resolved, VoteSmart data fetched, Pro claim-verification ran) - the failure is specifically in writing the final result payload to session storage afterward, not in the analysis pipeline itself.

**Confirmed pattern (not just a large-scan trigger): quota exhaustion is cumulative across a browser session.** `vsFetch`'s per-request caching (`vs:${path}` keys, one per VoteSmart page/endpoint) and `apiFetch`'s `api:${path}` caching in `api.js` both write to `browser.storage.session` with no eviction or expiry of old entries - every scan run during a session adds more cached data, and nothing ever removes any of it. The 12-senator scan was likely just the specific moment the quota ceiling got crossed, not the root cause by itself; a normal-sized scan reproduced the identical failure the next day, after enough additional normal-sized scans had accumulated in between. This means **any user who scans enough articles in one browser session, regardless of how large any single scan is, will eventually hit this** - it is a matter of when, not a matter of unusual scan size.

**Confirmed workaround (temporary, not a fix)**: running `await chrome.storage.session.clear();` in the extension's own background-page/service-worker console (NOT a regular webpage's console - `browser`/`chrome.storage` APIs aren't available there) immediately frees the quota and lets scanning resume. Used successfully twice on the same affected account, including once live, minutes before a product demo. This is a release valve, not a real fix - it requires manual intervention via DevTools, isn't something a typical user could be expected to do themselves, and the quota will refill and fail again after enough subsequent normal use.

**Issue 2 - the popup shows "Timed out. Try again." for this failure, which is not what happened.**
The scan did not time out - it ran to completion. The storage-quota failure happens AFTER the pipeline finishes, when writing results for the popup/report page to read. Whatever generic error handling catches this failure in the popup is mislabeling it as a timeout rather than reporting the actual cause, which would mislead anyone (including future debugging sessions, or a confused end user) into investigating network/timeout causes for a problem that's actually about storage capacity.

**Confirmed working correctly, NOT part of this issue**: the same scan that first surfaced this also hit repeated GovTrack 502s, and the v0.17.2 scan-charging fix (`_govtrack_errored` → skip commit) worked exactly as intended - the popup showed "98 scans remaining" after that attempt, confirming the scan was NOT charged against the user's daily limit despite failing. The storage-quota bug is unrelated to and does not undermine that fix.

**Real fix, not yet built**: needs either (a) actively evicting old `vs:`/`api:` cache entries once they age out or once total size approaches the quota, (b) moving large/long-lived cached data to a different storage mechanism with a higher or no quota (e.g. `storage.local` with explicit key expiry), or (c) reducing what gets cached per request in the first place. Manual `chrome.storage.session.clear()` is the only known mitigation today, and it requires DevTools access a typical end user won't have - so until a real fix ships, any non-technical user who hits this has no recourse beyond reinstalling the extension (which would also clear session storage as a side effect, untested but plausible) or contacting support for the same manual-clear step done on their behalf.

**Partially mitigated in v0.17.6**: `safeSessionSet` added to `cache-maintenance.js` -- pre-write eviction check at 50% usage, quota error catch with evict-and-retry rather than unhandled rejection. `USAGE_THRESHOLD_RATIO` lowered 0.65 -> 0.50. `cacheSet` (api.js) and `vsSet` (votesmart.js) both updated to call `safeSessionSet` directly. Popup error codes added: quota failures now surface as `[ERR-CACHE]` rather than "Timed out. Try again.", and a genuine 45-second hang surfaces as `[ERR-HANG]`. **Root cause still not fixed**: unbounded cache growth continues; eviction is reactive, not preventive. Payload size and accumulation rate still not measured. [Jira ticket pending -- Atlassian connector authorized but ticket-creation tooling was not reachable this session; create manually and cross-reference here once filed.]

---

### Square subscription → token resolution can fail silently for a real paying customer

**Discovered**: 2026-06-28, while investigating why a real Pro subscriber (confirmed active subscription in the Square dashboard) was still showing `tier: "free"` in Redis.

**Issue 1 - `subscription.created` sometimes arrives without `phases[0].order_template_id`.**
`resolveTokenFromOrderTemplate` (`server/index.js`) has exactly one resolution path that depends on `order_template_id` being present on the subscription event. The function's own comment documents a 4-step resolution order, including a "last resort: `square:subscription:{subscriptionId}` lookup" - but that lookup can only ever succeed if an *earlier* event already wrote that mapping, and for a brand-new subscriber, `subscription.created` is the earliest event there is. So when `order_template_id` is missing on that first event (confirmed happening live - log: `"subscription event has no order_template_id - cannot resolve token"`), there is currently no working fallback at all, despite the comment implying one exists. The token never gets upgraded; nothing alerts anyone; the customer is charged and never receives Pro access, with no error visible to them or to us beyond a server log line. Rate at which `order_template_id` is actually missing across real subscription events is unknown - this was caught on one real customer, not measured systematically.

**Issue 2 - `restore-token`'s self-service UX is likely unusable as designed for any subscriber.**
The Account panel's "Restore Pro after reinstalling" flow asks users to paste a Square *order* ID from their receipt email. Checked a real subscription invoice PDF (Square invoice #000001) directly: it contains an invoice number (`#000001`) and a "View online" link/QR code resolving to a `squareup.com/u/...` slug, which itself redirects to a URL containing an **invoice template ID** (`invtmp:...`) - not an order ID, and the prefix differs from Square's documented invoice ID format (`inv:...`) seen in their own API examples. There is no order ID visible anywhere on the receipt a real customer receives. This means a user who needs to self-restore (e.g. after hitting Issue 1, or after reinstalling) currently has no way to obtain the input `restore-token` requires, regardless of whether the backend resolution logic is otherwise correct.

**Confirmed via Square's own API docs**: `GetInvoice` (`GET /v2/invoices/{invoice_id}`) returns `order_id` directly on the invoice object, and subscription-billing invoices also carry a `subscription_id` field. This means an invoice ID (the `inv:...` format) *should* resolve to a usable order ID or subscription ID in one more API call - **but it's unconfirmed whether the `invtmp:...` template ID customers actually receive is interchangeable with, or convertible to, a real `inv:...` invoice ID**. Square's own docs list "Invoice templates" under unsupported Invoices API features, which suggests it may not be a 1:1 swap. Not tested live against Square's API before deferring.

**Immediate mitigation (not a fix)**: the one known affected customer was upgraded manually via a direct `upgradeTier(tokenId, "pro")` call / Redis write, bypassing both broken paths entirely.

**Not done as part of this**: no fix to `resolveTokenFromOrderTemplate`'s missing fallback; no fix or redesign of `restore-token`'s required input; no live test confirming whether `invtmp:` IDs are convertible to something usable. No way yet to know how many other subscribers (if any) have silently hit Issue 1. Deferred - needs dedicated investigation time, not a same-night fix.

---

## [0.17.10] - 2026-07-12

### Fixed: our own rate limiter could starve claim verification, not VoteSmart's

Found by inspecting a real support debug log: a 9-member scan showed
"Verification request failed" for every member, alongside 9x `verify: HTTP
429: {"error":"Too many requests, please slow down."}`. This looked like it
could be VoteSmart-side, but it wasn't - it was our own general rate limiter
(`app.use("/api", limiter)`, 60/min per IP) rejecting our own extension's
calls to `/api/verify-claim`, which runs last in a scan after every
Congress.gov/GovTrack/VoteSmart proxy call for every member.

The math: a single large scan (10 figures - the LLM prompt's own cap) costs
~60 proxy requests on its own (2 Congress.gov + 1 GovTrack + up to 3
VoteSmart calls per member) before `verify-claim` even runs. Worse,
VoteSmart's own retry logic (`src/votesmart.js`, added across earlier
releases to cope with its flakiness) amplifies this further - each retried
page can cost up to 12 actual HTTP requests to *our* server (4
`fetchPageWithExtraRetries` attempts x 3 inner `vsFetch` retries each), not
the 1-3 visible in the retry log lines. So the worse VoteSmart's moment is,
the more of our own shared rate-limit budget gets consumed retrying it -
exactly when `verify-claim`, last in line, is most likely to get starved by
a budget it never touched. One third-party hiccup was cascading into a
second, unrelated feature failing for every Pro user on that scan.

**`server/index.js`**
- New `verifyLimiter` (30/min per IP), attached only to `/api/verify-claim`
  - isolates it from proxy-route noise so upstream VoteSmart/Congress.gov/
  GovTrack volume (including retry amplification) can never starve
  verification again. 30/min comfortably covers 3x the 10-figure-per-scan
  cap; this route has no retry logic of its own to amplify further.
- General `limiter` raised from 60/min to 200/min - gives a maxed-out,
  somewhat-flaky single scan real headroom, while still capping a client
  at roughly 3 full scans/minute, which is not normal single-user usage.

This is a server-side change - unlike v0.17.9, this release needs an
actual Render redeploy to take effect, not just an extension reload.

### Topic-matching precision: two more generic-word false positives

Found in the same real report used to confirm the v0.17.9 fixes - both new
findings are the identical failure mode as the `"insurance"` fix in
v0.17.9: an LLM search term's real subject word gets diluted by a second,
overly generic word that survives the filler-word filter and matches
unrelated bills on its own.

**`src/topic-match.js`**
- Added `"public"`/`"option"` to `GENERIC_TOPIC_FILLER_WORDS` - confirmed
  live: "public option healthcare" left "public" as the sole surviving
  distinctive word, which alone matched "Protecting Public Safety
  Employees' Timely Retirement Act" (the same pension bill the
  "retirement" keyword fix in v0.17.9 was supposed to have excluded -
  it came back through a different path). "option" added alongside it for
  the same reason, since it's the other half of the same two-word concept.
- Added `"cost"`/`"costs"` - confirmed live: "healthcare cost crisis" left
  "cost" as the sole surviving distinctive word, which alone matched
  "Increase Federal Disaster Cost Share Act."

**Tests added:** confirmed both words no longer false-positive alone while
their real-subject-word companions (`"healthcare"`) still match correctly.

---

## [0.17.9] - 2026-07-12

### Fixed: office+state fast path could attribute a different person's VoteSmart record

Serious correctness bug in the office+state fast path added in v0.17.8, found
by inspecting a real report: "Mike Thompson" (CA-4) resolved to VoteSmart
`candidateId=179416`, which turned out to be **Mike Levin** (CA-49) - a
completely different representative who happens to also go by "Mike."
Confirmed by pulling both candidates' bios directly (`/v1/candidatebios/
179416` and `/v1/candidatebios/3564`) rather than assuming a VoteSmart data
duplicate.

Two bugs stacked to cause this:

1. `/v1/officials/by-office-id` returns the entire state delegation (51 CA
   House members), not narrowed by surname at all - so matching on first
   name/nickname alone isn't enough to disambiguate when two members share
   one (Thompson and Levin both go by "Mike"). Results sort alphabetically
   by last name, so `Array.find()` hit Levin ("L") before ever reaching
   Thompson ("T").
2. Fixing #1 alone wasn't sufficient: the existing "Pass 1"/"Pass 2" name
   -matching logic right after the fast path unconditionally re-ran against
   the same `officials` array, without a last-name check, because it was
   originally written assuming `officials` always came from a
   lastname-narrowed search. It silently overwrote the now-correct
   fast-path match back to Levin.

**`src/votesmart.js`**
- Fast path's matching predicate now requires `o.lastName` to equal
  `member.last_name` (case-insensitive), in addition to the existing
  office+state+first-name checks.
- Pass 1/Pass 2 now only run `if (!match)` - skipped entirely once the fast
  path has already found a match, instead of unconditionally re-deriving
  `match` against an array that (for the fast path) isn't narrowed by
  surname.

**`src/test/votesmart.test.js`**
- New regression test reproducing the exact scenario (two same-state,
  same-chamber officials sharing a nickname, sorted so the wrong one comes
  first) - failed against the first fix alone, confirming the second bug
  was real before it was found by inspection.
- Three existing tests' mock data was missing a `lastName` field entirely
  (harmless before this fix, since nothing checked it) - added, since the
  new check would otherwise fail to match any of them.

This affects any two same-state, same-chamber members who share a first
name or common nickname - not just Thompson/Levin. Worth treating any
office+state fast-path resolution from v0.17.8 with suspicion; this fix
should be verified live before trusting that release's VoteSmart data
broadly.

### Topic-matching precision: two keyword tightenings, one dedup fix

Found by inspecting a real report for extraneous/irrelevant entries -
the goal is giving users a jump-off point for fact-checking, not a wall of
duplicate or unrelated legislation to sift through.

**`src/topic-match.js`**
- Removed the bare `"retirement"` keyword from the `"social security"`
  category - confirmed live it matched "Protecting Public Safety
  Employees' Timely Retirement Act," a pension-timing bill with nothing to
  do with Social Security policy. The category still matches on the actual
  phrase `"social security"` and its other real keywords.
- Added `"insurance"` to `GENERIC_TOPIC_FILLER_WORDS` - confirmed live the
  LLM search term "health insurance reform" left "insurance" as the sole
  surviving distinctive word (once "reform" was filtered as filler), which
  alone matched "Smoke Exposure Crop Insurance Act" - a farm bill unrelated
  to the health care article being scanned. Only meaningful paired with
  its subject ("health insurance," "flood insurance"), not distinctive by
  itself.

**`src/api.js`**
- `addIfNew`'s title-based dedup now strips a trailing "of YYYY"/"of
  YYYY-YYYY" before comparing titles, collapsing a bill re-introduced
  across multiple Congresses (same title, new bill number each session -
  e.g. "Mental Health Research Accelerator Act of 2025/2023/2022") to just
  the most recent version instead of three near-duplicate rows.

**Tests added:** confirmed the retirement/insurance keywords no longer
false-positive while the category's real keywords still work, and that a
bill re-introduced three times collapses to one entry (modeled directly on
the "Mental Health Research Accelerator Act" case).

---

## [0.17.8] - 2026-07-12

### VoteSmart lookup batching to reduce self-inflicted 502 bursts

`lookupAll()` fired every resolved member's Congress.gov/GovTrack/VoteSmart
lookup in parallel via `Promise.all`, with no cap. Confirmed live on a real
9-member article: 7 of 9 VoteSmart `by-lastname` lookups got 502'd
repeatedly (some ending up with zero VoteSmart data for the scan), while
GovTrack and Congress.gov calls succeeded fine in the same window -
consistent with VoteSmart's proxy load-shedding under burst concurrency
from a single client, not a broad outage.

**`src/api.js`**
- New `LOOKUP_BATCH_SIZE = 3`. `lookupAll()` now processes members in
  batches of 3 sequentially (each member's own Congress.gov/GovTrack/
  VoteSmart fetches still run in parallel with each other within a batch -
  only the number of members in flight at once is capped).
- Validated live the next day on an 18-figure article (8 resolved members):
  batching to size 3 produced zero 502s, full VoteSmart data for every
  member, and the scan completed in ~19s versus the ~66s the unbatched
  9-member scan took (most of that 66s was the 502-retry storm itself, so
  batching improved both reliability and, in the failure case, latency).
- No test added for this specific behavior at the time (see the `api.js`
  test scaffolding entry below, which added one after the fact).

### Debug-log delivery: dead route removed, full log instead of a 20-line tail

**`server/index.js`**
- Removed a duplicate, unreachable `POST /api/support/debug-log` route
  registration (two identical routes existed; Express only ever runs the
  first match, so the second - an older copy with no retry logic - was
  dead code, never a live bug, but real cruft).
- Email preview changed from `logs.slice(-20)` to the full log. A single
  busy scan produces 40+ logger entries (one `api: fetching:` line alone
  per Congress.gov/GovTrack request), so the last-20 tail was silently
  dropping the useful early narrative (LLM provider choice, search terms,
  resolved names) and keeping only late-scan noise. `logger.js`'s existing
  `MAX_ENTRIES=200` cap already bounds this to a reasonable size, and the
  webhook payload was never truncated in the first place - this just
  brings the email in line with it.

**`popup.js`**
- The "Send Debug Log" button's failure handler now parses the response
  body even on a non-2xx status and surfaces the server's actual
  `delivery.email.error`/`delivery.webhook.error` message, instead of just
  `"support upload failed: 502"`. The server already computed this detail;
  the client was discarding it. Since Render's server-side logs aren't
  currently visible (see Open issue #5), this is the only diagnosable
  surface for a delivery failure right now.

### VoteSmart 502s now persisted to the debug log, not just the live console

Requested to give the user concrete, timestamped evidence (endpoint, retry
count, status code) to share with VoteSmart about their infrastructure's
reliability under load.

**`src/votesmart.js`**
- 8 `console.warn`/`console.log` calls converted to `logger.warn`/
  `logger.info` with a `"votesmart"` context: every retry attempt (with
  the exact endpoint and status), the final pagination give-up message,
  both PARTIAL-result warnings (plain and compound-surname retry),
  ID/ratings/votes fetch failures, and the per-member resolved/summary
  lines. These now land in `ll_debug_log` and get included in the debug-log
  email/webhook; previously they only printed to a live DevTools console
  session, which nobody would have open when reporting an issue after the
  fact.
- Left the 4 `[LL DEBUG]` name-resolution scaffolding lines as plain
  `console.log` - those are already marked for removal before Chrome Web
  Store submission, so promoting them to permanent persisted logging
  would work against that.
- Verified end-to-end with a real simulated retry storm (not just read by
  eye): mocked a 502 response, ran `resolveVoteSmartId` against it, and
  confirmed every retry/failure message was captured with the right
  endpoint and status text.

**`src/test/votesmart.test.js`**
- Added a `logger` stub to the test sandbox. It had none before - harmless
  since no existing test exercised a retry/failure path, but would have
  thrown `ReferenceError: logger is not defined` the moment one did, since
  the real runtime always has `logger.js` loaded before `votesmart.js`.

### Test scaffolding for api.js

`api.js` had no test coverage at all before this - its heavy dependencies
(`CONFIG`, `authHeaders`, cache helpers, `logger`, and `topic-match.js`'s
globals) meant verification up to this point was `node --check` plus
tracing the logic by hand, including for the batching change above.

**`src/test/helpers/load-script.js`**
- `loadScript()` now accepts an array of paths as well as a single string,
  loading each into the same sandbox in order - matching real
  `importScripts` load order for files that depend on globals defined by
  an earlier one. Backward compatible; existing single-path callers
  unaffected.

**`src/test/api.test.js`** (new, 18 tests)
- Loads `["src/topic-match.js", "src/api.js"]` together so `api.js`'s
  calls to `billMatchesTopic`/`topicWordsMatchText` exercise the real,
  already-tested implementation instead of a re-mock.
- Covers: proxy URL fallbacks, `cacheGet`/`cacheSet` round-tripping through
  a mocked `safeSessionSet`, `apiFetch`'s cache-hit/miss/error paths,
  `normalizeVotePosition`, `resolveGovTrackId`'s caching,
  `findMemberRollCallVotesOnTopics` (including a real `TOPIC_TITLE_KEYWORDS`
  match), `lookupPoliticianOnTopics` (real category-keyword matching, the
  filler-word LLM-term fallback, ceremonial-bill filtering, cross-list
  dedup, VoteSmart-skip behavior), and `lookupAll`'s batching - the one
  specifically flagged as untested - directly proving concurrency never
  exceeds `LOOKUP_BATCH_SIZE` and that all members still get processed in
  order.
- Discovered and worked around a `vm.runInNewContext` gotcha: arrays/
  objects returned from sandboxed code have a different realm than the
  outer test file's own literals, so `assert.deepEqual(sandboxValue, [])`
  fails Node's strict prototype check even when the contents are
  identical ("same structure but not reference-equal"). Used `.length`/
  element-wise checks instead of `deepEqual` against literals wherever a
  value crosses the sandbox boundary - a reusable gotcha for any future
  tests against `loadScript`-loaded code.

### VoteSmart: real office+state fast path, replacing the never-real endpoint

Resolves Open issue #4. The endpoint previously block-commented out in
`resolveVoteSmartId()`, `/v1/officials/by-office-state`, was never a real
path on `app.votesmart-api.org` at all - confirmed by inspecting the API's
own Swagger parameter list directly, not just re-testing the same URL. Also
investigated `/v1/candidates/by-office-state`, which does exist, but is not
a usable substitute: it returns every candidate who ever ran for an
office+state (329 rows for CA House alone), not just current officeholders,
and has no server-side status filter (`page`, `perPage`, `stateId`,
`stageId`, `electionYear`, `sortBy`, `sortOrder`, `officeId`, `format` are
the complete param list - confirmed via the Swagger "Try it out" panel).

The real equivalent is `/v1/officials/by-office-id` - confirmed live
2026-07-12: 51 rows for CA House (California's actual seat count, one
short - likely a vacancy), every row `officeStatus: "active"`, results
already sorted alphabetically by last name with no `sortBy` needed.

**`src/votesmart.js`**
- `resolveVoteSmartId()` now tries `/v1/officials/by-office-id?officeId=
  {targetOffice}&stateId={state}&perPage=50` as a first pass before the
  existing `by-lastname` flow, reusing `fetchAllVsPages` since the response
  envelope (`data`/`meta.total`/`meta.lastPage`) matches exactly.
- Deliberately minimal in scope: this is a fast path only, not a
  replacement for `by-lastname`. The `by-office-id` response has no
  `preferredName` field (unlike `by-lastname`), so it can't resolve the
  Marie Gluesenkamp Perez-style compound-surname case on its own - the
  existing compound-surname retry against `by-lastname` is unchanged and
  still runs if the fast path (and the plain lastname pass) both miss.
- A bigger redesign was considered and deferred: since `by-office-id`
  returns an entire state's current delegation in one call, a single
  cached fetch could resolve multiple same-state members in one scan
  instead of one `by-lastname` call each. Not implemented here - kept this
  change to the fast-path swap only.

**`src/test/votesmart.test.js`**
- Rewrote the two tests that covered the old disabled-endpoint guard: one
  now confirms `by-office-id` resolves correctly without ever calling
  `by-lastname` (and that the literal, nonexistent `by-office-state` path
  is never hit), the other confirms a proper fallback to `by-lastname` when
  `by-office-id` returns no match.

---

## [0.17.7] - 2026-07-11

### Topic-word matching: filler-word guard for LLM search terms

Found by inspecting a real Pro-tier scan's console log (Rep. Omar, health
care topic) that showed 0 GovTrack roll-call hits despite health-care-heavy
LLM search terms. Root cause: bill/vote matching for any topic string that
isn't one of the 26 predefined `TOPIC_TITLE_KEYWORDS` category names (i.e.
essentially every LLM-generated search term, e.g. "healthcare reform",
"Medicare for All", "hospital funding") required every word in the term to
appear as a literal substring in the title/description (AND logic), unlike
the curated category lists which only require one of several keywords (OR
logic). Real bill titles almost never contain the single word "healthcare"
(official titles use "health care" as two words, or name the program
directly - Medicare, Medicaid, ACA), and generic filler words like "reform",
"funding", "expansion" attached to an otherwise-relevant term made the
AND-match fail even when the real subject word (e.g. "medicare",
"hospital") was present in the title.

**`src/topic-match.js`**
- New `GENERIC_TOPIC_FILLER_WORDS` set - words that pad out LLM search terms
  without being distinctive enough to require, but too generic to accept as
  a standalone OR-match match either (`reform`, `expansion`, `restoration`,
  `funding`, `access`, `affordability`, `cuts`, `subsidy`/`subsidies`,
  `policy`, `act`, `bill`, `law`, `program`, `rights`, `support`,
  `protection`, `relief`, `assistance`, `initiative`, `plan`, plus stopwords
  `for`/`all`/`the`/`and`/`with`).
- New `topicWordsMatchText(topic, text)` - requires at least one
  non-filler word to match rather than every word; falls back to requiring
  every word only if the whole term is filler (rare). Replaces the old
  `words.every(...)` fallback in `billMatchesTopic()`.
- `rollCallMatchesTopics()` - same fallback fixed, calling the new shared
  helper instead of doing nothing beyond the exact-phrase and category-
  keyword checks (this function is exercised by tests but was not actually
  called from any production code path - see `src/api.js` note below).

**`src/api.js`**
- `lookupPoliticianOnTopics()`'s `billMatchesAny()` Pass 2 (Congress.gov
  sponsored/cosponsored bills) - replaced its own duplicated
  `words.every(...)` word-matching with a call to `topicWordsMatchText`.
- `findMemberRollCallVotesOnTopics()` (GovTrack roll-call votes) - this had
  the worst version of the bug: for any non-category topic it only checked
  `blob.includes(topic)`, an exact full-phrase match against the raw
  LLM-paraphrased term, with no word-level fallback at all. Now falls back
  to `topicWordsMatchText` same as the other two call sites. Note this
  function does its own inline matching rather than calling
  `rollCallMatchesTopics()` from `topic-match.js` - left as-is (duplicated
  logic, now at least consistent) rather than consolidating, to keep this
  change scoped to the filler-word fix.

**`src/test/topic-match.test.js`**
- Three new tests modeling the terms seen in the triggering log: matches
  "Medicare for All" via the distinctive word alone, matches "hospital
  funding" when only "hospital" is present, and confirms no match when the
  distinctive word is genuinely absent.

### What this does not fix
- `findMemberRollCallVotesOnTopics()`'s duplicated inline matching logic
  was not consolidated into `topic-match.js`'s `rollCallMatchesTopics()` -
  same behavior now, still two implementations to keep in sync.
- The filler-word list is a manually maintained set, not derived from
  anything - a new generic word pattern in future LLM output could
  reintroduce a narrower version of this same gap.

**Also in this release (housekeeping, found while doing this version
bump)**: `background.js` and `popup.js` both carry version strings that
were missing from CLAUDE.md's documented "touch all version strings" list
(the `ping` message response and startup log line in `background.js`; the
header comment in `popup.js`). Both were stale at `0.17.6` before this
bump despite `manifest.json` etc. already having moved past it in prior
releases - confirmed via a full-repo grep for the old version string, which
should now be part of the version-bump routine going forward. CLAUDE.md
updated to list both files.

### Fixed: stale tier-gating test missing required scanToken (Open issue #5)

`server/test/free/tier-gating.test.js`'s two `/api/claude/extract` tests
("strips claim and summary..." for free tier, "does not strip
claim/summary..." for pro tier) posted directly to that route with no
`scanToken` in the body. Since the scan-token hardening pass added
`requireScanToken` to that route (see `server/middleware/auth.js`), both
tests would now get rejected with 403 ("Scan authorization invalid,
expired, or already used") before ever reaching the tier-stripping logic
they exist to check - the test had gone stale, not the server behavior.

**`server/test/helpers.js`**
- New `getScanToken()` helper: resets the test token's scan count, calls
  `/api/scan/start`, and returns the issued `scanToken` - the same
  reserve-then-extract flow the extension itself follows.

**`server/test/free/tier-gating.test.js`**
- Both `/api/claude/extract` tests now call `getScanToken()` first and pass
  the result as `scanToken` in the request body.

Not run as part of this change - these are live-server integration tests
requiring `API_BASE`/`ADMIN_SECRET`/`TEST_TOKEN` env vars pointed at a real
deployed instance, and incur a real (small) Claude API cost per run. Syntax-
checked only (`node --check`); run `npx vitest` in `server/` against a real
environment to confirm.

### Fixed: content.js's Pro upsell button not using the shared gold class (Open issue #6)

The "Upgrade to Pro →" link in `content.js`'s free-tier claim-upsell card
used a fully inline-styled `<a>` instead of the shared
`.upgrade-to-pro-btn--accent` treatment already used by `popup.html` and
`report.html`. It couldn't literally reuse the class before now because
`content.js`'s injected stylesheet has no CSS custom properties to draw on
(it's injected into arbitrary host pages, which don't define `--accent`/
`--navy`) - the file only had a comment mapping those variable names to
hex values, never a matching class rule.

**`content.js`**
- Added `.upgrade-to-pro-btn--accent` to the injected `<style>` block,
  using the same hex values (`#c8a96e`/`#121f44`/`#9c7f4e`) the file's
  design-system comment already documented.
- The upsell card's `<a>` now uses `class="upgrade-to-pro-btn--accent"`
  (plus an inline `margin-top: 4px` override for card spacing) instead of
  ~13 lines of duplicated inline styles.
- The rate-limit-reached sidebar's separate "View Pricing →" button (red,
  `#c73a25`) was left untouched - it's a deliberately different alert-style
  CTA for a different context, not a duplicate of the gold upsell button.

### Topic ordering: frequency-weighted keyword fallback, LLM prominence ordering

Follow-up to the filler-word fix above, prompted by the same question: could
detected topics be weighted so a topic mentioned many times in the article
(e.g. "immigration" x6) takes precedence over one mentioned once?

**`src/keywords.js`** (the keyword-based fallback path - only used when a
member has no LLM `search_terms` and `main_topics` is empty, i.e. total LLM
failure for that figure)
- `extractTopics()` changed from a boolean `pattern.test(text)` presence
  check to counting actual matches via `text.match(pattern).length`, then
  sorting the returned topic list descending by count. Return type is
  still `string[]` (unchanged contract - no callers or existing tests
  needed updating), just reordered by mention frequency instead of
  `TOPIC_MAP`'s arbitrary declaration order.
- New test in `src/test/keywords.test.js` confirms a topic mentioned 6
  times outranks one mentioned once.

**`server/providers/_shared.js`** and **`src/llm.js`** (the primary,
LLM-driven path - what real scans actually use almost all the time)
- Added a rule to `buildPrompt()`: "Order main_topics from most to least
  prominent in the article - the topic given the most attention or
  mentioned most often comes first." Order already survives downstream via
  `[...new Set([...mainTopicsGlobal, ...])]` in `background.js`, which
  preserves insertion order - no other code changes needed for this to take
  effect.
- Discovered while making this change: `src/llm.js`'s copy of the prompt
  was NOT actually in sync with `_shared.js` despite both files' comments
  claiming otherwise - the figures-inclusion rule wording had drifted
  between the two. `_shared.js` is the real source of truth (confirmed:
  `claude.js`/`mistral.js` import `buildPrompt` from it directly for every
  production request; `src/llm.js`'s copy is only ever invoked in local
  direct-mode dev testing, never in proxy/production mode). Brought
  `src/llm.js`'s rule text in line with `_shared.js` word-for-word, and
  fixed `src/llm.js`'s header comment, which had previously (incorrectly)
  called itself the "canonical version." Verified byte-for-byte identical
  output by running both `buildPrompt()` functions on the same input string
  and comparing results directly, not just by eye.

### What this does not fix
- Dual-model merge (`src/llm.js`'s `main_topics = [...new Set([...cv.main_topics, ...mv.main_topics])].slice(0, 10)`)
  still concatenates Claude's ordered list then Mistral's rather than
  reconciling two independent prominence rankings into one combined
  ranking. Each model's own list is now meaningfully ordered; the merged
  result is not a true cross-model frequency ranking.
- LLM-based ordering is a judgment call by the model, not a verified count
  like the deterministic regex-based counting added to `keywords.js` -
  expect it to be reasonable, not exactly reproducible run to run.

### Fixed: two pre-existing test failures unrelated to any change above

Both predate this entire release (confirmed by stashing all changes and
re-running against plain `main` - same failures occurred there too).

**`src/test/votesmart.test.js`** - 4 of 9 `resolveVoteSmartId` tests were
asserting against a return shape (`candidateId` as a bare string) that the
function stopped using at some point - it now returns `{ id, partial }`
(confirmed via the module's own header comment and its one production call
site in `src/votesmart.js`, which destructures `{ id, partial }`). Updated
assertions to match. Two of the four also assumed the old two-tier
`by-office-state` then `by-lastname` fallback; `by-office-state` is fully
block-commented out in the source (documented 100% 502 rate, not
transient - see the "OPTION B" comment in `src/votesmart.js`), so
`resolveVoteSmartId` now goes straight to `by-lastname` unconditionally.
Rewrote those two tests to match: one now explicitly guards against
`by-office-state` ever being called again (mock throws if it is, instead
of silently returning data), the other just asserts the single actual
`by-lastname` call with its pagination parameters.

**`src/test/cache-maintenance.test.js`** - "logger storage writes route
through the quota-safe session helper" failed for two independent reasons,
fixed one at a time:
1. It tried `const { default: logger } = await import('../logger.js')` -
   `logger.js` has no `export default` (correctly, per CLAUDE.md - it's a
   classic script loaded via `importScripts`, not an ES module; it just
   sets `globalThis.logger`), so this always destructured to `undefined`.
   Switched to using `globalThis.logger`, which the file's own
   `loadHelpers()` already imports and caches.
2. That still failed: `installStorageMock()` calls `resetGlobals()`,
   which deletes `globalThis.logger` (but not `safeSessionSet` or
   `maybeRunCacheMaintenance` - the only reason no other test in this file
   noticed). This test calls `installStorageMock()` after `loadHelpers()`,
   so the mock install wiped out the logger global the test needed right
   after setting it up. Added a second `loadHelpers()` call after
   `installStorageMock()` to restore it from the existing cache.

Full suite: 39/39 passing, 0 failures (previously 34/39 with 5 pre-existing
failures carried across every test run in this release until now).

---

## [0.17.6] - 2026-07-01

### Session storage quota: proactive eviction, write guard, and accurate error codes

Addresses the quota exhaustion issue documented in Known Issues above. Three changes together -- none is sufficient alone.

**`src/cache-maintenance.js`**
- `USAGE_THRESHOLD_RATIO` lowered from `0.65` to `0.50`. A single heavy scan (e.g. 12-senator batch) can write ~1MB in one pass; 65% left only 3.5MB headroom, which is not enough for several such scans in sequence. 50% leaves ~5MB.
- New `safeSessionSet(key, value)` global function -- drop-in replacement for `browser.storage.session.set({key: value})` with two layers of defense:
  1. Pre-write check: if usage is at or above `USAGE_THRESHOLD_RATIO`, evicts all evictable keys before writing. Catches the case where `maybeRunCacheMaintenance()` already ran for this scan but usage has grown further during the scan's own fetches.
  2. Quota error recovery: if the write still throws a quota error (value too large, or usage spiked between check and write), clears all evictable keys and retries once. If the retry also fails, logs and swallows rather than throwing an unhandled rejection. A cache miss on next read is acceptable; a crash is not.
- `safeSessionSet` is a global (not an ES module export) -- available to `api.js` and `votesmart.js` via `importScripts` load order in `background.js`. No `export` statement; adding one would be a syntax error in the classic-script service worker context.
- Comment header updated: "Exports:" corrected to "Globals (available to all scripts loaded after this one via importScripts):" to match the actual load model.

**`src/api.js`**
- `cacheSet(key, value)` now calls `safeSessionSet` directly (no `typeof` guard, no fallback). Load order in `background.js` guarantees `safeSessionSet` is defined when this file loads.

**`src/votesmart.js`**
- `vsSet(key, value)` updated to match -- direct call to `safeSessionSet`, guard and fallback removed.

**`background.js`**
- New `classifyError(err)` helper near the bottom of the file (not inside `handleAnalyze`) maps known error message substrings to structured error codes: `ERR-CACHE` (quota), `ERR-NET` (network), `ERR-TIMEOUT` (abort/timeout), `ERR-AUTH` (401/403), `ERR-UNKNOWN` (anything else).
- `handleAnalyze`'s outer catch now attaches `code: classifyError(err)` alongside `message` on the returned error object, so the popup can show a human-readable message keyed to the code rather than the raw exception string.
- `ll_results` writes in the `analyze` message handler simplified from `if (typeof globalThis.safeSessionSet === "function") { ... } else { browser.storage.session.set(...) }` to direct `safeSessionSet(...)` calls. The guard was unnecessary here -- `cache-maintenance.js` is guaranteed loaded before the first `analyze` message can fire. The fallback was the last remaining direct `browser.storage.session.set` call in the file and the specific write path that produced the original uncaught rejection.

**`src/logger.js`**
- `storageSet(key, value)` routes through `safeSessionSet` when available via `typeof globalThis.safeSessionSet === "function"` check. Unlike `api.js` and `votesmart.js`, `logger.js` loads before `cache-maintenance.js` in `importScripts` order, so the guard is correct and intentional here -- not a candidate for simplification.

**`popup.js`**
- `handleResult` for `status: "error"` replaced raw `result.message` display with a user-facing message looked up from `result.code`, with the code appended in brackets (e.g. "Browser storage full. Try closing and reopening Chrome, then scan again. [ERR-CACHE]"). The bracketed code is intentionally readable without DevTools -- a user can report it directly.
- Timeout branch (the 45-second poll expiry where `ll_results` never left `"working"`) now shows "Scan did not complete. Please try again. [ERR-HANG]" instead of "Timed out. Try again." `ERR-HANG` is intentionally separate from the `classifyError` codes: it means the worker never returned anything at all (crashed before writing to `ll_results`), not that it returned a classified error. A user reporting `[ERR-HANG]` tells you immediately the crash happened before `browser.storage.session.set` was ever reached, which is a different debugging starting point than `[ERR-CACHE]`.

### What this does not fix
- The root cause (unbounded cache growth) is still present. `safeSessionSet` and `maybeRunCacheMaintenance` together make quota exhaustion much less likely and non-crashing when it does occur, but do not bound total cache size. A sufficiently long browser session with enough scans will still eventually fill the quota and trigger eviction cycles.
- The pre-write check and the actual write in `safeSessionSet` are not atomic. Two concurrent `safeSessionSet` calls from `lookupAll`'s `Promise.all` can both read usage below threshold, both skip eviction, and both write -- potentially crossing the limit. The quota error catch handles this as a recovery path (evict + retry) rather than a crash, so the behavior degrades gracefully. A true write lock or queue would be over-engineering for this workload.

---

## [0.17.2] - 2026-06-27

### VoteSmart silent resolution failures - pagination, compound-surname matching, and office-state lookup disabled

**Background**: free-tier users started seeing `VoteSmart: no candidate ID for X` warnings for politicians with common or compound surnames (first caught on Marie Gluesenkamp Perez and Elizabeth Warren). Root cause took a full debugging session to pin down because *three* unrelated bugs were producing the identical symptom, plus VoteSmart itself was actively rate-limiting (`429`) and erroring (`502`) throughout the investigation, which repeatedly obscured which failure was real. v0.17.1 was drafted mid-session as pagination-only but never committed; this release supersedes it with the full fix set, including the compound-surname case that v0.17.1 would have shipped as a known, unfixed gap.

**`src/votesmart.js`**
- **Bug 1 - truncation (Warren and similar)**: `resolveVoteSmartId`'s `/v1/officials/by-lastname` call never paginated. VoteSmart defaults to `perPage=10`; any politician whose record didn't sort into the first page was silently treated as unresolvable, with no error surfaced anywhere - the call returned 200 with a valid-but-incomplete array, so nothing caught it. Confirmed via live testing: Hill (10 results) and Thune (1 result) "worked" by luck of sort order, while Warren's record simply wasn't in the first 10 of 31 total "Warren" results nationwide.
  - **Fix**: new `fetchAllVsPages(basePath)` helper loops `page=1..meta.lastPage`, accumulating `data` across every page, using the `meta.lastPage`/`meta.next` envelope confirmed present on `by-lastname` via direct API testing. 10-page safety cap as a circuit-breaker, not an expected ceiling.
  - **`perPage` raised 10 → 50** after live testing showed a *new* failure mode pagination introduced: a single 429/502 on any one page (even after `vsFetch`'s own per-request retries are exhausted) discards every page already successfully accumulated, failing the whole lookup. Confirmed live on Warren's lookup (failed on page 3 of 4). Fewer pages per lookup directly reduces how often any single lookup is exposed to this. Does not fix it - see Known gap below.
- **Bug 2 - compound surnames (Gluesenkamp Perez)**: VoteSmart files her under the single compound `lastName: "Gluesenkamp Perez"`. Querying `lastName=Perez` alone returns 28 real results across all pages, correctly paginated, and still never includes her - she isn't filed under "Perez" at all, so pagination alone cannot fix this case.
  - **Fix**: if Pass 1 and Pass 2 both fail to find a match AND `member.first_name` has multiple words, retry with a second `by-lastname` query using `{last word of first_name} {last_name}` as a compound-surname guess (e.g. "Gluesenkamp Perez"). Only attempted after the simple lastname search fails, so single-word-surname members (the common case) pay no extra request cost. This is a heuristic, not a general solution - it assumes the compound surname is exactly "last word of dictionary first_name + dictionary last_name," confirmed correct for this case, not guaranteed for every possible compound-surname shape (hyphenation, three-word surnames, etc.).
- **Bug 3 - `firstNameMatches()` missed `preferredName`**: independent of the lastname issue, Marie Gluesenkamp Perez's VoteSmart record has `firstName: "Kristina"` (legal name) with `"Marie"` only in `middleName`/`preferredName`. `firstNameMatches()` only checked `firstName` and `nickName`, so even a correct lastname match would have failed Pass 1 for her.
  - **Fix**: `firstNameMatches()` now also checks `candidate.preferredName`. Confirmed via live testing this was the field that actually closed her match (Pass 1 succeeded, not the looser Pass 2 office+state-only fallback) once the compound-lastname query above also succeeded.
- **`by-office-state` lookup (added same session, disabled)**: an attempt to resolve via `/v1/officials/by-office-state?officeId=X&stateId=Y` directly, sidestepping lastname pagination entirely. Block-commented out after confirming via live testing it 502s on `app.votesmart-api.org` for every `officeId`/`stateId` combination tried (Warren/MA, Hill/AR, Thune/SD - 100% failure rate, ruled out as rate-limiting since failures were immediate and consistent, not intermittent). Suspected cause: `getByOfficeState(officeId, stateId)` is documented against the classic `api.votesmart.org` SOAP-era API and the official `votesmartjs` wrapper, but `app.votesmart-api.org` (a different host) may not implement the same method/shape, or may expect `officeTypeId` (letter code: `"C"`/`"N"`/`"L"`) rather than the numeric `officeId` being sent. Left as a block comment with full context rather than deleted, since it may just need correct params once the actual spec is confirmed.

**`server/index.js`**
- `VOTESMART_ALLOWED_PARAMS` now includes `page` and `perPage` (previously `lastName`, `candidateId`, `officeId`, `stateId` only), so the client's pagination requests aren't rejected by the existing query-parameter allowlist.

**`src/token.js`** (separate issue, found during the same session, NOT part of the VoteSmart fix)
- Confirmed live: a fresh install whose `/register` call fails or never lands server-side (root trigger not confirmed - observed once, did not reproduce on retry) gets a fully-formed-looking fallback token object written to `storage.sync` and displayed in the popup as if registered. Every subsequent authenticated call then 401s with "Token not recognized," with no error ever surfaced to the user, and `syncTier()`'s empty `catch` never retries registration. TODOs added at both spots in the code; not fixed this release - see those TODOs for what the real fix needs (visible retry state, an actual re-registration path).

### Verification
Marie Gluesenkamp Perez confirmed resolving correctly end-to-end (`candidateId=207307`, 5 ratings, 5 votes) against live VoteSmart data, matched via Pass 1 (compound-surname retry + `preferredName`), not the looser fallback. Warren confirmed resolving correctly (`candidateId=141272`) against live VoteSmart data via pagination. Both confirmed client-side against the deployed Render backend with the `page`/`perPage` allowlist change live.

### Not included in this release
- `by-office-state` endpoint/param mismatch (disabled, not resolved)
- Per-page resilience in `fetchAllVsPages` - a single bad page still discards all previously-accumulated pages; `perPage=50` is a mitigation (fewer pages, less exposure), not a fix
- Compound-surname retry is a heuristic confirmed correct for one case, not a general solution for all compound-surname shapes
- Fresh-install registration-failure masking in `src/token.js` (see above - found this session, separate issue, not fixed)
- Social media handle verification (carried over from v0.17.0, still unconfirmed)
- `server/test/free/tier-gating.test.js` asserts `/api/votesmart/*` returns 403 for free tier - stale as of the v0.17.0 tier restructure (VoteSmart is free-tier now, gated by `requireToken` not `requirePro`); test not yet updated to match.

---

## [0.17.0] - 2026-06-27

### Two-phase scan counting + direct Pro checkout from popup

**Background**: congress.gov and GovTrack occasionally time out and return no data. Previously this consumed a scan anyway. This release makes those silent-failure rescans free by splitting scan counting into a reserve-then-commit model: the scan slot is held as a pending reservation at `/api/scan/start` time (anti-abuse: pending reservations still count toward the daily limit), and only finalized when the extension confirms at least one source responded with real data.

**`server/providers/store.js`**
- New: `reserveScan(tokenId, tier)` - replaces `incrementScansWithToken`. Issues both a `scanToken` (gates extraction as before) and a `commitToken` (new; finalizes the count). Pending reservations tracked in a Redis sorted set (`scans:pending:{tokenId}:{date}`, scored by expiry timestamp); expired members pruned via `ZREMRANGEBYSCORE` on each check.
- New: `commitScan(commitToken)` - looks up and deletes `scancommit:{commitToken}` (3-minute TTL key), increments the daily count, removes the member from the pending set. Returns `{ committed: false }` if expired or already consumed.

**`server/middleware/auth.js`**
- `countScan` calls `reserveScan` instead of `incrementScansWithToken`. Attaches `req.commitToken` alongside the existing `req.scanToken`.

**`server/index.js`**
- `POST /api/scan/start` response includes `commitToken`.
- New: `POST /api/scan/commit` - accepts `{ commitToken }`, returns `{ committed }`. Guarded by `requireToken`.

**`src/api.js`**
- `getMemberSponsoredBills`, `getMemberCosponsoredBills`, and `findMemberRollCallVotesOnTopics` now return `{ data, errored }` instead of a bare array, so callers can distinguish "no results because the source timed out" from "no results because there's nothing relevant."
- `lookupPoliticianOnTopics` sets `result._sources_errored = true` only when both congress.gov sources AND GovTrack all error - a partial failure is not treated as a free-scan trigger.

**`background.js`**
- `proxyUrl` and `let commitToken = null` hoisted before the `llmOn` block so both are in scope at every exit path.
- New helper `doCommitScan(proxyUrl, commitToken)` - fires `POST /api/scan/commit`, then `syncTier()` to refresh the popup's displayed count. Fails silently (the reservation expires naturally in 3 minutes if the commit never lands).
- `doCommitScan` called at every normal exit path (no members, no topics, successful result). Deliberately skipped when `records.every(r => r._sources_errored)` - all external sources failed for every member - leaving the pending reservation to expire and giving the user a free retry.

**`popup.html`** / **`popup.js`**
- Account panel: "You need this token to subscribe to Pro at liarsledger.com/pricing..." text blurb replaced with a full-width red Subscribe to Pro button (same `.scan-btn` visual style).
- Button fires `POST /pricing/checkout` directly with the install token, then opens the returned Square checkout URL in a new tab via `browser.tabs.create` - no longer sends the user to the pricing page as an intermediate step.
- Error and 409 (already Pro) states shown inline below the button. `pricingLink` element and its `href`-injection removed.

**`LiarsLedger/pricing.html`** / **`pricing.css`**
- Pro tier card: token input form and submit button replaced with a screenshot CTA (`img/popup-subscribe.png`) and caption. `pricing-page.js` removed from the page.
- Upgrade note rewritten to match the new flow: "Open the extension popup, expand the Account panel, and click Subscribe to Pro."

---

## [0.16.0] - 2026-06-21

### Security hardening - closes scan-limit bypass found in code review

**Background**: a structured principal-engineer-style security review (June 2026) found a High-severity gap - `/api/claude/extract` and `/api/mistral/extract` never independently verified a scan had been counted, so any client holding a valid registered token could call them directly and bypass the daily scan limit entirely. Predates the Square work; tracked separately in `SECURITY.md` from the start rather than folded into the 0.15.x entries. See `SECURITY.md` "Known Gaps - Scan Limit Bypassable" for the full writeup.

**`server/providers/store.js`**
- New: `incrementScansWithToken(tokenId, tier)` - wraps the existing `incrementScans`, additionally issuing a short-lived (60s), single-use scan token (`scantoken:{token}` → `tokenId` in Redis) when the scan is allowed. No token is issued for a rejected (`!allowed`) scan.
- New: `consumeScanToken(scanToken)` - validates and atomically consumes a scan token, returning the `tokenId` it was issued for, or `null` if invalid/expired/already consumed.
- **Bug found via live testing, not code review**: originally implemented via `redis.getdel(key)`. Curl testing showed every consumption attempt failing, including on tokens consumed within ~1 second of issuance - ruling out TTL expiry as the cause. Root cause not fully confirmed: direct inspection of the installed `@upstash/redis` package showed `getdel` does exist as a method, contradicting an initial (incorrect) assumption that it didn't. Switched to plain `get` then `del` - both individually unambiguous and verified - which empirically resolved the failure. This reintroduces a small theoretical race window (two round trips instead of one atomic op), accepted because the realistic concurrent case is dual-model mode's two near-simultaneous calls for the same already-counted scan, not an attacker racing to multiply free extractions - see the function's doc comment for the full reasoning.

**`server/middleware/auth.js`**
- New: `requireScanToken` middleware - required on `/api/claude/extract` and `/api/mistral/extract`. Rejects with 403 if no valid, unconsumed scan token is presented. This is the actual fix for the bypass: there's no way to fabricate a valid scan token without Redis having issued it via a real, counted call to `/api/scan/start`.
- `countScan` (used only on `/api/scan/start` now) updated to call `incrementScansWithToken` and attach the issued `scanToken` to the response.
- **`requireToken` and `countScan` now fail CLOSED on Redis errors by default** (previously failed open - any Bearer token, including unregistered ones, passed as free-tier during an outage; functionally the same cost-abuse exposure as the bypass above, just reached via an outage rather than a direct call). New `AUTH_FAIL_OPEN` env var (default unset = fail closed) restores the old behavior for local dev only - never set in production.

**`server/index.js`**
- `/api/scan/start` response now includes `scanToken`.
- `/api/claude/extract` and `/api/mistral/extract` now require `requireToken, requireScanToken` (was `requireToken` alone).
- **Admin override endpoints removed**: `/admin/set-tier` and `/admin/reset-scans`, along with the `checkAdminAuth` helper, deleted entirely. These existed as temporary manual-override tools predating Square integration; their removal was conditioned on `/webhook/square` being verified live in production, which has now happened (see v0.15.0/v0.15.2 entries and `SECURITY.md`). `resetScans` removed from imports as it's no longer used anywhere in this file.
- **Bug found via live testing, not code review**: the new `checkoutLimiter` (added in v0.15.2 for the `/pricing/checkout` rate limiter) was defined later in the file than the route that referenced it, throwing `ReferenceError: Cannot access 'checkoutLimiter' before initialization` on every server boot - a production outage until caught and fixed. `node --check` does not catch this class of bug, since `const`-before-use is a runtime initialization error, not a syntax error. Moved the definition up alongside the other rate limiters (`limiter`, `registerLimiter`), before any route registrations, with a comment explaining why they're grouped there specifically to prevent this recurring.

**`extension/background.js`**
- `handleAnalyze()` now captures `scanToken` from `/api/scan/start`'s response and passes it through to `extractArticleAnalysis`'s options object.

**`src/llm.js`**
- `extractArticleAnalysisViaClaude` and `extractArticleAnalysisViaMistral`'s proxy-mode request bodies now include `scanToken: options.scanToken` (previously only sent `{ articleText }`). This was the actual missing link - `extractArticleAnalysisDualVerified`'s `{ ...options }` spread already threaded `scanToken` correctly into each provider function's `options`, it just never made it into the two real `fetch()` call bodies.

### Verification
Real curl sequence against production, not just code review: confirmed a call with no `scanToken` returns 403; confirmed a freshly-issued `scanToken`, consumed within ~1 second of issuance, returns 200 with real extraction output; confirmed re-presenting that same `scanToken` a second time returns 403 (single-use property holds, not just "a token was accepted once").

### Additional hardening - remaining Low/Medium findings from the same review

**`server/index.js`**
- **Admin endpoints removed** (covered above) closed the Medium finding on `/pricing/checkout`'s missing rate limiter and the admin-endpoint cleanup together.
- **`/api/verify-claim` input validation**: `claim` and `member` were only checked for truthiness, with no length cap - a Pro user could send an arbitrarily large string, inflating per-call LLM cost (the blast radius is self-contained to that user's own result, not cross-user). Added `MAX_CLAIM_LENGTH` (500) and `MAX_MEMBER_LENGTH` (100) checks, returning 400 on violation.
- **Congress.gov and GovTrack proxies now use a query-parameter allowlist** instead of forwarding `req.query` verbatim. Congress.gov's allowlist (`offset`, `limit`, `fromDateTime`, `toDateTime`, `sort`) is confirmed against Congress.gov's own published API parameter list; `limit` is additionally capped at 250 to match Congress.gov's own server-side cap. GovTrack's allowlist (`person`, `limit`, `order_by`) is scoped conservatively to parameters actually observed in use in `src/api.js`, since GovTrack's full parameter surface wasn't independently verified against live docs the way Congress.gov's was - capped at 100 as a conservative default, not a confirmed GovTrack-side maximum. **VoteSmart's proxy was deliberately left un-allowlisted in this pass** - its parameters (`lastName`, `candidateId`) don't follow the same pagination shape as the other two, and building an allowlist without confirmed VoteSmart API documentation in hand risked blocking a legitimate parameter; the original finding also rated VoteSmart's impact as more limited since it's Pro-gated. Revisit with VoteSmart's docs in hand.

**`server/providers/verify.js`**
- Added `signal: AbortSignal.timeout(30000)` to the Claude fetch call, matching the existing pattern in `server/providers/claude.js` and `src/verify.js`. This fetch had no timeout at all - a Pro user triggering verification during elevated Claude API latency would hold the request open indefinitely (until the OS socket timeout), and a hanging fetch doesn't reject, so `wrap()`'s promise-rejection catch never saw it. Low severity (requires Pro + unusual API conditions), but a real reliability gap.
- **Correction to an earlier note in this same entry**: a previous pass of this changelog claimed this finding was a false positive, based on checking `src/verify.js` (the client-side file) and finding a timeout already present there. That check was real and correct for that file - but `server/providers/verify.js` (this one, the backend provider file the original review was actually about) is a separate file that happens to share the same name, and it genuinely was missing the timeout as described. Checking the wrong of two same-named files and concluding the finding was wrong was itself a mistake, now corrected with the actual fix above.

**Not addressed in this pass, tracked in `SECURITY.md` instead**: the DOM-exposed-token finding (sidebar's injected upgrade link is readable by host-page JavaScript via `document.querySelector`) - a real, distinct exposure path from the already-documented URL-in-history/server-logs tradeoff, but requires a structural change to how `content.js` opens the upgrade link (e.g. routing through `chrome.tabs.create` from the background script instead of a DOM anchor) rather than a quick fix, so it's deferred rather than rushed.

---

## [0.15.2] - 2026-06-20

### Fix - Square `CreatePaymentLink` rejecting subscription checkout requests

**The bug**: the first real sandbox checkout attempt (after 0.15.1's fixes cleared the `trust proxy` and CORS blockers) failed with a Square `400 INVALID_REQUEST_ERROR` - `Value for 'order.line_items' should not be empty`. `createPaymentLink()`'s `order` object only ever set `location_id` and `reference_id`; it never included a line item describing what was actually being purchased.

**Why this wasn't caught earlier**: every prior verification pass (the original design doc, the live-docs check against Square's Subscription Plan Checkout guide, the code review of `square.js`) confirmed `checkout_options.subscription_plan_id` as the field that drives billing cadence and price - which it does - but none of those passes surfaced that `order.line_items` is *independently* required by `CreatePaymentLink` regardless of whether a subscription plan is also specified. This only became visible by actually running a request against Square's API, not by reading documentation about the subscription-specific fields in isolation.

**Investigation - order vs. quick_pay**: Square's docs demonstrate subscription checkout using a `quick_pay` block (`name` + `price_money` + `location_id`) rather than `order`, which raised a real risk: `quick_pay` has no `reference_id`-equivalent field, and the entire token-resolution chain built in 0.15.0 (`order.reference_id` → webhook's `order_template_id` → `RetrieveOrder` → recovered token) depends on that field existing somewhere in the request. Confirmed against Square's `CreatePaymentLink` reference and `quick_pay` documentation that `order` and `quick_pay` are alternate ways of supplying the *same* underlying data - `quick_pay`'s `name`/`price_money` map internally into an `Order` object's line item - so `order` remains a fully supported path and `reference_id` is preserved. No redesign of the token-resolution mechanism was needed.

**`server/providers/square.js`**
- `createPaymentLink()` now accepts `priceCents` and `priceName`, and builds a single `order.line_items` entry (`name`, `quantity: "1"`, `base_price_money`) alongside the existing `location_id`/`reference_id`. Doc comment updated to record the order-vs-quick_pay investigation above, so a future reader doesn't have to re-derive it from a 400 error again.

**`server/index.js`**
- `/pricing/checkout` now reads `SQUARE_PRO_PRICE_CENTS` (default `500` = $5.00) and `SQUARE_PRO_PRICE_NAME` (default `"Liar's Ledger Pro - Monthly"`) from environment, passed through to `createPaymentLink`.
- **Operational note, not just a code change**: per Square's own Subscription Plan Checkout docs, this price must match the plan variation's actual catalog price (set via `setup-square-catalog.mjs`) - a mismatch acts as a checkout-time price *override*, not just display text. `SQUARE_PRO_PRICE_CENTS` is a second, manually-maintained source of truth for a value Square's catalog already holds; if the Pro price is ever changed in the Square dashboard or by re-running the setup script, this env var must be updated to match by hand, or checkout will silently charge the wrong amount.

**`server/.env.example`**
- Added: `SQUARE_PRO_PRICE_CENTS`, `SQUARE_PRO_PRICE_NAME`.

---

## [0.15.1] - 2026-06-20

### Fixes - two bugs caught during sandbox verification of 0.15.0

**`server/index.js`**
- **`app.set("trust proxy", 1)`** added immediately after app creation, before any middleware. Render sits behind a single reverse-proxy hop that sets `X-Forwarded-For` on every request; Express's default (`trust proxy: false`) ignores that header and falls back to the proxy's own connection IP for anything IP-based. `express-rate-limit` detected the mismatch and threw `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` rather than silently misidentifying every visitor as the same IP - which would have made the `/register`, general API, and `/restore-token` rate limiters (all keyed by IP) meaningless, treating every distinct user as one. Caught live in Render's logs during the first real subscription-flow test against Square sandbox, not in code review - this had been live since whichever release first added `express-rate-limit` and nothing had hit those limiter code paths hard enough to surface it until now.

**`extension/report.js`**
- The standalone full-report page's "Upgrade to Pro" link (`proFeaturesUpsellHtml`, shown in the VoteSmart section for free-tier users) was still hardcoded to a bare `https://liarsledger.com/pricing` with no token - the fourth place this exact bug was found independently, after the sidebar card, the rate-limited prompt, and the capacity-warning nudge (all fixed earlier in 0.15.0's work). `loadReport()` now also reads `ll_auth_token` from `chrome.storage.sync` (a separate storage area from `ll_results`, which is all it read before) and builds the same `?token=` URL pattern used everywhere else, threaded through `renderRecord`'s new third parameter.
- **Note for future review**: this is the fourth instance of the same bug class found one screenshot at a time rather than in a single deliberate pass. Worth a dedicated search (`grep -rn "liarsledger.com/pricing" extension/`) before the next release that touches any upsell surface, rather than relying on catching the fifth instance by accident too.

---

## [0.15.0] - 2026-06-20

### Square subscription integration - full Pro billing pipeline

**Design decisions (per SQUAREDESIGN.md)**

- **No email collection. No pre-created customer.** The anonymous token rides as `order.reference_id` into `CreatePaymentLink`. Square's hosted checkout collects whatever contact info Square requires - Liar's Ledger never sees it.
- **Token resolution path (confirmed Feb 2025, Square engineer + independent dev):** `CreatePaymentLink` → Square-hosted checkout → `subscription.created` webhook → `phases[0].order_template_id` → `RetrieveOrder` → `order.reference_id` = our token → `upgradeTier`.
- **`CreatePaymentLink`'s `subscription_plan_id` field takes the plan *variation* ID**, not the top-level plan ID. Misleading name - gotcha is documented in SQUAREDESIGN.md §1 and `server/providers/square.js`.
- **Customer pre-creation is silently ignored by Square** (confirmed Feb 2025 forum thread). `customer_id` passed to `CreatePaymentLink` doesn't stick; Square derives the customer from checkout-entered info. So we don't attempt it.
- **Token relay uses `?token=` query param** (not hash fragment). JS reads it, strips from URL bar, sends only in POST body - raw token never appears in a GET request line to our server. See SQUAREDESIGN.md §2 for full rationale.
- **Recovery via `customer_id`**, not `reference_id`, because billed-cycle orders (what appears on a receipt) may not carry `reference_id` reliably. `square:customer:*` mapping is written at webhook time from the subscription event.
- **Payment-failure event corrected after live-docs verification: `invoice.scheduled_charge_failed`, not `payment.updated`.** The originally planned `payment.updated` FAILED filter was too broad and not subscription-specific. Confirmed against current Square docs that `invoice.scheduled_charge_failed` is the purpose-built event for this.
- **No grace period beyond Square's own retry window.** Square retries automatically on day 3, 6, and 9 after the initial decline (3 attempts), emailing the buyer on each failure - but does **not** auto-cancel the subscription afterward; it stays ACTIVE with an unpaid invoice indefinitely. So `subscription.updated → CANCELED` is not a guaranteed signal. We track failures ourselves (`recordFailedCharge`) and self-downgrade once `count >= 3`, rather than waiting on an event that may never come.
- **WebhooksHelper from `square` npm package** for signature verification - not hand-rolled HMAC.

**`server/scripts/setup-square-catalog.mjs`** *(new)*
- One-time catalog setup: creates `SUBSCRIPTION_PLAN` ("Liar's Ledger Pro") and `SUBSCRIPTION_PLAN_VARIATION` ("Liar's Ledger Pro Monthly", STATIC pricing, configurable amount, no end date).
- Prints `SQUARE_PLAN_ID` and `SQUARE_PLAN_VARIATION_ID` to stdout. Run sandbox first, then production.

**`server/providers/square.js`** *(new)*
- `createPaymentLink({ locationId, referenceId, planVariationId, redirectUrl })` - creates Square-hosted checkout link; embeds anonymous token as `order.reference_id`.
- `retrieveOrder(orderId)` - used in webhook handler (resolve token from order template) and `/restore-token` (validate receipt order, get `customer_id`).
- `verifyWebhookSignature({ rawBody, signature, notificationUrl })` - delegates to `WebhooksHelper.verifySignature` from `square` npm package.

**`server/providers/store.js`**
- Replaced `sq:cust:` / `sq:sub:` key scheme with: `square:ordertemplate:*`, `square:customer:*`, `square:subscription:*`.
- New functions: `storeOrderTemplateMapping`, `lookupTokenByOrderTemplate`, `storeSquareCustomerMapping`, `lookupTokenBySquareCustomer`, `storeSquareSubscriptionMapping`, `lookupTokenBySquareSubscription`.
- **New: `square:failedcharge:{subId}`** *(JSON `{ count, firstFailedAt, lastFailedAt }`, 14-day TTL)* - `recordFailedCharge`, `getFailedCharges`, `clearFailedCharges`. Tracks repeated `invoice.scheduled_charge_failed` events per subscription so the webhook handler can self-downgrade after Square's 3-retry window, since Square doesn't auto-cancel.
- **New: `square:downgradereason:{tokenId}`** *(JSON `{ reason, at }`, 30-day TTL)* - `setDowngradeReason`, `getDowngradeReason`, `clearDowngradeReason`. Set only on a failure-driven downgrade (not a normal user cancellation), so the extension can tell "never subscribed" apart from "subscribed, then card declined 3x" and show the right message. Cleared on successful payment or resubscribe.
- All keys hold opaque IDs only - no PII.

**`server/index.js`**
- `express.json()` `verify` callback stashes `req.rawBody` before parsing (required for webhook HMAC over raw bytes).
- **`POST /pricing/checkout`** - accepts `{ token }`, validates token in Redis, calls `createPaymentLink`, returns `{ url }`. Frontend navigates to Square's hosted checkout. No email collected. `ALLOWED_ORIGINS` must include `https://liarsledger.com`.
- **`POST /webhook/square`** - verifies signature via SDK, responds 200 immediately, handles event after:
  - `subscription.created/updated` ACTIVE/PENDING → resolve token via `orderTemplateId → RetrieveOrder → reference_id` → `upgradeTier("pro")`; clears failed-charge tracking and any stale downgrade-reason marker on reaching ACTIVE. Resolution cached in Redis; future events skip `RetrieveOrder`.
  - `subscription.updated` CANCELED/DEACTIVATED → `upgradeTier("free")`, no downgrade-reason marker (user-initiated, they already know why).
  - `subscription.updated` FAILED → `upgradeTier("free")` **with** downgrade-reason marker set to `payment_failed`.
  - `invoice.payment_made` → idempotent Pro confirmation; clears failed-charge tracking and downgrade-reason marker.
  - **`invoice.scheduled_charge_failed`** *(replaces planned `payment.updated` FAILED handling)* → records the failure via `recordFailedCharge`; once `count >= 3` (matching Square's day 3/6/9 retry schedule), self-downgrades to free **and sets the downgrade-reason marker** - this is the path expected to actually fire in practice, since Square may never send a terminal CANCELED event on its own.
- **`/api/scan-status`** now also returns `downgradeReason` (only queried for free-tier tokens, to skip an extra Redis round-trip for everyone else) - `"payment_failed"` if the token was downgraded that way, otherwise `null`.
- **`POST /restore-token`** - accepts `{ orderReference }` (Square order ID from receipt), calls `RetrieveOrder`, gets `customer_id`, looks up `square:customer:{id}` mapping, returns `{ token }`. Rate-limited (5 attempts / 15 min).

**`server/.env.example`**
- Added: `BACKEND_URL`, `PRICING_SITE_URL`, `SQUARE_ACCESS_TOKEN`, `SQUARE_ENVIRONMENT`, `SQUARE_LOCATION_ID`, `SQUARE_PLAN_ID`, `SQUARE_PLAN_VARIATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_NOTIFICATION_URL`.

**`extension/src/token.js`**
- `updateScanInfo()` now also copies `downgradeReason` from `/api/scan-status` into `chrome.storage.sync` (falls through to `null` when absent from the response, rather than carrying forward a stale stored value - the field is intentionally omitted server-side once cleared, so the client needs to clear it too).

**`extension/background.js`**
- `handleAnalyze()` now builds a single token-bearing `upgradeUrl` (`https://liarsledger.com/pricing?token=<id>`) right after `getOrCreateToken()`, since the token is already in scope there. Used for both `rate_limited` returns (`upgrade_url` field, consumed by `popup.js` and `content.js`'s `renderRateLimited`) and added to the `"ok"` success response (`upgradeUrl` field, consumed by `content.js`'s VoteSmart upsell card and capacity-warning nudge) - previously both were hardcoded to a bare `/pricing` link with no token attached.

**`extension/content.js`**
- VoteSmart upsell card and capacity-warning nudge (`renderCapacityWarning`) now use the token-bearing `results.upgradeUrl` / `response.upgradeUrl` instead of a hardcoded link.

**`popup.html`** / **`popup.js`**
- Account panel: token display (truncated + hover), copy button.
- Pricing link points to `https://liarsledger.com/pricing?token=<id>` (query param, not hash fragment).
- **"Restore Pro after reinstalling" section**: user enters Square order number from receipt email → `POST /restore-token` → on success, swaps `chrome.storage.sync` to recovered token.
- Rate-limited upgrade prompt's link now also resolves its own token from storage as a fallback, in case `result.upgrade_url` is ever missing.
- **`loadScanInfo()`** now checks `token.downgradeReason === "payment_failed"` and shows "Pro paused - your card was declined. Update it in Square to resume." (reusing the existing `.exhausted` alert-red style) instead of the normal tier/scan-count line.

**`LiarsLedger/pricing.html`** / **`pricing-page.js`** / **`pricing.css`**
- Token field only (no email). When a token arrives via `?token=`, the manual paste field is now **hidden entirely** and replaced with a one-click "token detected" confirmation - no copy/paste needed for anyone arriving from the extension. Falls back to the manual field for direct/bookmarked visits.
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
- Split the single `installUrl` (carried a hardcoded `utm_source=ext_sidebar`) into `installUrl` (clean, used by every on-site install button - nav, hero, pricing tier card, footer, bottom CTA) and `installFromExtensionUrl` (keeps `utm_source=ext_sidebar`, reserved for if/when something inside the extension chrome itself links straight to the Chrome Web Store rather than routing through `/pricing` first). Nothing currently uses the latter - every existing install link is on the website, not inside the extension UI.

### Resolved open questions (previously listed below as unconfirmed)
- ~~Exact Square Invoices API webhook event names for payment-succeeded/failed~~ → confirmed: `invoice.payment_made` (correct as originally planned) and `invoice.scheduled_charge_failed` (corrected from the originally planned `payment.updated` FAILED).
- ~~Square's dunning/retry window for failed payments~~ → confirmed: 3 automatic retries on day 3, 6, and 9 after the initial decline; Square emails the buyer on each attempt; no auto-cancellation afterward.

### Known open questions (still not resolved)
- What identifier actually appears on a buyer's Square receipt email, to finalize `/restore-token` input label and validation. Currently labeled as "Square order # from your receipt" - unverified against an actual receipt.
- Whether a billed-cycle order (as opposed to the order template) reliably carries `reference_id` - `/restore-token` currently sidesteps this by keying off `customer_id` instead, which is the safer-but-unconfirmed-as-strictly-necessary path.
- The Square donation Payment Link (one-off, separate from the subscription flow) still needs to be created in the dashboard and its URL dropped into `pricing.html` - see TODO comment in that file.

### Post-deploy verification (after `git push` + Render redeploy of this version)
Three things worth confirming directly in the Upstash console once this is live - no Redis configuration or migration is needed beforehand (all `square:*` keys, including the new `square:failedcharge:*` and `square:downgradereason:*`, are schemaless and created automatically on first write), but it's worth checking the wiring is actually firing rather than assuming it from code review alone:
1. After a real test subscription completes, confirm `square:ordertemplate:*`, `square:customer:*`, and `square:subscription:*` keys appear in the Upstash Data Browser with the expected token value.
2. After deliberately failing a test charge (Square sandbox supports this), confirm `square:failedcharge:{subId}` appears and increments correctly across the simulated retry sequence.
3. After a simulated 3rd failure, confirm `square:downgradereason:{tokenId}` appears with `reason: "payment_failed"`, and that the extension popup actually shows the "card was declined" message rather than the normal free-tier line - this exercises the full round trip (`store.js` → `/api/scan-status` → `token.js`'s `updateScanInfo` → `popup.js`'s `loadScanInfo`), not just the backend half.

---

## [0.13.0] - 2026-06-16

### Chrome Web Store launch - approved

- **Status: approved and live on the Chrome Web Store as of 2026-06-16.** Submitted for review before 0.14.0's freemium work began, and approval landed the day before 0.14.0–0.14.2 were built - it just went unnoticed for several days (no email confirmation arrived from Chrome Web Store; only found by checking the developer dashboard directly). Sequenced here by actual approval date.
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

### Freemium tier - dynamic scan limits, pro feature gating, upgrade prompts

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

### [0.18.0] - GovTrack extended data
- Ideology scores (0.0 = most liberal, 1.0 = most conservative)
- Missed vote rates and committee assignments
- Historical roll-call votes back to 1990s

### [Future] - API cost optimization
- Prompt caching on Claude extraction and verification calls - static instruction prefix cached, only article text varies
- Usage monitoring via Claude Console - cost per endpoint tracking
- Evaluate Mistral prompt caching equivalent

### [0.19.0] - Social media scanning (X / Facebook)
- **X (Twitter)** - extract claims from individual tweet pages and thread views
  - Platform-specific content extractor targeting tweet text containers
  - Looser name extraction - last-name-only references ("Trump", "Pelosi") without title prefix
  - Handle short-form text: LLM prompt adjusted for claim extraction from single sentences
  - `manifest.json` host permission: `https://x.com/*`, `https://twitter.com/*`
- **Facebook** - extract claims from public post pages
  - Platform-specific extractor targeting post body containers
  - Handle dynamic React-rendered content - MutationObserver or scan-on-demand
  - `manifest.json` host permission: `https://www.facebook.com/*`
- **Shared work** - user-highlight scan mode: select any text on any page → right-click → "Scan with Liar's Ledger"
  - Fallback for sites with no supported extractor
  - Context menu registered via `chrome.contextMenus`

### [0.20.0] - Creator shareable graphics
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