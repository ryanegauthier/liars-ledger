// Liars Ledger - background.js
// Service worker: handles API calls and message routing

importScripts(
  "src/config.js",
  "src/logger.js",
  "src/token.js",
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
    sendResponse({ status: "ok", version: "0.14.2" });
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
    // Fetch tier once, up front — used to gate VoteSmart lookups below
    // (cost-saving: free tier never calls VoteSmart at all) and to strip
    // claim/verdict/VoteSmart fields from the final response further down.
    // See the "PRO-TIER GATING" comment near the end of this function for
    // the full list of what's gated and why.
    const { tier } = await getOrCreateToken();
    const isPro = tier === "pro";

    let articleSummary   = null;
    let figures          = [];
    let mainTopicsGlobal = [];

    const llmProvider = (typeof CONFIG !== "undefined" && CONFIG.LLM_PROVIDER) || "dual";
    const llmOn       = !!(articleText?.trim());

    if (llmOn) {
      // ── Scan counting — single call, before any LLM provider runs ─────────
      // This is the ONLY place a scan gets counted. /api/claude/extract and
      // /api/mistral/extract do not count themselves, so dual-model mode
      // (both providers firing for one page-scan) never double-charges.
      const proxyUrl = (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL)
        || "https://api.liarsledger.com";
      const auth = await authHeaders();

      try {
        const scanRes = await fetch(`${proxyUrl}/api/scan/start`, {
          method: "POST",
          headers: auth,
        });

        // Refresh chrome.storage.sync immediately so popup.js's scan-count
        // display is accurate the moment this scan is counted — regardless
        // of whether it was allowed, rate-limited, or the request itself
        // had a transient error. syncTier() is the single source of truth
        // for this storage write; we don't duplicate that logic here.
        syncTier();

        if (scanRes.status === 429) {
          logger.warn("background", "scan limit reached - aborting before LLM call");
          return {
            status: "rate_limited",
            message: "Daily scan limit reached. Upgrade to Pro for unlimited scans.",
            upgrade_url: "https://liarsledger.com/pricing",
          };
        }
        // Any other non-OK status (5xx, auth issue, etc.) — fail open and
        // proceed with the scan rather than blocking the user on a server hiccup.
      } catch (e) {
        logger.warn("background", `scan/start request failed: ${e.message} - failing open`);
      }

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
            ? `LLM ok - provider=single_model, winner=${ann._meta.winner}, loser=${ann._meta.loser}, loser_error=${loserError}, figures=${figures.length}, topics=${mainTopicsGlobal.length}`
            : `LLM ok - provider=${ann._meta.provider}, figures=${figures.length}, topics=${mainTopicsGlobal.length}, verified=${ann._meta.verified ?? "n/a"}, ambiguous=${ann._meta.ambiguous ?? "n/a"}`;
          logger.info("background", logMsg);
        } else {
          logger.info("background", `LLM ok - ${figures.length} figure(s), ${mainTopicsGlobal.length} topic(s)`);
        }
      } else if (ann?.error?.includes("429")) {
        return {
          status: "rate_limited",
          message: "Daily scan limit reached. Upgrade to Pro for unlimited scans.",
          upgrade_url: "https://liarsledger.com/pricing",
        };
      } else {
        logger.warn("background", `LLM failed: ${ann.error} - continuing with keyword fallback`);
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
    const { resolved, formerMembers, notMembers, notFound } = await resolveAll(namesForResolve);
    if (formerMembers.length) logger.info("background", `former members: ${formerMembers.map(m => m.full_name).join(", ")}`);
    
    if (notMembers.length) logger.warn("background", `not current members: ${notMembers.join(", ")}`);
    if (notFound.length) logger.warn("background", `not found in dictionary: ${notFound.join(", ")}`);

    // Process both current and former members through the pipeline
    const allMembers = [...resolved, ...formerMembers];

    if (allMembers.length === 0) {
      logger.warn("background", "no Congress members found");
      return { status: "no_members", notMembers, notFound, message: "No current or former members of Congress detected." };
    }

    logger.info("background", `resolved: ${allMembers.map((m) => m.full_name).join(", ")}`);

    const fallbackTopics = getSearchTerms(articleText);

    /** @type {Map<string, string[]>} */
    const topicsByLabel = new Map();
    /** @type {Map<string, string>} */
    const claimByLabel = new Map();

    for (const m of allMembers) {
      const label = m.matched_as;
      const fig = figureForMember(figures, m);
      if (fig?.claim) claimByLabel.set(label, fig.claim);
      topicsByLabel.set(label, mergeTopicsForMember(fig, mainTopicsGlobal, fallbackTopics));
    }

    const memberJobs = allMembers.map((m) => {
      const fig = figureForMember(figures, m);
      const llmSearchTerms = fig?.search_terms || [];
      return {
        member: {
          ...m,
          _llm_search_terms: llmSearchTerms,
          _main_topics: fallbackTopics,
        },
        topics: topicsByLabel.get(m.matched_as) || [],
      };
    });

    if (memberJobs.every((j) => j.topics.length === 0)) {
      logger.warn("background", "no policy topics or search terms for any member");
      return {
        status: "no_topics",
        resolved: allMembers.map((m) => m.full_name),
        message: "Politicians found but no policy topics detected.",
      };
    }

    const topicsUnion = [...new Set([...mainTopicsGlobal, ...memberJobs.flatMap((j) => j.topics)])];
    logger.info("background", `search terms (union): ${topicsUnion.join(", ")}`);

    const records = await lookupAll(memberJobs, { skipVoteSmart: !isPro });

    for (let i = 0; i < records.length; i++) {
      const label = allMembers[i].matched_as;
      const fig   = figureForMember(figures, allMembers[i]);

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

    logger.info("background", `analysis complete - ${records.length} record(s) returned`);

    // --- Claim-vs-record verification (Pro only) ---
    // Skipped entirely for free tier — /api/verify-claim now requires Pro
    // server-side anyway (see index.js's requirePro middleware), so calling
    // it here for free users would just burn a wasted request. Server cost
    // savings and field-stripping below are two separate, intentionally
    // redundant layers: this skip saves the API call; the strip below is
    // a fallback in case verifyAllClaims ever runs unconditionally again.
    if (isPro) {
      logger.info("background", `verifying claims for ${records.length} member(s)`);
      await verifyAllClaims(records);
      for (const r of records) {
        logger.info("background", `${r.politician.full_name}: verdict=${r.verdict}`);
      }
    }

    // ╔═══════════════════════════════════════════════════════════════════════╗
    // ║ PRO-TIER GATING — KEEP IN SYNC WITH report.js AND content.js           ║
    // ║                                                                         ║
    // ║ Scans are pooled across all users; tier only changes what data is      ║
    // ║ shown, not how many scans are available.                               ║
    // ║                                                                         ║
    // ║ This is now a DEFENSIVE FALLBACK, not the primary gate. The real       ║
    // ║ security boundary is server-side: /api/verify-claim and               ║
    // ║ /api/votesmart/* require Pro via requirePro middleware in index.js,    ║
    // ║ and /api/claude/extract + /api/mistral/extract strip summary/claim     ║
    // ║ fields server-side before responding. Free tier also never calls      ║
    // ║ verifyAllClaims() (skipped above) or VoteSmart (skipVoteSmart passed   ║
    // ║ to lookupAll above), so most of these fields should already be        ║
    // ║ absent by the time we get here. This block stays as a safety net in   ║
    // ║ case any of those upstream skips are ever removed by accident.        ║
    // ║                                                                         ║
    // ║ The fields stripped below are advertised as "Pro features" in the      ║
    // ║ upsell cards in report.js (proFeaturesUpsellHtml) and content.js       ║
    // ║ (the VoteSmart upsell card). If you add, remove, or rename a gated     ║
    // ║ field here, update the matching bullet list / copy in BOTH of those    ║
    // ║ files too — otherwise the upsell will advertise features that don't   ║
    // ║ exist, or silently fail to mention ones that do.                       ║
    // ╚═══════════════════════════════════════════════════════════════════════╝
    if (!isPro) {
      for (const r of records) {
        delete r.voteSmartVotes;
        delete r.voteSmartRatings;
        delete r.voteSmartId;
        delete r.claim;
        delete r.verdict;
        delete r.verdict_explanation;
        delete r._verification;
        delete r._claude_claim;
        delete r._mistral_claim;
        delete r._similarity;
      }
    }

    logger.info("background", `analysis complete - ${records.length} record(s) returned, tier=${tier}`);
    return {
      status: "ok",
      topics: topicsUnion,
      records,
      notMembers,
      notFound,
      articleSummary: isPro ? articleSummary : null,
      tier,
    };
  } catch (err) {
    logger.error("background", `analysis failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

logger.info("background", "service worker loaded v0.14.2");

// Initialize token and sync tier
getOrCreateToken().then((t) => {
  logger.info("background", `token: ${t.tokenId.slice(0, 8)}... tier=${t.tier}`);
  syncTier();
}).catch(() => {});