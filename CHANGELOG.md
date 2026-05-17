# Changelog

## [0.7.0] - 2026-05-11

- **Ollama article analysis** — single `extractArticleAnalysisViaOllama` call returns `article_summary`, `main_topics`, and `figures` (lookup names, claims, bill search terms); scan can run on Ollama alone when regex finds no names (`src/ollama.js`, `background.js`).
- **Congress.gov roll-call votes** — beta `house-vote` / `senate-vote` list + member endpoints; topic-matched votes attached per member as `rollCallVotes` (`src/api.js`).
- **Popup / content** — longer analyze timeout when Ollama is configured; `startResultsPoll` so the sidebar updates without regex names; larger article excerpt to background; sidebar shows summary + roll-call block (`popup.js`, `content.js`).
- **Docs** — `docs/PRODUCTION-LLM.md`: milestone schedule (T‑minus weeks) for Anthropic Claude + Minstrel via backend proxy before public launch.

## [0.1.0] - Step 1 - Skeleton
- Manifest V3 setup with correct permissions
- Background service worker with message listener
- Content script with ping/pong to confirm wiring
- Popup with on/off toggle (state persists via storage)
- Cross-browser shim (window.browser || window.chrome)
- Placeholder icons
- README, .gitignore, config.example.js

## [0.2.0] - Step 2 - Article Detection + Name Extraction
- Detect article body using priority selector list
- Site-specific selectors for CNN, NYT, Reuters, Guardian, Fox
- Regex extraction of politician names with titles and party labels
- Negative lookahead to prevent "Republican Gov" false matches
- Deduplication via Set
- Scan triggered by popup button only
- Popup updated with Scan This Page button and status feedback

## [0.3.0] - Step 3 - Politician Dictionary
- Congress.gov API replaces ProPublica (which shut down new signups)
- build-dictionary.js fetches all 536 current members of the 119th Congress
- 3606 lookup keys including aliases, nicknames, middle-initial variants
- src/lookup.js resolves names to dictionary entries
- Three resolution categories: resolved, notMembers, notFound
- Party-label stripping in lookup (Democrat/Republican/Independent prefix)
- src/config.example.js updated for Congress.gov key

## [0.4.0] - Step 4 - Congress.gov API Integration
- src/api.js — sponsored and cosponsored legislation lookup per member
- src/keywords.js — topic keyword extraction from article text
- 19 policy topic patterns mapped to Congress.gov search terms
- Title-based bill matching (policyArea.name returns null from API)
- Session caching via chrome.storage.session — cache hits confirmed working
- Batch parallel fetches for sponsored + cosponsored per member
- Store-and-poll pattern for background → content script results
  (avoids message channel timeout on slow API calls)
- background.js getResults handler for content script polling

## [0.4.1] - Logger
- src/logger.js — in-memory debug log stored in session storage
- Popup debug log panel with Copy and Clear buttons
- Auto-refreshes every second while popup is open
- Content script inline logger (clog) writes to same session key
- All pipeline stages instrumented with info/warn/error entries

## [0.6.0] - Step 6 - Sidebar UI
- Inline bottom bar sidebar injected by content script
- Avoids CSP/Manifest V3 script injection issues by keeping sidebar inline
- Dark-themed fixed bar slides up from bottom of page on results
- Politician cards showing name, party, state, chamber
- 🟢 bill count indicator or ⚪ no bills found
- Expandable bill detail panel on card click
- Bill titles, introduced dates, links to Congress.gov website
  (not API — constructs legislationUrl from bill type + number)
- Greyed-out cards for notMembers and notFound
- X button closes and removes bar
- Results passed from background via getResults message handler
- apiKey passed through results for URL construction

## Planned

### LLM production (Anthropic / Minstrel)
- **Dev (now):** Ollama on Tailscale or localhost; keys in gitignored `src/config.js`.
- **Production:** Claude (Anthropic) and/or Minstrel **only through a backend proxy** — extension calls your HTTPS API; proxy holds provider keys and normalizes responses to the same JSON contract as `src/ollama.js`. See **`docs/PRODUCTION-LLM.md`** for T‑minus milestone dates to assign against your launch week.
- **Implementation:** Provider adapter in code (e.g. `LLM_PROVIDER` + proxy URL) — not a config-only swap; track in repo when M3 in that doc is scheduled.

### Claim & topic extraction (partially done)
- Article-level summary + figures + topics via Ollama when configured; per-member claims merged into sidebar.
- Remaining: hosted models, failover, and quotas entirely server-side for store builds.

### VoteSmart Integration
- Awaiting educational API license
- Interest group ratings, historical key votes, issue positions
- Will add VoteSmart candidate IDs to politician dictionary

### GovTrack Integration
- Ideology scores, miss rates, historical roll call votes
- Add after VoteSmart if gaps remain

### Backend + Freemium (Post-build)
- Backend proxy: holds API keys, counts usage, checks subscription tier
- Extension → Backend → Congress.gov / VoteSmart / GovTrack
- Freemium tiers: Free (limited scans), Pro (unlimited), Creator (graphics)
- Creator shareable cards for Twitter/Instagram
- Stripe for subscription management
- Privacy policy required before public release

## Business Model (Planned - Post Step 7)

### Architecture Shift
Once the local version is complete, a backend layer will be added:

  Browser Extension → Your Backend → Congress.gov / VoteSmart / GovTrack

The backend becomes the gatekeeper — holds API keys, counts usage per user,
checks subscription tier, and proxies requests to data sources.

### Freemium Tiers
- Free: Limited scans per day, basic vote data, no account needed
- Pro: Unlimited scans, full vote history, all 3 data sources
- Creator: Graphics export, shareable cards, social embeds

### Creator/Influencer Graphics
One-click shareable image cards showing politician name, claim, and voting
record formatted for Twitter/Instagram. Key monetization driver.

### Payment
Stripe for subscription management.

### Note on Current Build
Steps 2-6 hit APIs directly from the browser (local/personal use).
The backend swap will be minimal — just changing API endpoint URLs
to point to our own backend instead of third parties directly.