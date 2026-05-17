# Security Policy

## Current Status
Liars Ledger is in active development. The current build is intended for 
personal/developer use only and has not been audited for public distribution.

---

## Known Risks and Mitigations

### 1. API Key in config.js
**Risk:** The Congress.gov API key lives in a local file. Anyone with access 
to the machine or the unpacked extension folder can read it.

**Current mitigation:** `src/config.js` is gitignored and never committed.

**Pre-release mitigation:** Keys move to a backend proxy server. The extension 
never holds API keys in distributed builds.

---

### 2. `<all_urls>` Permission
**Risk:** The manifest declares the content script runs on every page. Chrome 
warns users about this during install, which is a trust barrier.

**Current mitigation:** The content script only reads article text. No data is 
transmitted anywhere except government API calls.

**Pre-release mitigation:** Narrow `matches` to known news domains where 
possible. Evaluate whether `activeTab` alone can replace `<all_urls>`.

---

### 3. Article Text in Message Pipeline
**Risk:** A long excerpt of article text (on the order of tens of thousands of 
characters when scanning) passes through the extension message pipeline from 
the content script to the background worker, and to Ollama when configured.

**Current mitigation:** All processing is local unless you point Ollama at a 
remote host (e.g. Tailscale). Article text is not sent to Congress.gov as a bulk 
upload; only derived queries and API paths are used.

**Pre-release mitigation:** When a backend proxy is added for Claude / Minstrel 
(or any hosted LLM), article excerpts must not be logged or retained without 
TTL/redaction. A privacy policy must be published before release, and the 
extension should call **your** proxy only — never ship provider API keys in the 
bundle.

---

### 4. web_accessible_resources Exposure
**Risk:** Files declared in `web_accessible_resources` can be requested by any 
webpage, including `src/config.js`.

**Current mitigation:** Acceptable for local dev use.

**Pre-release mitigation:** Tighten before release:
- `politicians.json` — keep accessible, it is public data
- `src/config.js` — remove from web_accessible_resources entirely, 
  keys will live server-side

---

### 5. No User Data Collection (By Design)
Liars Ledger does not collect, store, or transmit:
- Browsing history
- Article content
- User identity
- Location data

This is a core design principle, not just a current limitation. Any future 
backend must be architected to preserve this guarantee.

---

## Pre-Release Checklist
- [ ] API keys moved to backend proxy (Congress.gov and LLM providers)
- [ ] Anthropic / Minstrel (or other LLM) access **only** via proxy — see `docs/PRODUCTION-LLM.md` for milestone timing
- [ ] `<all_urls>` permission reviewed and narrowed
- [ ] `src/config.js` removed from web_accessible_resources
- [ ] Privacy policy written and published
- [ ] Security audit completed
- [ ] Permissions justified in Chrome Web Store listing

---

## Reporting a Vulnerability
This project is in early development. To report a security issue, 
open a GitHub issue marked **[SECURITY]** or contact the maintainer directly.