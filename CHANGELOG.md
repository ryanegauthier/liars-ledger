# Changelog

## [0.8.0] - 2026-05-17

### LLM claim extraction — live in production path

- **`src/llm.js`** — unified provider module, replaces direct Ollama dependency for cloud inference
  - `extractArticleAnalysisViaMistral()` — Mistral Small latest (~$0.00024/scan)
  - `extractArticleAnalysisViaClaude()` — Claude Haiku 4.5 (~$0.00075/scan)
  - `extractArticleAnalysisDualVerified()` — runs both in parallel, compares claims per politician via Jaccard similarity, returns `dual_verified` / `single_model` / `ambiguous` verification status per figure
  - `extractArticleAnalysis()` — unified entry point routed by `CONFIG.LLM_PROVIDER`
  - Merged `search_terms` from both models on agreement — more signal for Congress.gov matching
  - `_meta` block on every result: provider, models used, verified/ambiguous/single_model counts
- **`src/lookup.js`** — nickname resolution for LLM-returned names
  - `FULL_NAME_OVERRIDES` map: Chuck Schumer → Charles Schumer, Mitch McConnell → Addison McConnell, Ted Cruz → Rafael Cruz, Bernie Sanders → Bernard Sanders, and 40+ others
  - `NICKNAME_FIRST` map: first-name substitution fallback for uncovered cases
  - Resolution order: exact → strip title → nickname map → last-name-only → non-member check
  - Confirmed working: `Sen. Chuck Schumer` → `Charles E. Schumer` (resolved, S000148)
- **`src/api.js`** — GovTrack roll-call vote integration
  - Replaced broken Congress.gov `senate-vote`/`house-vote` beta endpoints (returning 404 for 119th Congress — not yet available)
  - `resolveGovTrackId()` — fetches `unitedstates/congress-legislators` JSON via GitHub Pages, builds bioguide→GovTrack ID map, session-cached after first fetch
  - `findMemberRollCallVotesOnTopics()` — fetches recent votes per person from GovTrack `vote_voter` endpoint, filters by topic keyword match, shapes to existing `rollCallVotes` format
  - Confirmed working: 8 roll-call hits each for Merkley, Schumer, Thune
- **`src/config.example.js`** — updated with `LLM_PROVIDER`, `CLAUDE_API_KEY`, `MISTRAL_API_KEY`, `CLAUDE_API_ENDPOINT`, `MISTRAL_API_ENDPOINT` (proxy swap), `LLM_TIMEOUT_MS`
- **`manifest.json`** — added `api.anthropic.com`, `api.mistral.ai`, `unitedstates.github.io`, `raw.githubusercontent.com` to `host_permissions`; bumped version to `0.8.0`
- **UI** — popup and content.js sidebar restyled to match liarsledger.com design system
  - Fonts: Oswald (brand/headings) + IBM Plex Mono (data/mono)
  - Colors: navy `#121f44`, gold `#c8a96e`, alert red `#c73a25`, no border-radius
  - Popup: ticker strip, ledger cards with bill IDs and links, live elapsed timer during AI analysis, final-check-on-timeout fix
  - Bottom bar: `border-top: 2px solid #c8a96e`, horizontal card scroll, expandable detail panel, teal pulse dot in footer

### Cost reference (per scan, dev tier)
| Provider | Model | Total |
|---|---|---|
| Mistral only | mistral-small-latest | ~$0.00024 |
| Claude only | claude-haiku-4-5 | ~$0.00075 |
| **Dual (production)** | Both | **~$0.001** |

1000 scans ≈ $1.00.

---

## [0.7.0] - 2026-05-11

- **Ollama article analysis** — single `extractArticleAnalysisViaOllama` call returns `article_summary`, `main_topics`, and `figures` (lookup names, claims, bill search terms); scan can run on Ollama alone when regex finds no names (`src/ollama.js`, `background.js`).
- **Congress.gov roll-call votes** — beta `house-vote` / `senate-vote` list + member endpoints; topic-matched votes attached per member as `rollCallVotes` (`src/api.js`). (Note: these endpoints return 404 for 119th Congress and were replaced in 0.8.0 by GovTrack.)
- **Popup / content** — longer analyze timeout when Ollama is configured; `startResultsPoll` so the sidebar updates without regex names; larger article excerpt to background; sidebar shows summary + roll-call block.
- **Docs** — `docs/PRODUCTION-LLM.md`: milestone schedule for Anthropic Claude + Mistral via backend proxy before public launch.

## [0.6.0] - Step 6 - Sidebar UI
- Inline bottom bar sidebar injected by content script
- Avoids CSP/Manifest V3 script injection issues by keeping sidebar inline
- Dark-themed fixed bar slides up from bottom of page on results
- Politician cards showing name, party, state, chamber
- Bill count indicator and expandable bill detail panel on card click
- Bill titles, introduced dates, links to Congress.gov website
- Greyed-out cards for notMembers and notFound
- X button closes and removes bar

## [0.4.1] - Logger
- src/logger.js — in-memory debug log stored in session storage
- Popup debug log panel with Copy and Clear buttons
- Auto-refreshes every second while popup is open
- Content script inline logger writes to same session key
- All pipeline stages instrumented with info/warn/error entries

## [0.4.0] - Step 4 - Congress.gov API Integration
- src/api.js — sponsored and cosponsored legislation lookup per member
- src/keywords.js — topic keyword extraction from article text
- 19 policy topic patterns mapped to Congress.gov search terms
- Session caching via chrome.storage.session
- Store-and-poll pattern for background → content script results

## [0.3.0] - Step 3 - Politician Dictionary
- build-dictionary.js fetches all 536 current members of the 119th Congress
- 3606 lookup keys including aliases, nicknames, middle-initial variants
- src/lookup.js resolves names to dictionary entries
- Three resolution categories: resolved, notMembers, notFound

## [0.2.0] - Step 2 - Article Detection + Name Extraction
- Detect article body using priority selector list
- Regex extraction of politician names with titles and party labels
- Deduplication via Set

## [0.1.0] - Step 1 - Skeleton
- Manifest V3 setup with correct permissions
- Background service worker with message listener
- Content script with ping/pong to confirm wiring
- Popup with on/off toggle (state persists via storage)
- Cross-browser shim (window.browser || window.chrome)

---

## Planned

### [0.9.0] — Bill matching + UI polish

**Bill matching fix (core):**
- `billMatchesTopic()` in `topic-match.js` only matches against 19 predefined
  keyword categories — it ignores the LLM's per-figure `search_terms` entirely
- Fix: in `lookupPoliticianOnTopics`, after the topic filter, add a second pass
  that does direct title substring match against the LLM search_terms
- Example: Mistral returns `"voting rights"` for Cory Booker but
  `billMatchesTopic(bill, "elections")` misses bills titled
  "Voting Rights Act Advancement Act" because "voting rights" isn't in the
  `elections` keyword list
- Result: sponsored/cosponsored bills currently showing 0 matches on topical
  articles even when relevant legislation exists

**UI polish:**
- Verify roll-call vote data renders correctly in expanded sidebar cards
- Show vote position (Yea/Nay/Not Voting) prominently on each vote row
- Filter amendments without titles from bill cards
- Dedup sponsored/cosponsored bills shown per card

### [0.10.0] — Backend proxy (production hardening)
- Node.js/Express proxy server holds all API keys (Claude, Mistral, Congress.gov)
- Extension calls `https://api.liarsledger.com/v1/analyze` — one endpoint
- Proxy routes to Claude + Mistral in parallel, returns merged dual-verified result
- Removes `api.anthropic.com` and `api.mistral.ai` from manifest `host_permissions`
- Rate limiting and usage tracking per user/IP at proxy layer
- Deploy target: Railway, Fly.io, or Render

### [0.11.0] — Freemium tier management
- Anonymous free tier: 5 scans/day via session fingerprint (no account required)
- Pro tier: unlimited scans, Stripe subscription, JWT auth token in extension storage
- Popup shows scan count remaining for free users
- Backend enforces tier limits; extension degrades gracefully on 429
- Account creation via liarsledger.com — not in extension (avoids store policy issues)

### [0.12.0] — VoteSmart integration
- Awaiting educational API license from VoteSmart
- Interest group ratings (NRA, ACLU, Chamber of Commerce, etc.)
- Historical key votes beyond 119th Congress
- Issue positions and candidate questionnaire responses
- VoteSmart candidate IDs added to politician dictionary via `build-dictionary.js`

### [0.13.0] — GovTrack extended data
- Ideology scores (0.0 = most liberal, 1.0 = most conservative)
- Missed vote rates and committee assignments
- Historical roll-call votes back to 1990s

### [0.14.0] — Creator shareable graphics
- One-click shareable image card: politician name, claim, voting record
- Formatted for Twitter/X (1200×628) and Instagram (1080×1080)
- Generated client-side via Canvas API — no server render needed
- Creator tier feature (Pro subscribers + above)

### [Future] — Firefox / Safari
- Firefox: `browser.*` shim already in place; test and publish to AMO
- Safari: requires Xcode + Apple Developer account; lower priority

### [Future] — Privacy policy + Chrome Web Store listing
- Privacy policy required before public listing
- Data handling: article text sent to Claude/Mistral APIs (no PII, no storage)
- Chrome Web Store listing: screenshots, description, category (Productivity / News)