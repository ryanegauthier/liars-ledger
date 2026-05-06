// Worth Noting - background.js
// Service worker: handles API calls and message routing

importScripts(
  "src/config.js",
  "src/lookup.js",
  "src/keywords.js",
  "src/api.js"
);

const browser = globalThis.browser || globalThis.chrome;

// --- Message listener ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Worth Noting background] received:", message.action);

  if (message.action === "ping") {
    sendResponse({ status: "ok", version: "0.4.0" });
    return true;
  }

  if (message.action === "analyze") {
    handleAnalyze(message.payload).then(sendResponse);
    return true; // keep channel open for async
  }

  return true;
});

// --- Main analysis pipeline ---
async function handleAnalyze({ politicians, articleText, apiKey }) {
  try {
    // Step 1: Resolve politician names to dictionary entries
    const { resolved, notMembers, notFound } = await resolveAll(politicians);

    if (resolved.length === 0) {
      return {
        status: "no_members",
        notMembers,
        notFound,
        message: "No current members of Congress detected."
      };
    }

    // Step 2: Extract topic keywords from article
    const topics = getSearchTerms(articleText);

    if (topics.length === 0) {
      return {
        status: "no_topics",
        resolved: resolved.map(m => m.full_name),
        message: "Politicians found but no policy topics detected."
      };
    }

    // Step 3: Look up voting/sponsorship records on those topics
    const records = await lookupAll(resolved, topics, apiKey);

    return {
      status: "ok",
      topics,
      records,
      notMembers,
      notFound,
    };

  } catch (err) {
    console.error("[Worth Noting] analysis error:", err);
    return { status: "error", message: err.message };
  }
}

console.log("[Worth Noting] background service worker loaded v0.4.0");
