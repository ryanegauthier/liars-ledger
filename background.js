// Liars Ledger - background.js
// Service worker: handles API calls and message routing

importScripts(
  "src/config.js",
  "src/logger.js",
  "src/lookup.js",
  "src/keywords.js",
  "src/ollama.js",
  "src/api.js"
);

const browser = globalThis.browser || globalThis.chrome;

// --- Message listener ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ status: "ok", version: "0.6.0" });
    return true;
  }

  if (message.action === "analyze") {
    logger.info("background", "received analyze request");
    browser.storage.session.set({ ll_results: { status: "working" } });
    handleAnalyze(message.payload).then(result => {
      result.apiKey = message.payload.apiKey;
      browser.storage.session.set({ ll_results: result });
    });
    sendResponse({ status: "accepted" });
    return true;
  }

  if (message.action === "getResults") {
    browser.storage.session.get("ll_results", (data) => {
      sendResponse(data.ll_results || { status: "working" });
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

    const fallbackTopics = getSearchTerms(articleText);
    const labels = resolved.map((m) => m.matched_as);

    /** @type {Map<string, string[]>} */
    let topicsByLabel = new Map();
    /** @type {Map<string, string>} */
    const claimByLabel = new Map();

    const ollamaUrl = typeof CONFIG !== "undefined" && CONFIG.OLLAMA_BASE_URL;
    const ollamaModel = typeof CONFIG !== "undefined" && CONFIG.OLLAMA_MODEL;

    if (ollamaUrl && ollamaModel) {
      logger.info("background", `Ollama claim extraction: ${ollamaUrl} model=${ollamaModel}`);
      const ollamaResult = await extractPolicyClaimsViaOllama(articleText, labels, {
        baseUrl: ollamaUrl,
        model: ollamaModel,
        timeoutMs: CONFIG.OLLAMA_TIMEOUT_MS || 45000,
      });

      if (ollamaResult.ok) {
        topicsByLabel = normalizeTopicsFromOllama(ollamaResult.byLabel, labels, fallbackTopics);
        for (const label of labels) {
          const row = ollamaResult.byLabel.get(label);
          if (row?.claim) claimByLabel.set(label, row.claim);
        }
        logger.info("background", "Ollama claim extraction succeeded");
      } else {
        logger.warn("background", `Ollama failed (${ollamaResult.error}) — using keyword topics`);
        for (const label of labels) {
          topicsByLabel.set(label, [...fallbackTopics]);
        }
      }
    } else {
      for (const label of labels) {
        topicsByLabel.set(label, [...fallbackTopics]);
      }
    }

    const memberJobs = resolved.map((m) => ({
      member: m,
      topics: topicsByLabel.get(m.matched_as) || [],
    }));

    if (memberJobs.every((j) => j.topics.length === 0)) {
      logger.warn("background", "no policy topics or search terms for any member");
      return {
        status: "no_topics",
        resolved: resolved.map((m) => m.full_name),
        message: "Politicians found but no policy topics detected.",
      };
    }

    const topicsUnion = [...new Set(memberJobs.flatMap((j) => j.topics))];
    logger.info("background", `search terms (union): ${topicsUnion.join(", ")}`);

    const records = await lookupAll(memberJobs, apiKey);

    for (let i = 0; i < records.length; i++) {
      const label = resolved[i].matched_as;
      const claim = claimByLabel.get(label);
      if (claim) records[i].claim = claim;
    }

    logger.info("background", `analysis complete — ${records.length} record(s) returned`);
    return { status: "ok", topics: topicsUnion, records, notMembers, notFound };

  } catch (err) {
    logger.error("background", `analysis failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

logger.info("background", "service worker loaded v0.6.0");
