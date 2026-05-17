# Changelog

## [0.9.0] - 2026-05-17

### Bill matching fix + GovTrack URL fix

- **`src/api.js`** — two-pass bill relevance matching in `lookupPoliticianOnTopics`
  - **Pass 1** (existing): `billMatchesTopic()` keyword category matching against 19 predefined topic buckets
  - **Pass 2** (new): direct title substring match against the LLM's per-figure `search_terms` — fixes the core issue where specific terms like `"voting rights"` or `"budget reconciliation"` were being ignored because they didn't map to a category keyword
  - Untitled amendments now filtered out of bill cards (no title = no useful display)
  - Bills deduped by URL/number across sponsored and cosponsored — no more duplicates
  - Keyword search queries capped at 6 most specific terms per member to reduce API call count
  - `_llm_search_terms` passed from `background.js` through to each member object
- **`background.js`** — `memberJobs` now includes `_llm_search_terms` from the matched LLM figure so `api.js` can use them for pass-2 matching
- **`src/api.js`** — `resolveGovTrackId` URL corrected to `unitedstates.github.io` (was incorrectly pointing to `raw.githubusercontent.com` which returns 404)
- **`src/llm.js`** — added `anthropic-dangerous-direct-browser-access: true` header required for Claude API calls from browser/extension context (was returning 401 CORS error)

### Results before/after on same article (Fox News ballroom article, 7 senators)
| Senator | Before | After |
|---|---|---|
| Jeff Merkley | 0 sponsored, 0 cosponsored | 1 sponsored, 8 cosponsored |
| Charles E. Schumer | 0 sponsored, 0 cosponsored | 2 sponsored, 2 cosponsored |
| Rick Scott | 0 sponsored, 0 cosponsored | 3 sponsored, 0 cosponsored |
| Todd Young | 0 sponsored, 0 cosponsored | 3 sponsored, 0 cosponsored |
| James Lankford | 1 sponsored, 1 cosponsored | 1 sponsored, 1 cosponsored |

---

## [0.8.0] - 2026-05-17

### Dual-model LLM claim extraction — live

- **`src/llm.js`** — unified provider module replacing direct Ollama dependency
  - `extractArticleAnalysisViaMistral()` — Mistral Small latest (~$0.00024/scan)
  - `extractArticleAnalysisViaClaude()` — Claude Haiku 4.5 (~$0.00075/scan)
  - `extractArticleAnalysisDualVerified()` — runs both in parallel, compares claims via Jaccard similarity, returns `dual_verified` / `single_model` / `ambiguous` per figure
  - `extractArticleAnalysis()` — unified entry point routed by `CONFIG.LLM_PROVIDER`
  - Merged `search_terms` from both models on agreement
  - `_meta` block: provider, models, verified/ambiguous/single_model counts
- **`src/lookup.js`** — nickname resolution for LLM-returned names
  - `FULL_NAME_OVERRIDES`: Chuck Schumer, Mitch McConnell, Ted Cruz, Bernie Sanders, 40+ others
  - `NICKNAME_FIRST`: first-name substitution fallback
  - Resolution order: exact → strip title → nickname map → last-name-only → non-member check
- **`src/api.js`** — GovTrack roll-call vote integration
  - Replaced broken Congress.gov `senate-vote`/`house-vote` beta endpoints (404 for 119th Congress)
  - `resolveGovTrackId()` — fetches `unitedstates/congress-legislators` JSON, session-cached
  - `findMemberRollCallVotesOnTopics()` — topic-filtered votes from GovTrack
- **`src/config.example.js`** — `LLM_PROVIDER`, `CLAUDE_API_KEY`, `MISTRAL_API_KEY`, proxy endpoints, `LLM_TIMEOUT_MS`
- **`manifest.json`** — added `api.anthropic.com`, `api.mistral.ai`, `unitedstates.github.io`, `raw.githubusercontent.com` to `host_permissions`
- **UI** — popup and sidebar restyled to match liarsledger.com (Oswald + IBM Plex Mono, navy/gold/red)

### Cost reference (per scan)
| Mode | Cost |
|---|---|
| Mistral only | ~$0.00024 |
| Claude only | ~$0.00075 |
| Dual (production) | ~$0.001 |

---

## [0.7.0] - 2026-05-11

- **Ollama article analysis** — `extractArticleAnalysisViaOllama` returns `article_summary`, `main_topics`, `figures` with claims and bill search terms
- **Congress.gov roll-call votes** — beta `house-vote`/`senate-vote` endpoints (replaced in 0.8.0 by GovTrack due to 404s on 119th Congress)
- **Popup/content** — longer analyze timeout, `startResultsPoll`, larger article excerpt, sidebar shows summary + roll-call block

## [0.6.0] - Step 6 - Sidebar UI
- Inline bottom bar sidebar injected by content script
- Politician cards: name, party, state, chamber, bill count indicator
- Expandable bill detail panel on card click with congress.gov links
- Greyed-out cards for notMembers and notFound

## [0.4.1] - Logger
- Session storage debug log, popup panel with Copy/Clear, auto-refresh

## [0.4.0] - Step 4 - Congress.gov API Integration
- Sponsored/cosponsored legislation lookup, topic keyword extraction
- Session caching, store-and-poll pattern

## [0.3.0] - Step 3 - Politician Dictionary
- 536 members, 3606 lookup keys, three resolution categories

## [0.2.0] - Step 2 - Article Detection + Name Extraction
- Article body detection, regex politician name extraction

## [0.1.0] - Step 1 - Skeleton
- Manifest V3, service worker, content script, popup toggle, cross-browser shim

---

## Planned

### [0.10.0] — Backend proxy (production hardening)
- Node.js/Express proxy holds all API keys (Claude, Mistral, Congress.gov)
- Extension calls `https://api.liarsledger.com/v1/analyze` — one endpoint
- Proxy routes to Claude + Mistral in parallel, returns dual-verified result
- Removes direct API keys from manifest `host_permissions`
- Rate limiting and usage tracking per user/IP
- Deploy target: Railway, Fly.io, or Render

### [0.11.0] — Freemium tier management
- Anonymous free tier: 5 scans/day via session fingerprint
- Pro tier: unlimited scans, Stripe subscription, JWT auth token
- Popup shows scan count remaining for free users
- Account creation via liarsledger.com

### [0.12.0] — VoteSmart integration
- Awaiting educational API license
- Interest group ratings (NRA, ACLU, Chamber of Commerce, etc.)
- Issue positions and candidate questionnaire responses
- Historical key votes beyond 119th Congress

### [0.13.0] — GovTrack extended data
- Ideology scores, missed vote rates, committee assignments
- Historical roll-call votes back to 1990s

### [0.14.0] — Creator shareable graphics
- One-click image card: politician name, claim, voting record
- Twitter/X (1200×628) and Instagram (1080×1080) formats
- Canvas API, no server render, Creator tier feature

### [Future] — Firefox / Safari
- Firefox: `browser.*` shim in place; publish to AMO
- Safari: Xcode + Apple Developer account required

### [Future] — Privacy policy + Chrome Web Store listing
- Privacy policy at liarsledger.com/privacy
- Chrome Web Store: Productivity / News category