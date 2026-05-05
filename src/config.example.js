// Worth Noting - config.example.js
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
};
