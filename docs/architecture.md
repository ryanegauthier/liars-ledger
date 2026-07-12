---
title: Architecture
nav_order: 2
---

# Architecture

## Overview

```
Browser Extension (Chrome MV3)
├── content.js              - article text extraction, sidebar UI injection
├── background.js           - service worker, pipeline orchestration
├── popup.js                - scan trigger, popup UI, tier/scan-count display
├── report.js               - standalone full-report tab
└── src/
    ├── llm.js              - dual-model AI extraction + Jaccard merge
    ├── api.js              - Congress.gov + GovTrack lookups, session cache
    ├── votesmart.js        - VoteSmart client (via proxy), paginated ID resolution
    ├── verify.js           - Pro claim-vs-record verdict (client side)
    ├── lookup.js           - politician name resolution (3,606-key dictionary)
    ├── token.js            - anonymous UUID auth, tier sync, scan-count display
    ├── keywords.js         - fallback topic keyword extraction
    ├── topic-match.js      - bill relevance matching
    └── cache-maintenance.js - session storage eviction + safeSessionSet

Backend Proxy (Node.js / Render)
└── server/
    ├── index.js                  - Express, CORS, rate limiting, route registration
    ├── middleware/
    │   └── auth.js               - requireToken, requirePro, requireScanToken, countScan
    └── providers/
        ├── claude.js             - Anthropic Claude extraction
        ├── mistral.js            - Mistral extraction
        ├── _shared.js            - shared prompt + parser (single source of truth)
        ├── congress.js           - Congress.gov proxy
        ├── govtrack.js           - GovTrack proxy
        ├── votesmart.js          - VoteSmart JWT auth + proxy
        ├── verify.js             - Pro claim-vs-record verification (Claude)
        ├── square.js             - Square subscription webhooks + checkout
        └── store.js              - Upstash Redis: tokens, scans, tiers, Square mappings
```

## Pipeline

When you click **Scan This Page**:

1. **`content.js`** extracts article text and runs it against the politician dictionary via regex. Both are sent to the popup.
2. **`popup.js`** sends an `analyze` message to the background service worker and begins polling `browser.storage.session` every 500ms.
3. **`background.js`** hits `GET /api/scan-status` to get a fresh tier and scan count from Redis (falls back to cached value on failure).
4. **`background.js`** calls `POST /api/scan/start`, which atomically reserves a scan slot in Redis and returns two single-use tokens:
   - `scanToken` - required by the extraction endpoints; consumed on first use
   - `commitToken` - used later to finalize the scan count only if data was retrieved
   - Returns `429` if the daily limit is already hit; pipeline aborts here before any AI call.
5. **`src/llm.js`** fires both extraction calls in parallel via `Promise.allSettled`:
   - `POST /api/claude/extract`
   - `POST /api/mistral/extract`
   - Both receive the same `scanToken`. Claims are merged via Jaccard similarity (threshold 0.65). See [Dual-Model Verification](dual-model-verification).
6. **`background.js`** resolves LLM-extracted politician names against the 3,606-key dictionary via `resolveAll()`, returning structured member objects with `bioguide_id`, chamber, party, state.
7. **`src/api.js`** fans out parallel fetches per member:
   - Congress.gov: sponsored + cosponsored legislation (up to 100 bills each)
   - GovTrack: roll-call vote history (last 50 votes, topic-filtered)
   - All responses cached in `browser.storage.session` under `api:*` keys
8. **`src/votesmart.js`** fetches interest group ratings and vote history per member via paginated VoteSmart API calls. Responses cached under `vs:*` keys.
9. **Scan commit decision**: if every government API call errored for every member, `commitToken` is discarded and the reservation expires. If any source responded, `POST /api/scan/commit` is called.
10. **Pro only**: `src/verify.js` sends each `{ claim, member, record }` to `POST /api/verify-claim`. Claude reads the actual legislative record and returns a verdict: `supported / contradicted / mixed / insufficient`.
11. **Tier gating**: Pro-only fields (`claim`, `verdict`, `verdict_explanation`, verification metadata) are stripped from results before storage for free-tier users. The real security boundary is server-side; this is a defensive fallback.
12. Results are written to `browser.storage.session`. The popup's poll picks them up and closes. The content script renders the sidebar.

## Freemium system

Every install gets an anonymous UUID token stored in `chrome.storage.sync`. No account or email is required.

**Free tier** daily scan limit scales dynamically with `global:user_count` in Redis:

| Registered users | Free scans/day |
|---|---|
| 0–499 | 30 |
| 500–999 | 13 |
| 1000–1999 | 6 |
| 2000–2499 | 3 |
| 2500–4999 | 2 |
| 5000+ | 1 |

**Pro tier** ($5/month via Square): flat 100 scans/day from a separate pool. Unlocks AI article summary, extracted claim text, and claim-vs-record verdicts.

Subscriptions are managed via Square webhooks (`subscription.created/updated`, `invoice.payment_made`, `invoice.scheduled_charge_failed`). Tier upgrades and downgrades are written directly to Redis.

## Session storage and cache management

`api.js` and `votesmart.js` cache all government API responses in `browser.storage.session` to avoid redundant fetches within a browser session. The 10MB quota can be exhausted by heavy scans (many politicians per article).

`cache-maintenance.js` manages this with two triggers:
- **Usage-based**: if storage is above 50% of quota when a scan starts, evictable keys are cleared before any new writes
- **Count-based**: every 10 scans regardless of usage

`safeSessionSet()` (exported from `cache-maintenance.js`, called by both `cacheSet` in `api.js` and `vsSet` in `votesmart.js`) adds a second layer: it checks usage before each individual write and evicts if needed, with a retry-after-eviction path on quota errors.

Evictable keys: all `api:*` and `vs:*` prefixed entries (request cache data). Preserved: `ll_results` (last scan result), `vs:id:*` (VoteSmart candidateId resolution cache - small but expensive to re-fetch).

## Key design decisions

**Why a backend proxy?**
All API keys (Claude, Mistral, Congress.gov, VoteSmart) live server-side. The extension ships with zero secrets. The proxy also handles rate limiting, anonymous token auth, scan counting, tier enforcement, and Square webhook processing.

**Why two AI models?**
Two independent models from different companies with different training data reduces systematic bias. Agreement (Jaccard ≥ 0.65) = higher confidence. Disagreement = both interpretations surfaced rather than arbitrarily picking one.

**Why GovTrack instead of Congress.gov for votes?**
The Congress.gov `senate-vote` and `house-vote` endpoints return 404 for the 119th Congress - they are in beta and not yet available. GovTrack provides complete roll-call vote history at no cost.

**Why anonymous tokens instead of accounts?**
No account means no email, no password, no PII. The token is the credential. This makes the privacy story simple: there is nothing to breach except an anonymous UUID and a scan count.

**Why two-phase scan counting?**
Scans are reserved at start and committed only when at least one government data source responds. If all APIs time out, the reservation expires and the user keeps their scan. This also prevents scan-limit bypass via direct calls to extraction endpoints - the `scanToken` is single-use and required.
