// Liar's Ledger - src/config.example.js
//
// ┌─────────────────────────────────────────────────────────────┐
// │  SETUP: Rename this file to config.js, then fill in your    │
// │  Congress.gov API key below. That's it.                     │
// │                                                             │
// │  Get a free key at: https://api.congress.gov/sign-up/       │
// └─────────────────────────────────────────────────────────────┘

const CONFIG = {

  // ← PASTE YOUR KEY HERE (the only thing you need to change)
  CONGRESS_API_KEY: "YOUR_CONGRESS_API_KEY_HERE",

  // ── Everything below is pre-configured ──────────────────────
  PROXY_URL:            "https://api.liarsledger.com",
  LLM_PROVIDER:         "dual",
  CLAUDE_API_KEY:       null,
  MISTRAL_API_KEY:      null,
  CLAUDE_API_ENDPOINT:  "https://api.liarsledger.com/api/claude/extract",
  MISTRAL_API_ENDPOINT: "https://api.liarsledger.com/api/mistral/extract",
  LLM_TIMEOUT_MS:       30000,
  GOVTRACK_KEY:         null,
  VOTESMART_KEY:        null,
  OLLAMA_BASE_URL:      null,
  OLLAMA_MODEL:         null,
  OLLAMA_TIMEOUT_MS:    120000,

};