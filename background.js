// VoteCheck - background.js
// Service worker: handles API calls and message routing

// Cross-browser compatibility shim
const browser = globalThis.browser || globalThis.chrome;

// --- Message listener ---
// Content script sends { action, payload } messages here
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[VoteCheck background] received message:", message.action);

  if (message.action === "ping") {
    sendResponse({ status: "ok", version: "0.1.0" });
  }

  // Future actions will be added here:
  // "lookupPolitician" -> ProPublica / VoteSmart lookup
  // "getVotes"         -> fetch voting record

  return true; // keep message channel open for async responses
});

console.log("[VoteCheck] background service worker loaded");
