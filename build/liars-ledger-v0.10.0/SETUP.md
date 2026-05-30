# Liar's Ledger v0.10.0 — Setup Instructions

## Installation

1. Unzip this folder somewhere permanent on your computer
2. Rename `src/config.example.js` to `src/config.js`
3. Open `src/config.js` and fill in your API keys (see below)
4. Open Chrome and go to `chrome://extensions`
5. Enable **Developer mode** (toggle in the top right)
6. Click **Load unpacked**
7. Select this unzipped folder
8. Navigate to any political news article and click the Liar's Ledger icon

## API Keys Required

You need a Congress.gov API key (free, instant):
- Register at: https://api.congress.gov/sign-up/
- Paste the key into `src/config.js` as `CONGRESS_API_KEY`

The AI claim extraction uses the shared backend at api.liarsledger.com.
No additional keys needed — the backend is already configured.

## config.js

```js
const CONFIG = {
  CONGRESS_API_KEY:     "your-key-here",
  LLM_PROVIDER:         "dual",
  CLAUDE_API_KEY:       null,
  MISTRAL_API_KEY:      null,
  CLAUDE_API_ENDPOINT:  "https://api.liarsledger.com/api/claude/extract",
  MISTRAL_API_ENDPOINT: "https://api.liarsledger.com/api/mistral/extract",
  LLM_TIMEOUT_MS:       30000,
  OLLAMA_BASE_URL:      null,
  OLLAMA_MODEL:         null,
  OLLAMA_TIMEOUT_MS:    30000,
  GOVTRACK_KEY:         null,
  VOTESMART_KEY:        null,
};
```

## Questions?

See the full project at: https://github.com/ryanegauthier/worth-noting
