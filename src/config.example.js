// Liars Ledger - config.example.js
// Copy this file to config.js and fill in your API keys
// config.js is gitignored and will NEVER be committed

const CONFIG = {
  // Congress.gov API key (replaces ProPublica which shut down new signups)
  // Register at: https://api.congress.gov/sign-up/
  // Free, instant, 5000 requests/hour
  CONGRESS_API_KEY: "YOUR_CONGRESS_GOV_KEY_HERE",

  // VoteSmart API key
  // Register at: https://votesmart.org/share/api
  VOTESMART_KEY: "YOUR_VOTESMART_KEY_HERE",

  // GovTrack does not require a key — leave as-is
  GOVTRACK_KEY: null,

  // Ollama (dev) — per-politician claim + bill search phrases. Leave URL null to use
  // regex topic detection only (getSearchTerms). For a Tailscale peer, use e.g.
  // "http://100.x.x.x:11434" and add the same origin to manifest.json host_permissions.
  OLLAMA_BASE_URL: null,
  OLLAMA_MODEL: "llama3.2:3b",
  OLLAMA_TIMEOUT_MS: 45000,
};
