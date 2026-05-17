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

function figureForMember(figures, member) {
  if (!figures?.length) return null;
  const last = (member.last_name || "").toLowerCase().replace(/\./g, "").trim();
  if (last) {
    for (const fig of figures) {
      const l = (fig.lookup_name || "").toLowerCase();
      if (l.includes(last)) return fig;
    }
  }
  const mNorm = stripTitle(member.matched_as || "").toLowerCase();
  for (const fig of figures) {
    if (stripTitle(fig.lookup_name || "").toLowerCase() === mNorm) return fig;
  }
  return null;
}

// --- Message listener ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ status: "ok", version: "0.6.0" });
    return true;
  }

  if (message.action === "analyze") {
    logger.info("background", "received analyze request");
    browser.storage.session.set({ ll_results: { status: "working" } });
    handleAnalyze(message.payload).then((result) => {
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
    const ollamaUrl = typeof CONFIG !== "undefined" && CONFIG.OLLAMA_BASE_URL;
    const ollamaModel = typeof CONFIG !== "undefined" && CONFIG.OLLAMA_MODEL;
    const ollamaOn = !!(ollamaUrl && ollamaModel && articleText?.trim());

    let articleSummary = null;
    let ollamaFigures = [];
    let mainTopicsGlobal = [];

    if (ollamaOn) {
      logger.info("background", `Ollama article analysis: ${ollamaUrl} model=${ollamaModel}`);
      const ann = await extractArticleAnalysisViaOllama(articleText, {
        baseUrl: ollamaUrl,
        model: ollamaModel,
        timeoutMs: CONFIG.OLLAMA_TIMEOUT_MS || 90000,
      });
      if (ann.ok) {
        articleSummary = ann.summary || null;
        ollamaFigures = ann.figures || [];
        mainTopicsGlobal = ann.main_topics || [];
        logger.info(
          "background",
          `Ollama article analysis ok — ${ollamaFigures.length} figure(s), ${mainTopicsGlobal.length} topic(s)`
        );
      } else {
        logger.warn("background", `Ollama article analysis failed (${ann.error})`);
      }
    }

    let namesForResolve = Array.isArray(politicians) ? politicians.filter(Boolean) : [];
    if (ollamaFigures.length) {
      namesForResolve = ollamaFigures.map((f) => f.lookup_name).filter(Boolean);
    }

    if (!namesForResolve.length) {
      logger.warn("background", "no politician names to resolve");
      return {
        status: "no_members",
        notMembers: [],
        notFound: [],
        message: ollamaOn
          ? "Ollama did not identify any current members of Congress in this article. Try another piece or check the model output."
          : "No politicians to analyze.",
      };
    }

    logger.info("background", `resolving ${namesForResolve.length} name(s): ${namesForResolve.join(", ")}`);
    const { resolved, notMembers, notFound } = await resolveAll(namesForResolve);

    if (notMembers.length) logger.warn("background", `not current members: ${notMembers.join(", ")}`);
    if (notFound.length) logger.warn("background", `not found in dictionary: ${notFound.join(", ")}`);

    if (resolved.length === 0) {
      logger.warn("background", "no current Congress members found");
      return { status: "no_members", notMembers, notFound, message: "No current members of Congress detected." };
    }

    logger.info("background", `resolved: ${resolved.map((m) => m.full_name).join(", ")}`);

    const fallbackTopics = getSearchTerms(articleText);

    /** @type {Map<string, string[]>} */
    const topicsByLabel = new Map();
    /** @type {Map<string, string>} */
    const claimByLabel = new Map();

    for (const m of resolved) {
      const label = m.matched_as;
      const fig = figureForMember(ollamaFigures, m);
      if (fig?.claim) claimByLabel.set(label, fig.claim);
      topicsByLabel.set(label, mergeTopicsForMember(fig, mainTopicsGlobal, fallbackTopics));
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

    const topicsUnion = [...new Set([...mainTopicsGlobal, ...memberJobs.flatMap((j) => j.topics)])];
    logger.info("background", `search terms (union): ${topicsUnion.join(", ")}`);

    const records = await lookupAll(memberJobs, apiKey);

    for (let i = 0; i < records.length; i++) {
      const label = resolved[i].matched_as;
      const claim = claimByLabel.get(label);
      if (claim) records[i].claim = claim;
    }

    logger.info("background", `analysis complete — ${records.length} record(s) returned`);
    return {
      status: "ok",
      topics: topicsUnion,
      records,
      notMembers,
      notFound,
      articleSummary,
    };
  } catch (err) {
    logger.error("background", `analysis failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

logger.info("background", "service worker loaded v0.6.0");
