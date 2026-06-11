// Liars Ledger - background.js
// Service worker: handles API calls and message routing

importScripts(
  "src/config.js",
  "src/logger.js",
  "src/lookup.js",
  "src/keywords.js",
  "src/llm.js",
  "src/topic-match.js",
  "src/api.js",
  "src/votesmart.js",
  "src/verify.js",
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
    sendResponse({ status: "ok", version: "0.12.0" });
    return true;
  }

  if (message.action === "analyze") {
    logger.info("background", "received analyze request");
    browser.storage.session.set({ ll_results: { status: "working" } });
    handleAnalyze(message.payload).then((result) => {
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
async function handleAnalyze({ politicians, articleText }) {
  try {
    let articleSummary   = null;
    let figures          = [];
    let mainTopicsGlobal = [];

    const llmProvider = (typeof CONFIG !== "undefined" && CONFIG.LLM_PROVIDER) || "dual";
    const llmOn       = !!(articleText?.trim());

    if (llmOn) {
      logger.info("background", `LLM analysis: provider=${llmProvider}`);

      const ann = await extractArticleAnalysis(articleText, {
        provider:       llmProvider,
        claudeApiKey:   CONFIG.CLAUDE_API_KEY,
        mistralApiKey:  CONFIG.MISTRAL_API_KEY,
        claudeEndpoint: CONFIG.CLAUDE_API_ENDPOINT  || undefined,
        mistralEndpoint:CONFIG.MISTRAL_API_ENDPOINT || undefined,
        timeoutMs:      CONFIG.LLM_TIMEOUT_MS || 30000,
      });
      if (ann.ok) {
        articleSummary   = ann.summary || null;
        figures          = ann.figures || [];
        mainTopicsGlobal = ann.main_topics || [];
        if (ann._meta) {
          const loserError = figures?.[0]?._loser_error || "unknown";
          const logMsg = ann._meta.provider === "single_model"
            ? `LLM ok — provider=single_model, winner=${ann._meta.winner}, loser=${ann._meta.loser}, loser_error=${loserError}, figures=${figures.length}, topics=${mainTopicsGlobal.length}`
            : `LLM ok — provider=${ann._meta.provider}, figures=${figures.length}, topics=${mainTopicsGlobal.length}, verified=${ann._meta.verified ?? "n/a"}, ambiguous=${ann._meta.ambiguous ?? "n/a"}`;
          logger.info("background", logMsg);
        } else {
          logger.info("background", `LLM ok — ${figures.length} figure(s), ${mainTopicsGlobal.length} topic(s)`);
        }
      }
    }

    let namesForResolve = Array.isArray(politicians) ? politicians.filter(Boolean) : [];
    if (figures.length) {
      namesForResolve = figures.map((f) => f.lookup_name).filter(Boolean);
    }

    if (!namesForResolve.length) {
      logger.warn("background", "no politician names to resolve");
      return {
        status: "no_members",
        notMembers: [],
        notFound: [],
        message: "No politicians to analyze.",
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
      const fig = figureForMember(figures, m);
      if (fig?.claim) claimByLabel.set(label, fig.claim);
      topicsByLabel.set(label, mergeTopicsForMember(fig, mainTopicsGlobal, fallbackTopics));
    }

    const memberJobs = resolved.map((m) => {
      const fig = figureForMember(figures, m);
      const llmSearchTerms = fig?.search_terms || [];
      return {
        member: {
          ...m,
          _llm_search_terms: llmSearchTerms, // passed to api.js for direct title matching
          _main_topics: fallbackTopics,
        },
        topics: topicsByLabel.get(m.matched_as) || [],
      };
    });

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

    const records = await lookupAll(memberJobs);

    for (let i = 0; i < records.length; i++) {
      const label = resolved[i].matched_as;
      const fig   = figureForMember(figures, resolved[i]);

      // Verified claim
      const claim = claimByLabel.get(label);
      if (claim) records[i].claim = claim;

      // Pass verification metadata through for UI display
      if (fig) {
        records[i]._verification  = fig._verification  || null;
        records[i]._claude_claim  = fig._claude_claim  || null;
        records[i]._mistral_claim = fig._mistral_claim || null;
        records[i]._similarity    = fig._similarity    || null;
      }
    }

    logger.info("background", `analysis complete — ${records.length} record(s) returned`);
    // --- Claim-vs-record verification ---
    logger.info("background", `verifying claims for ${records.length} member(s)`);
    await verifyAllClaims(records);
    for (const r of records) {
      logger.info("background", `${r.politician.full_name}: verdict=${r.verdict}`);
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

logger.info("background", "service worker loaded v0.12.0");
