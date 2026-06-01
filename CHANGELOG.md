# Changelog

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

### [0.12.0] — Chrome Web Store launch
- Store listing: screenshots, short/long description, category
- Developer account ($5 one-time)
- Install Extension links updated across liarsledger.com

### [0.13.0] — Freemium tier management
- Anonymous free tier: 5 scans/day via per-install token
- Pro tier: unlimited scans, Square subscription, JWT auth token
- Popup shows scan count remaining for free users
- Account creation via liarsledger.com (not in extension)
- Backend enforces limits; extension degrades gracefully on 429

### [0.14.0] — GovTrack extended data
- Ideology scores (0.0 = most liberal, 1.0 = most conservative)
- Missed vote rates and committee assignments
- Historical roll-call votes back to 1990s

### [0.15.0] — Creator shareable graphics
- One-click image card: politician name, claim, voting record
- Twitter/X (1200×628) and Instagram (1080×1080) formats
- Canvas API, no server render, Creator tier feature

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