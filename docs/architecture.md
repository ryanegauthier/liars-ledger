---
title: Architecture
nav_order: 2
---

# Architecture

## Overview

```
Browser Extension (Chrome)
├── content.js          - article scanning, sidebar UI
├── background.js       - service worker, pipeline orchestration
├── popup.js            - scan trigger, popup UI
└── src/
    ├── llm.js          - dual-model AI extraction
    ├── api.js          - Congress.gov + GovTrack lookups
    ├── votesmart.js    - VoteSmart client (via proxy)
    ├── lookup.js       - politician name resolution
    ├── keywords.js     - topic keyword extraction
    └── topic-match.js  - bill relevance matching

Backend Proxy (Node.js / Render)
└── server/
    ├── index.js                  - Express, CORS, rate limiting
    └── providers/
        ├── claude.js             - Anthropic Claude extraction
        ├── mistral.js            - Mistral extraction
        ├── _shared.js            - shared prompt + parser (single source of truth)
        ├── congress.js           - Congress.gov proxy
        └── votesmart.js          - VoteSmart JWT auth + proxy
```

## Pipeline

When you click **Scan This Page**:

1. **`content.js`** extracts article text and politician names via regex
2. **`popup.js`** sends an `analyze` message to the service worker
3. **`background.js`** calls `extractArticleAnalysis()` in `src/llm.js`
4. **`src/llm.js`** sends `{ articleText }` to two proxy endpoints in parallel:
   - `POST api.liarsledger.com/api/claude/extract`
   - `POST api.liarsledger.com/api/mistral/extract`
5. Both models return `{ summary, main_topics, figures[] }` - claims are compared via Jaccard similarity
6. **`background.js`** resolves politician names against a 3,606-key dictionary
7. **`src/api.js`** fetches sponsored/cosponsored legislation and GovTrack roll-call votes via `api.liarsledger.com/api/congress/*`
8. **`src/votesmart.js`** fetches interest group ratings and vote history via `api.liarsledger.com/api/votesmart/*`
9. Results are stored in `browser.storage.session` and displayed in the sidebar

## Key design decisions

**Why a backend proxy?**
All API keys (Claude, Mistral, Congress.gov, VoteSmart) live server-side. The extension ships with zero secrets. This also enables rate limiting and future freemium tier enforcement.

**Why two AI models?**
Two independent models from different companies with different training data reduces systematic bias. Agreement = higher confidence. Disagreement = both interpretations surfaced.

**Why GovTrack instead of Congress.gov for votes?**
The Congress.gov `senate-vote` and `house-vote` endpoints return 404 for the 119th Congress - they are in beta and not yet available. GovTrack provides complete roll-call vote history at no cost.

**Why session storage for caching?**
`browser.storage.session` clears when the browser closes, preventing stale legislative data from persisting. Cache hits are logged in the debug panel.
