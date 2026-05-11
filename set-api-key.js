// Liars Ledger - set-api-key.js
// Run this ONCE in the browser console on any page after loading the extension.
// It stores your API key in local extension storage — never in code or files.
//
// Usage: paste this into DevTools console and replace YOUR_KEY_HERE

chrome.storage.local.set({
  congressApiKey: "YOUR_CONGRESS_GOV_KEY_HERE"
}, () => console.log("✓ API key saved to extension storage."));
