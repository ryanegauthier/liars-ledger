// VoteCheck - content.js
// Runs on every page. Detects articles and extracts politician names.

// Cross-browser compatibility shim
const browser = window.browser || window.chrome;

// --- Ping background worker to confirm extension is alive ---
browser.runtime.sendMessage({ action: "ping" }, (response) => {
  if (browser.runtime.lastError) {
    console.warn("[VoteCheck] background not responding:", browser.runtime.lastError.message);
    return;
  }
  console.log("[VoteCheck] content script connected. Background version:", response?.version);
});

console.log("[VoteCheck] content script loaded on:", window.location.hostname);
