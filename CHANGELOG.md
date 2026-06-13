# Changelog

## [0.12.1] - 2026-06-12

### Dictionary rebuild + former members + UX polish

- **`scripts/build-dictionary.cjs`** — new dictionary generator
  - Pulls members from congresses 110–119 (2007–2026) via Congress.gov API
  - Condensed format: `{ members: {}, aliases: {} }` — 1340 members, 8968 aliases, 825KB (was 536 members, 2MB flat)
  - 552 current + 788 former members, with `is_current` flag and `congresses` array
  - Collision resolution: current members preferred, then most recent congress
  - Nickname overrides: MTG, AOC, Bernie, Mitch, Nancy, Al Franken
- **`src/lookup.js`** — rewritten for condensed dictionary format
  - Two-step lookup: `aliases[name]` → `members[bioguide_id]`
  - `lookupAlias()` injects `bioguide_id` from key onto returned member
  - New `"former"` status — resolved but not in 119th Congress
  - `resolveAll()` returns `formerMembers` array alongside `resolved`
- **`background.js`** — former members processed through full pipeline
  - `allMembers = [...resolved, ...formerMembers]` — both go through topic matching, bill lookup, and verification
- **`content.js`** / **`report.js`** — "Former Member · Nth–Nth Congress" badge for non-current members
- **`content.js`** — sidebar persistence
  - Close button hides sidebar instead of removing from DOM
  - `showResults` message handler restores sidebar from session storage via `getResults`
  - `initSidebar()` reshows existing sidebar if already in DOM
- **`popup.js`** — auto-restore on reopen
  - Checks session storage for existing results on popup open
  - URL-matched: only reshows results for the same page
  - Stores `ll_results_url` when scan starts
- **`src/api.js`** — parallel member lookups (`Promise.all` instead of serial loop)
- **`src/api.js`** — GovTrack vote URL fix (`h`/`s` prefix instead of `house`/`senate`)
- **`report.js`** — congress.gov bill URL type map fix (`hres` → `house-resolution`)
- **`scripts/build-release.js`** — auto-copies `config.example.js` → `config.js`, includes `src/verify.js`
- **`privacy.html`** — COPPA section expanded, explicit no-geolocation statement
- **Known limitation:** Congress.gov, GovTrack, and VoteSmart APIs may not serve data for former members who left before the 119th Congress

---

## [0.12.0] - 2026-06-10

### Verdict-driven UI + topic expansion + ceremonial bill filter

- **`content.js`** — claim display now driven by `record.verdict` instead of `record._verification`
  - New CSS classes: `ll-verdict-{supported,contradicted,mixed,insufficient}` (replaces `ll-verified`, `ll-ambiguous`)
  - Verdict labels: "✓ Record supports this claim", "✗ Record contradicts this claim", "⚠ Mixed — record partially supports, partially contradicts", "— Insufficient record data to verify"
  - `verdict_explanation` rendered below the claim text on each card
  - Card border-top color reflects verdict: teal (supported), red (contradicted), amber (mixed)
  - Detail panel updated to match — verdict label and explanation in the expanded view
  - Bill list in detail panel sorted by `introducedDate` descending
- **`report.js`** — politician header `border-top-color` now set from verdict (supported=teal, contradicted=red, mixed/fallback=amber)
- **`src/verify.js`** — two bug fixes
  - Claim now falls back to `_claude_claim` / `_mistral_claim` when `record.claim` is absent
  - `record.full_name` → `record.politician.full_name` (politician is a nested object)
- **`background.js`** — same fix: `r.full_name` → `r.politician.full_name` in post-verification log line
- **`src/api.js`** — ceremonial bills filtered out before results are returned
  - `CEREMONIAL_PATTERNS` list: "honoring the life", "congratulating", "commemorating", "national day of", etc.
  - Bill dedup now also hashes by first 80 characters of title (catches URL-distinct but title-duplicate bills)
- **`src/topic-match.js`** — topic keyword expansion (19 → 25 topics)
  - Single-word triggers replaced with precise multi-word phrases to reduce false positives
  - New dedicated topics: `israel`, `china`, `ukraine`, `russia`, `abortion`, `environment`, `agriculture`, `energy`
  - Existing topics (foreign policy, labor, health care, defense, education, etc.) updated with more specific term sets

---

## [0.11.2] - 2026-05-31

### Bugfix — proxy payload + missing function

- **`src/llm.js`** — proxy-aware request/response handling
  - Proxy mode now sends `{ articleText }` instead of raw API payloads
  - Skips client-side API key check when custom endpoint is configured
  - Proxy responses (already parsed) bypass `parseContent`; direct mode unchanged
- **`src/topic-match.js`** — restored `mergeTopicsForMember()` (dropped in 0.11.0 cleanup)
  - Prioritizes LLM search terms + global topics; falls back to keyword extraction only when LLM provides nothing

---

## [0.11.0] - 2026-05-31

### Code quality pass + docs site + privacy policy

- **Code quality** — full linting and cleanup across all source files
- **Docs site** — live at [docs.liarsledger.com](https://docs.liarsledger.com) via GitHub Pages
- **Privacy policy** — live at [liarsledger.com/privacy.html](https://liarsledger.com/privacy.html)
  - Covers article text handling, third-party services, data retention, open source audit
- **Site links** — all `href` values across `index.html` and `privacy.html` corrected
  - Brand → `liarsledger.com`
  - GitHub → `github.com/ryanegauthier/liars-ledger`
  - Added Docs nav link, fixed contact email, Changelog link, privacy policy link
- **`styles.css`** — added `scroll-margin-top` on anchor targets for sticky header offset

---

## [0.10.0] - 2026-05-30

### Backend proxy + VoteSmart + verified/ambiguous UI

- **`server/`** — Node.js/Express backend proxy, deployed to Render at `api.liarsledger.com`
  - `server/index.js` — Express server with CORS, rate limiting, health check
  - `server/providers/claude.js` — Claude Haiku 4.5 extraction, returns standard shape
  - `server/providers/mistral.js` — Mistral Small extraction, returns standard shape
  - `server/providers/congress.js` — Congress.gov proxy (appends API key server-side)
  - `server/providers/votesmart.js` — VoteSmart v2 JWT auth + auto-refresh (CORS blocked from browser — must go through proxy)
  - `server/render.yaml` — Render deployment config
  - All API keys moved to server environment variables — removed from extension
  - `ALLOWED_ORIGINS` env var restricts access to the extension's Chrome ID
- **`src/votesmart.js`** — VoteSmart client integration
  - Educational API license, JWT auth through proxy
  - Interest group ratings (NRA, ACLU, Chamber of Commerce, AFL-CIO, etc.)
  - Historical key votes
  - VoteSmart candidate ID resolution from politician dictionary
- **`src/llm.js`** — proxy-aware request routing
  - Detects proxy vs direct mode based on endpoint URL
  - Proxy mode: sends `{articleText}` — server handles auth and model calls
  - Direct mode: sends full model request with API keys (dev fallback)
  - `AGREEMENT_THRESHOLD` lowered from 0.65 to 0.55 — catches claims that agree on core assertion but differ in supporting detail
  - Pronoun normalization in `jaccardSimilarity` — "He has called" and "Sanders has called" now score on content words, not subject
  - Prompt updated in all three locations (llm.js, claude.js, mistral.js): added deduplication rule — models told never to return the same person twice with different name formats
  - Separate `claudeEndpoint` / `mistralEndpoint` options — each provider routes independently
- **`background.js`** — verification metadata passed through to records
  - `_verification`, `_claude_claim`, `_mistral_claim`, `_similarity` now on each record
  - `memberJobs` passes `claudeEndpoint` and `mistralEndpoint` separately
- **`content.js`** — verified/ambiguous claim UI
  - `dual_verified`: green left border (3px), teal background tint, `✓ Verified Statement` label, green card top border
  - `ambiguous`: amber border, `⚠ Models disagreed` label, Claude and Mistral claims shown separately
  - `single_model`: plain italic claim, no badge
  - Detail panel mirrors same treatment with `✓ DUAL VERIFIED — CLAUDE & MISTRAL AGREE`
- **`manifest.json`** — added `liars-ledger.onrender.com` to `host_permissions`; removed direct `api.anthropic.com` and `api.mistral.ai` (now proxied)
- **DNS** — `api.liarsledger.com` CNAME → `liars-ledger.onrender.com` (DreamHost, propagating)

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

- **`src/api.js`** — two-pass bill relevance matching
  - Pass 1: `billMatchesTopic()` keyword category matching (19 topic buckets)
  - Pass 2: direct title substring match against LLM `search_terms`
  - Untitled amendments filtered out; bills deduped by URL/number
  - Keyword search capped at 6 most specific terms per member
- **`background.js`** — `_llm_search_terms` passed through to `api.js`
- **`src/api.js`** — `resolveGovTrackId` URL fixed to `unitedstates.github.io`
- **`src/llm.js`** — `anthropic-dangerous-direct-browser-access: true` header added

---

## [0.8.0] - 2026-05-17

### Dual-model LLM claim extraction — live

- **`src/llm.js`** — Claude + Mistral in parallel, Jaccard similarity merge
- **`src/lookup.js`** — nickname resolution (40+ overrides)
- **`src/api.js`** — GovTrack roll-call vote integration
- **UI** — restyled to match liarsledger.com (Oswald + IBM Plex Mono, navy/gold/red)

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

### [0.13.0] — Chrome Web Store launch
- Store listing: screenshots, short/long description, category
- Developer account ($5 one-time)
- Install Extension links updated across liarsledger.com

### [0.14.0] — Freemium tier management
- Anonymous free tier: 5 scans/day via per-install token
- Pro tier: unlimited scans, Square subscription, JWT auth token
- Popup shows scan count remaining for free users
- Account creation via liarsledger.com (not in extension)
- Backend enforces limits; extension degrades gracefully on 429

### [0.15.0] — API cost optimization
- Prompt caching on Claude extraction and verification calls — static instruction prefix cached, only article text varies
- Usage monitoring via Claude Console — cost per endpoint tracking
- Evaluate Mistral prompt caching equivalent

### [0.16.0] — GovTrack extended data
- Ideology scores (0.0 = most liberal, 1.0 = most conservative)
- Missed vote rates and committee assignments
- Historical roll-call votes back to 1990s

### [0.17.0] — Creator shareable graphics
- One-click image card: politician name, claim, voting record
- Twitter/X (1200×628) and Instagram (1080×1080) formats
- Canvas API, no server render, Creator tier feature

### [Future] — Performance + bundling
- esbuild or Rollup bundler — combine all `importScripts` files into single bundle
- Minification and tree-shaking for smaller extension size
- Service worker startup time optimization
- Evaluate dictionary compression (gzip or binary format)

### [Future] — TypeScript migration
- Convert extension source (`src/*.js`, `background.js`, `content.js`) to TypeScript
- Add interfaces for dictionary, record, verdict, and LLM response shapes
- Type-safe message passing between popup, content script, and service worker
- Convert server (`server/`) to TypeScript with strict mode
- Build step via `tsc` or `esbuild` with type checking
- Goal: learning experience + catch bugs at compile time (e.g., missing `bioguide_id`)

### [Future] — Firefox / Safari
- Firefox: `browser.*` shim in place; publish to AMO
- Safari: Xcode + Apple Developer account required

### [Future] — State legislators via OpenStates
- Goal: empower voters to see what their politicians at *any level* are saying vs. voting
- Phase 1: add governors + all 50 state legislatures via [OpenStates API](https://openstates.org/)
  - New `server/providers/openstates.js` proxy (same pattern as `govtrack.js`)
  - State bill search and roll-call votes via OpenStates
  - Expand `lookup.js` name resolution to cover state legislators
  - Loosen LLM extraction prompt — include governors and state legislators by name
- Phase 2: local officials (mayors, city councils)
  - No consolidated API exists yet — likely manual curation or crowd-sourced data
  - Structured voting records at municipal level are largely unavailable
- No `manifest.json` host permission changes needed — all calls go through the existing proxy