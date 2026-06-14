# Security Policy

## Current Status
Liar's Ledger v0.12.1 has completed its pre-release security checklist and is published on the Chrome Web Store.

---

## Architecture

### API Keys
All API keys (Congress.gov, Claude, Mistral, VoteSmart) are held server-side on the backend proxy at `api.liarsledger.com`. The extension never holds, transmits, or exposes API keys. `src/config.js` contains only the proxy URL and is gitignored - distributed builds auto-generate it from `config.example.js` during the build process.

### Permissions
- **`activeTab`** - reads page content only when the user clicks "Scan This Page"
- **`storage`** - session storage for scan result caching (cleared on browser close); local storage for a single enabled/disabled toggle
- **`host_permissions`** - limited to `https://api.liarsledger.com/*` only
- **`content_scripts`** - runs on all URLs to enable scanning on any news site; does not transmit data until the user initiates a scan
- **`web_accessible_resources`** - limited to `report.html` and `report.js` (opened in new tab from content script)

### Data Flow
```
User clicks Scan → content script reads article text
  → background worker sends text to api.liarsledger.com
    → proxy forwards to Claude + Mistral (claim extraction)
    → proxy queries Congress.gov, GovTrack, VoteSmart (voting records)
    → proxy sends claim + record to Claude (verdict verification)
  → results displayed in sidebar
```

Article text is processed in real time and is not logged or stored by the proxy.

### CORS
The backend proxy validates request origins via `ALLOWED_ORIGINS` environment variable, restricted to authorized Chrome extension IDs.

---

## No User Data Collection (By Design)

Liar's Ledger does not collect, store, or transmit:
- Browsing history or article URLs
- User identity, names, or email addresses
- Location or geolocation data
- Authentication credentials
- Financial information

This is a core design principle enforced at every layer.

---

## Pre-Release Checklist

- [x] API keys moved to backend proxy
- [x] Claude / Mistral access only via proxy - no provider keys in extension
- [x] `host_permissions` narrowed to `api.liarsledger.com` only
- [x] `src/config.js` removed from `web_accessible_resources`
- [x] Privacy policy published at liarsledger.com/privacy.html
- [x] COPPA compliance section added
- [x] Permissions justified in Chrome Web Store listing
- [x] `web_accessible_resources` limited to report files only

---

## Reporting a Vulnerability

To report a security issue, open a GitHub issue marked **[SECURITY]** or email [security@liarsledger.com](mailto:security@liarsledger.com).
