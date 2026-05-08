// Worth Noting - background.js
// Service worker: handles API calls and message routing

importScripts(
  "src/config.js",
  "src/logger.js",
  "src/lookup.js",
  "src/keywords.js",
  "src/api.js"
);

const browser = globalThis.browser || globalThis.chrome;

// --- Message listener ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ status: "ok", version: "0.4.1" });
    return true;
  }

  if (message.action === "analyze") {
    logger.info("background", "received analyze request");
    browser.storage.session.set({ wn_results: { status: "working" } });
    handleAnalyze(message.payload).then(result => {
      result.apiKey = message.payload.apiKey;
      browser.storage.session.set({ wn_results: result });
    });
    sendResponse({ status: "accepted" });
    return true;
  }

  if (message.action === "getResults") {
    browser.storage.session.get("wn_results", (data) => {
      sendResponse(data.wn_results || { status: "working" });
    });
    return true;
  }

  return true;
});

// --- Main analysis pipeline ---
async function handleAnalyze({ politicians, articleText, apiKey }) {
  try {
    logger.info("background", `resolving ${politicians.length} politician(s): ${politicians.join(", ")}`);
    const { resolved, notMembers, notFound } = await resolveAll(politicians);

    if (notMembers.length) logger.warn("background", `not current members: ${notMembers.join(", ")}`);
    if (notFound.length) logger.warn("background", `not found in dictionary: ${notFound.join(", ")}`);

    if (resolved.length === 0) {
      logger.warn("background", "no current Congress members found");
      return { status: "no_members", notMembers, notFound, message: "No current members of Congress detected." };
    }

    logger.info("background", `resolved: ${resolved.map(m => m.full_name).join(", ")}`);

    const topics = getSearchTerms(articleText);

    if (topics.length === 0) {
      logger.warn("background", "no policy topics detected in article");
      return { status: "no_topics", resolved: resolved.map(m => m.full_name), message: "Politicians found but no policy topics detected." };
    }

    logger.info("background", `topics detected: ${topics.join(", ")}`);

    const records = await lookupAll(resolved, topics, apiKey);

    logger.info("background", `analysis complete — ${records.length} record(s) returned`);
    return { status: "ok", topics, records, notMembers, notFound };

  } catch (err) {
    logger.error("background", `analysis failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

logger.info("background", "service worker loaded v0.4.1");
