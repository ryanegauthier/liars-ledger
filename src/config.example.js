// Liar's Ledger - src/config.example.js
//
// ┌─────────────────────────────────────────────────────────────┐
// │  SETUP: Rename this file to config.js,                      │
// │  then load unpacked in chrome://extensions. That's it.      │
// └─────────────────────────────────────────────────────────────┘

const CONFIG = {
  // Backend proxy - all API keys are held server-side
  PROXY_URL:            "https://api.liarsledger.com",

  // LLM provider - dual runs Claude + Mistral in parallel (production)
  LLM_PROVIDER:         "dual",
  CLAUDE_API_ENDPOINT:  "https://api.liarsledger.com/api/claude/extract",
  MISTRAL_API_ENDPOINT: "https://api.liarsledger.com/api/mistral/extract",
  LLM_TIMEOUT_MS:       30000,

  // Direct API keys - only needed for local dev without the proxy
  // Leave null for normal use
  CLAUDE_API_KEY:       null,
  MISTRAL_API_KEY:      null,
};
