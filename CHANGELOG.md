# Changelog

## [0.1.0] - Step 1 - Skeleton
- Manifest V3 setup with correct permissions
- Background service worker with message listener
- Content script with ping/pong to confirm wiring
- Popup with on/off toggle (state persists via storage)
- Cross-browser shim (window.browser || window.chrome)
- Placeholder icons
- README, .gitignore, config.example.js

## Planned

### Step 2 - Article Detection + Name Extraction
- Detect article body on page
- Regex extraction of politician names
- Deduplicate names before passing to background worker

### Step 3 - Politician Dictionary
- Bundled JSON mapping names/nicknames to IDs for ProPublica, VoteSmart, GovTrack

### Step 4 - ProPublica Integration
- Batch requests — send all detected politician names in a single API call
  rather than one call per name to stay within free tier limits
- Session caching — store results in chrome.storage.session so repeat visits
  or scrolling on the same page don't trigger redundant API calls.
  Clears automatically when browser closes.

### Step 5 - VoteSmart Integration
- Same batching and session caching pattern as ProPublica

### Step 6 - Sidebar UI
- Neutral confirm/contradict display (🟢 🔴 ⚪)
- No editorializing — show the record, let the user decide

### Step 7 - GovTrack Integration
- Deeper vote history and ideology scores
- Same batching and caching pattern