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
    sendResponse({ status: "ok", version: "0.16.1" });
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

  // Opens the standalone report page in a new tab via chrome.tabs.create -
  // NOT window.open() from the content script that sent this message. See
  // content.js's click handler comment for the full reasoning: this avoids
  // both an inconsistent ERR_BLOCKED_BY_CLIENT failure mode (content-script
  // window.open() is subject to the host page's popup-blocking context;
  // chrome.tabs.create() from the background script isn't) and keeps the
  // report URL from ever being constructed/touched inside the host page's
  // JS context at all (content.js only ever sends an index, never the URL).
  if (message.action === "openReport") {
    const idx = message.idx;
    const url = browser.runtime.getURL(`report.html${idx !== undefined ? `?idx=${idx}` : ""}`);
    browser.tabs.create({ url });
    return true;
  }

  return true;
});

// ── External messages from liarsledger.com ──────────────────────────────────
// Allows pricing.html to ask "is the extension installed, and what's the
// install token?" without the page needing to read chrome.storage.sync
// directly - which it can't, that storage area is sandboxed to the
// extension itself. This is the actual bridge: declared via
// externally_connectable.matches in manifest.json (scoped to
// https://liarsledger.com/* only - no other site can message this
// extension this way), received here via onMessageExternal (a distinct
// event from onMessage above, which only ever hears from this extension's
// own content scripts/popup, never from web pages).
//
// Deliberately narrow: this handler does exactly one thing - return the
// tokenId, nothing else. No write access, no other stored data, no way for
// the page to ask for anything beyond "what is my token." If this ever
// needs to expose more in the future, each addition should get the same
// scrutiny as this one did, not be added casually just because the
// channel already exists.
browser.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.action === "getToken") {
    browser.storage.sync.get("ll_auth_token", (data) => {
      const tokenId = data.ll_auth_token?.tokenId || null;
      sendResponse({ tokenId });
    });
    return true; // keep the message channel open for the async sendResponse above
  }
  return false;
});

// --- Main analysis pipeline ---
async function handleAnalyze({ politicians, articleText }) {
  try {
    // Fetch tier once, up front - used to gate VoteSmart lookups below
    // (cost-saving: free tier never calls VoteSmart at all) and to strip
    // claim/verdict/VoteSmart fields from the final response further down.
    // See the "PRO-TIER GATING" comment near the end of this function for
    // the full list of what's gated and why.
    const { tier, tokenId } = await getOrCreateToken();
    const isPro = tier === "pro";

    // Pricing URL with the install token attached as a query param, so
    // /pricing can pre-fill and auto-confirm checkout without the user
    // copy/pasting anything - the token is already known here, no reason
    // to make the person go dig it out of the popup's Account panel.
    // Used by both rate_limited returns below AND passed through on the
    // "ok" response so content.js's VoteSmart upsell card (non-blocking,
    // shown alongside successful results) can link the same way.
    const upgradeUrl = tokenId
      ? `https://liarsledger.com/pricing?token=${encodeURIComponent(tokenId)}`
      : "https://liarsledger.com/pricing"; // fallback - shouldn't happen, getOrCreateToken always returns one

    let articleSummary   = null;
    let figures          = [];
    let mainTopicsGlobal = [];

    const llmProvider = (typeof CONFIG !== "undefined" && CONFIG.LLM_PROVIDER) || "dual";
    const llmOn       = !!(articleText?.trim());

    // Hoisted so commitScan() and the no_members/no_topics early returns
    // below can all reach them without being inside the llmOn block.
    const proxyUrl = (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL)
      || "https://api.liarsledger.com";
    let commitToken = null;

    if (llmOn) {
      // ── Scan reservation - single call, before any LLM provider runs ──────
      // scan/start RESERVES a slot and returns two tokens:
      //   scanToken   -- required by the extraction endpoints (unchanged)
      //   commitToken -- passed to /api/scan/commit after lookupAll confirms
      //                  at least one external source (congress.gov or
      //                  govtrack) responded. If all sources time out, the
      //                  client skips commit and the reservation expires free.
      // See store.js reserveScan / commitScan for the full design.
      const auth = await authHeaders();
      let scanToken = null;

      try {
        const scanRes = await fetch(`${proxyUrl}/api/scan/start`, {
          method: "POST",
          headers: auth,
        });

        // Refresh popup scan-count display immediately so it stays accurate
        // regardless of whether the reservation was allowed or rate-limited.
        syncTier();

        if (scanRes.status === 429) {
          logger.warn("background", "scan limit reached - aborting before LLM call");
          return {
            status: "rate_limited",
            message: "Daily scan limit reached. Upgrade to Pro for unlimited scans.",
            upgrade_url: upgradeUrl,
          };
        }

        if (scanRes.ok) {
          const scanData = await scanRes.json();
          scanToken   = scanData.scanToken   || null;
          commitToken = scanData.commitToken || null;
          if (!scanToken) {
            logger.warn("background", "scan/start succeeded but returned no scanToken - extraction calls will be rejected server-side");
          }
        }
        // Non-OK (5xx, auth issue, etc.) - fail open. scanToken and
        // commitToken both stay null; extraction will be rejected server-side
        // by requireScanToken (403), and no commit will be sent.
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
        // NEW - required server-side as of the scan-token hardening pass.
        // src/llm.js's extractArticleAnalysis must include this in the
        // POST body of BOTH the Claude and Mistral extraction requests it
        // makes (dual mode calls both with the SAME scanToken value - see
        // store.js/auth.js for why reusing one token across both calls is
        // correct, not a bug). If llm.js doesn't yet thread this through to
        // its actual fetch() calls, both extraction requests will be
        // rejected with 403 by the server until it does - this is a
        // necessary follow-up change in llm.js that's outside what's
        // visible/editable from background.js alone.
        scanToken,
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
          upgrade_url: upgradeUrl,
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
      await doCommitScan(proxyUrl, commitToken);
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
      await doCommitScan(proxyUrl, commitToken);
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
      await doCommitScan(proxyUrl, commitToken);
      return {
        status: "no_topics",
        resolved: allMembers.map((m) => m.full_name),
        message: "Politicians found but no policy topics detected.",
      };
    }

    const topicsUnion = [...new Set([...mainTopicsGlobal, ...memberJobs.flatMap((j) => j.topics)])];
    logger.info("background", `search terms (union): ${topicsUnion.join(", ")}`);

    // VoteSmart is fetched for everyone now - it's free, sourced data (same
    // category as roll-call votes, which are already free), not part of
    // the AI-generated content that actually defines the Pro tier (article
    // summary + claim-vs-record verdict, both gated below). Previously
    // skipped for free tier via skipVoteSmart: !isPro - that's a cost-
    // saving measure this tier split deliberately gives up, since VoteSmart
    // calls now happen for every scan regardless of tier. Worth watching
    // VoteSmart API usage/cost now that it's unconditional.
    const records = await lookupAll(memberJobs, { skipVoteSmart: false });

    // Commit the scan only when the result is fully complete for every
    // politician. Skip commit (reservation expires, user keeps the scan to
    // retry) if EITHER:
    //   - every external source failed for every member (original rule,
    //     v0.16.0-era) - the .every() case below, OR
    //   - ANY member's VoteSmart lookup had to salvage a partial,
    //     pagination-degraded result, OR ANY member's GovTrack roll-call
    //     lookup failed on its own (even if congress.gov succeeded for
    //     that member) (both v0.17.2+, this session) - the .some() cases
    //     below. Deliberately looser than the original all-or-nothing
    //     rule: a single politician's incomplete data from EITHER source
    //     is enough to skip the charge, even if every other politician in
    //     the same scan resolved cleanly. See votesmart.js's
    //     fetchAllVsPages / resolveVoteSmartId for _votesmart_partial, and
    //     api.js's findMemberRollCallVotesOnTopics for _govtrack_errored.
    const allSourcesFailed = records.every((r) => r._sources_errored);
    const anyVoteSmartPartial = records.some((r) => r._votesmart_partial);
    const anyGovTrackErrored = records.some((r) => r._govtrack_errored);
    const skipCommit = allSourcesFailed || anyVoteSmartPartial || anyGovTrackErrored;

    if (skipCommit) {
      if (allSourcesFailed) {
        logger.warn("background", "all external sources failed for all members - scan not counted, reservation will expire");
      } else if (anyVoteSmartPartial) {
        logger.warn("background", "VoteSmart returned a partial result for at least one member - scan not counted, reservation will expire");
      } else {
        logger.warn("background", "GovTrack failed for at least one member - scan not counted, reservation will expire");
      }
    } else {
      await doCommitScan(proxyUrl, commitToken);
    }

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
    // Skipped entirely for free tier - /api/verify-claim now requires Pro
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
    // ║ PRO-TIER GATING - KEEP IN SYNC WITH report.js AND content.js           ║
    // ║                                                                         ║
    // ║ NOTE: scans are NO LONGER pooled across all tiers. Pro now gets a      ║
    // ║ flat, separate daily scan allowance (see server/providers/store.js's   ║
    // ║ PRO_DAILY_LIMIT and getScanLimit) instead of sharing free tier's       ║
    // ║ scaling pool. This comment used to say otherwise - that was true      ║
    // ║ under the original design, no longer true as of that change.          ║
    // ║                                                                         ║
    // ║ What's gated below is a SEPARATE thing from scan count: which DATA     ║
    // ║ is shown per scan, not how many scans are available.                  ║
    // ║                                                                         ║
    // ║ Tier split: Pro = AI-GENERATED content only (article summary, claim    ║
    // ║ extraction, claim-vs-record verdict). VoteSmart ratings/vote history   ║
    // ║ are free for everyone, they're sourced facts, not AI output, same      ║
    // ║ category as the roll-call votes and bill links that were already      ║
    // ║ free. VoteSmart used to be Pro-gated; ungated as of this tier split,   ║
    // ║ see index.js's /api/votesmart/* route and the lookupAll call above.    ║
    // ║                                                                         ║
    // ║ This is now a DEFENSIVE FALLBACK, not the primary gate. The real       ║
    // ║ security boundary is server-side: /api/verify-claim requires Pro via  ║
    // ║ requirePro middleware in index.js, and /api/claude/extract +          ║
    // ║ /api/mistral/extract strip summary/claim fields server-side before    ║
    // ║ responding. Free tier also never calls verifyAllClaims() (skipped     ║
    // ║ above), so most of these fields should already be absent by the      ║
    // ║ time we get here. This block stays as a safety net in case any of     ║
    // ║ those upstream skips are ever removed by accident.                     ║
    // ║                                                                         ║
    // ║ The fields stripped below are advertised as "Pro features" in the      ║
    // ║ upsell cards in report.js (proFeaturesUpsellHtml) and content.js       ║
    // ║ (the upgrade prompt). If you add, remove, or rename a gated field      ║
    // ║ here, update the matching bullet list / copy in BOTH of those files    ║
    // ║ too - otherwise the upsell will advertise features that don't exist,  ║
    // ║ or silently fail to mention ones that do.                              ║
    // ╚═══════════════════════════════════════════════════════════════════════╝
    if (!isPro) {
      for (const r of records) {
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
      upgradeUrl, // free tier only needs this for the VoteSmart upsell card in content.js;
                  // harmless to include for pro tier too, just unused there.
    };
  } catch (err) {
    logger.error("background", `analysis failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

// Sends POST /api/scan/commit to finalize a reserved scan slot.
// No-ops silently if commitToken is null (scan/start was never called or failed).
// Failures are logged but not surfaced -- the reservation expires harmlessly.
async function doCommitScan(proxyUrl, commitToken) {
  if (!commitToken) return;
  try {
    const auth = await authHeaders();
    await fetch(`${proxyUrl}/api/scan/commit`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ commitToken }),
    });
    syncTier();
  } catch (e) {
    logger.warn("background", `scan/commit failed: ${e.message} - scan may not be counted`);
  }
}

logger.info("background", "service worker loaded v0.17.1");

// Initialize token and sync tier
getOrCreateToken().then((t) => {
  logger.info("background", `token: ${t.tokenId.slice(0, 8)}... tier=${t.tier}`);
  syncTier();
}).catch(() => {});