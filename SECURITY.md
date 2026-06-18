# Security Policy

## Current Status
Liar's Ledger v0.14.1 has completed its pre-release security checklist. v0.12.1 is published on the Chrome Web Store; v0.13.0 (no functional changes from v0.12.1 beyond store-listing metadata) is submitted and awaiting Chrome Web Store review approval.

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

### Free/Pro Tier Enforcement
Enforcement of scan limits and Pro-only features happens server-side, not in the extension. This matters because client-side code is fully visible to anyone who installs the extension and reads its source (it's open source, deliberately) - any check that only existed in `background.js` or `content.js` could be bypassed by a modified build of the extension talking to our real backend.

- **Scan limits** are tracked per anonymous token in Redis (`scans:{tokenId}:{date}`), checked and incremented via `POST /api/scan/start`. The daily limit is shared across all users and tiers (Pro does not mean unlimited scans - see README) and scales down automatically as the registered-user count grows.
- **Pro-only data** (AI claim verdicts, VoteSmart vote history and ratings) is gated at the response layer in `server/index.js`: `/api/verify-claim` and `/api/votesmart/*` require Pro via `requirePro` middleware and reject free-tier requests with a 403 *before* the verdict or VoteSmart data is ever computed - not just before it's displayed. `/api/claude/extract` and `/api/mistral/extract` strip the claim text and article summary from the response for free tier, server-side, before the response leaves the server.
- The extension's own client-side gating in `background.js` is a defensive fallback layer, not the security boundary. It exists for UX reasons (avoid briefly rendering data the user then loses) and as a safety net, not to enforce the actual restriction.

### Known Gaps - Anonymous Token Abuse
The anonymous per-install token model (no email, no account, no payment verification tying a token to anything) trades verification for privacy and zero-friction onboarding. This has a real, accepted limitation:

- **Token farming**: nothing currently prevents a script from calling `POST /register` directly (bypassing the extension entirely) to mass-create fake tokens, each with its own daily scan allowance. This both drains API budget directly (if the bot also calls the scan endpoints) and indirectly degrades the experience for real users, since each new registration increments the global user count that the dynamic scan-limit table is based on.
- **Mitigation in place**: `POST /register` is rate-limited to 5 requests/hour per IP (separate from and stricter than the general 60/minute API limiter). This closes the trivial single-machine bot case.
- **Not mitigated**: a distributed attacker using many IPs or proxies, registering slowly, is not stopped by IP-based rate limiting. A more complete fix (CAPTCHA, proof-of-work, or some form of identity verification on registration) would close this further but adds friction for legitimate users and hasn't been built. This is an accepted tradeoff at the current scale and userbase size, revisit if abuse is observed in practice.
- **Admin override endpoints** (`/admin/set-tier`, `/admin/reset-scans`) exist as temporary, manual testing tools while Square subscription integration doesn't exist yet. Both fail closed (403) unless `ADMIN_SECRET` is set in Render's environment and provided via the `x-admin-key` header on the request. These should be removed once automatic tier management via Square is live.

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
- [x] Free/Pro tier gating enforced server-side, not just client-side (v0.14.1 - verified via direct API calls bypassing the extension entirely, confirmed 403 on `/api/verify-claim` and `/api/votesmart/*` for free tier, confirmed claim/summary stripped from extraction responses)
- [x] `POST /register` rate-limited separately and more strictly than general API traffic (v0.14.1)
- [x] Admin override endpoints (`/admin/set-tier`, `/admin/reset-scans`) fail closed when `ADMIN_SECRET` is unset - confirmed they 403 rather than fail open
- [ ] No automated test suite exists yet - all verification in this checklist was done by manual API calls during this release. A real regression test suite covering tier gating would catch issues like the v0.14.0→v0.14.1 pooled-scan-limit bug (see CHANGELOG) automatically.
- [ ] Distributed token-farming (many IPs, slow registration rate) is not mitigated - see "Known Gaps" above

---

## Reporting a Vulnerability

To report a security issue, open a GitHub issue marked **[SECURITY]** or email [security@liarsledger.com](mailto:security@liarsledger.com).
