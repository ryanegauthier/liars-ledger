# Changelog

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
- Regex extraction of politician names with titles
- Deduplication via Set
- Scan triggered by popup button only
- Popup updated with Scan This Page button and status feedback

## Planned

### Step 3 - Politician Dictionary
- Bundled JSON mapping names/nicknames to IDs for ProPublica, VoteSmart, GovTrack

### Step 4 - ProPublica Integration
- Batch requests — send all detected names in a single API call
- Session caching — store results in chrome.storage.session

### Step 5 - VoteSmart Integration
- Same batching and session caching pattern as ProPublica

### Step 6 - Sidebar UI
- Neutral confirm/contradict display (🟢 🔴 ⚪)
- No editorializing — show the record, let the user decide

### Step 7 - GovTrack Integration
- Deeper vote history and ideology scores
- Same batching and caching pattern

## Business Model (Planned - Post Step 7)

### Architecture Shift
Once the local version is complete through Step 7, a backend layer will be added:

  Browser Extension → Your Backend → VoteSmart/ProPublica/GovTrack APIs

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
Steps 2-7 hit APIs directly from the browser (local/personal use).
The backend swap will be minimal — just changing API endpoint URLs
to point to our own backend instead of third parties directly.