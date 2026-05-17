// Liar's Ledger - src/config.example.js
// Copy this file to config.js and fill in your keys.
// config.js is gitignored and will NEVER be committed.

const CONFIG = {

  // ── Congress.gov ────────────────────────────────────────────────────────────
  // Register at: https://api.congress.gov/sign-up/
  // Free, instant, 5000 requests/hour
  CONGRESS_API_KEY: "YOUR_CONGRESS_API_KEY_HERE",

  // ── VoteSmart ───────────────────────────────────────────────────────────────
  // Register at: https://votesmart.org/share/api
  VOTESMART_KEY: "YOUR_VOTESMART_KEY_HERE",

  // ── GovTrack — no key required ──────────────────────────────────────────────
  GOVTRACK_KEY: null,

  // ── LLM Provider ────────────────────────────────────────────────────────────
  // Controls which model(s) run for claim extraction.
  //   "dual"    — Claude + Mistral in parallel; dual-verified badge (production)
  //   "claude"  — Claude only
  //   "mistral" — Mistral only
  //   "ollama"  — Local Ollama (dev/offline)
  LLM_PROVIDER: "dual",

  // ── Claude (Anthropic) ──────────────────────────────────────────────────────
  // Get key at: https://console.anthropic.com/
  // Dev model:  claude-haiku-4-5-20251001  (~$0.25/1M tokens in, ~$1.25/1M out)
  // Prod model: claude-sonnet-4-6          (upgrade in src/llm.js CLAUDE_MODEL)
  //
  // Production: set CLAUDE_API_ENDPOINT to your backend proxy URL.
  // Proxy normalizes to standard Anthropic response shape; no code changes needed.
  CLAUDE_API_KEY:      "YOUR_CLAUDE_API_KEY_HERE",
  CLAUDE_API_ENDPOINT: null, // null = call Anthropic directly (dev only)

  // ── Mistral AI ───────────────────────────────────────────────────────────────
  // Get key at: https://console.mistral.ai/
  // Dev model:  mistral-small-latest  (~$0.10/1M tokens in, ~$0.30/1M out)
  // Prod model: mistral-medium-latest (upgrade in src/llm.js MISTRAL_MODEL)
  //
  // Production: set MISTRAL_API_ENDPOINT to your backend proxy URL.
  MISTRAL_API_KEY:      "YOUR_MISTRAL_API_KEY_HERE",
  MISTRAL_API_ENDPOINT: null, // null = call Mistral directly (dev only)

  // ── Ollama (local dev / offline fallback) ───────────────────────────────────
  // Tailscale peer or localhost. Leave null to skip Ollama entirely.
  // Only used when LLM_PROVIDER is "ollama".
  OLLAMA_BASE_URL:  null,    // e.g. "http://100.67.253.3:11434"
  OLLAMA_MODEL:     "qwen2.5:7b",
  OLLAMA_TIMEOUT_MS: 120000,

  // ── LLM timeout (ms) ────────────────────────────────────────────────────────
  // Applied per model. Dual mode runs both in parallel so wall time = this value,
  // not 2x. 30s is generous for cloud APIs; increase if you see timeouts.
  LLM_TIMEOUT_MS: 30000,

};
