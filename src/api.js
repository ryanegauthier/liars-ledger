// Liars Ledger - src/api.js
// Handles all Congress.gov API calls from the background worker.
// Uses session caching and batching to stay within free tier limits.

const CURRENT_CONGRESS = 119;

function congressProxyBase() {
  if (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL) {
    return CONFIG.PROXY_URL + "/api/congress";
  }
  return "https://api.liarsledger.com/api/congress";
}

// GovTrack roll-call votes and the congress-legislators dataset are also routed
// through the proxy so the extension never contacts those hosts directly.
function govtrackProxyBase() {
  if (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL) {
    return CONFIG.PROXY_URL + "/api/govtrack";
  }
  return "https://api.liarsledger.com/api/govtrack";
}

function legislatorsProxyUrl() {
  if (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL) {
    return CONFIG.PROXY_URL + "/api/legislators";
  }
  return "https://api.liarsledger.com/api/legislators";
}

async function cacheGet(key) {
  try {
    const result = await browser.storage.session.get(key);
    return result[key] || null;
  } catch {
    return null;
  }
}

async function cacheSet(key, value) {
  // safeSessionSet is defined in cache-maintenance.js, which loads before
  // this file via importScripts in background.js.
  await safeSessionSet(key, value);
}

async function apiFetch(path) {
  const cacheKey = `api:${path}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    logger.info("api", `cache hit: ${path.slice(0, 60)}`);
    return cached;
  }
 
  const url = `${congressProxyBase()}${path}`;
  logger.info("api", `fetching: ${path.slice(0, 80)}`);
 
  const auth = await authHeaders();
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error(`Congress proxy error: ${res.status} on ${path}`);
 
  const data = await res.json();
  await cacheSet(cacheKey, data);
  return data;
}


// --- Get sponsored legislation for a member ---
async function getMemberSponsoredBills(bioguideId, limit = 100) {
  const path = `/member/${bioguideId}/sponsored-legislation?limit=${limit}`;
  try {
    const data = await apiFetch(path);
    return { data: data.sponsoredLegislation || [], errored: false };
  } catch (e) {
    logger.warn("api", `sponsored bills fetch failed: ${e.message}`);
    return { data: [], errored: true };
  }
}

// --- Get cosponsored legislation for a member ---
async function getMemberCosponsoredBills(bioguideId, limit = 100) {
  const path = `/member/${bioguideId}/cosponsored-legislation?limit=${limit}`;
  try {
    const data = await apiFetch(path);
    return { data: data.cosponsoredLegislation || [], errored: false };
  } catch (e) {
    logger.warn("api", `cosponsored bills fetch failed: ${e.message}`);
    return { data: [], errored: true };
  }
}

// --- Search bills by keyword ---
async function searchBillsByKeyword(keyword, limit = 10) {
  const encoded = encodeURIComponent(keyword);
  const path = `/bill?query=${encoded}&limit=${limit}&sort=updateDate+desc`;
  try {
    const data = await apiFetch(path);
    return data.bills || [];
  } catch (e) {
    logger.warn(
      "api",
      `bill search failed for keyword: ${keyword} - ${e.message}`,
    );
    return [];
  }
}

// --- Main: look up a politician's record on given topics ---
// Returns { politician, topics, sponsored, cosponsored, notFound }
async function lookupPoliticianOnTopics(member, topics, options = {}) {
  const result = {
    politician: member,
    topics,
    sponsored: [], // bills they sponsored related to topics
    cosponsored: [], // bills they cosponsored related to topics
    searched: [], // topic-matched bills from keyword search
    notFound: topics.length === 0,
  };

  if (topics.length === 0) {
    result.rollCallVotes = [];
    return result;
  }

  // Fetch sponsored + cosponsored in parallel
  const [sponsoredResult, cosponsoredResult] = await Promise.all([
    getMemberSponsoredBills(member.bioguide_id),
    getMemberCosponsoredBills(member.bioguide_id),
  ]);
  const sponsored   = sponsoredResult.data;
  const cosponsored = cosponsoredResult.data;
  const congressErrored = sponsoredResult.errored && cosponsoredResult.errored;

  // --- Bill relevance check ---
  // Two-pass matching:
  // Pass 1: billMatchesTopic() - existing keyword category matching (19 topics)
  // Pass 2: direct title substring match against LLM search_terms
  // This fixes the core 0.9.0 issue: LLM returns specific search terms like
  // "voting rights" or "budget reconciliation" but billMatchesTopic() only
  // knows about broad predefined categories and misses them.

  // Extract LLM search_terms from the figure attached to this member
  // They live on member._llm_search_terms if background.js passes them through,
  // or we fall back to topics only.
  const llmSearchTerms = (member._llm_search_terms || [])
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);

  function billMatchesAny(bill) {
    if (!bill.title) return false; // skip amendments without titles
    const titleLower = bill.title.toLowerCase();

    // Pass 1: topic keyword categories
    for (const topic of topics) {
      if (billMatchesTopic(bill, topic)) return true;
    }

    // Pass 2: LLM search terms - word-level matching
    for (const term of llmSearchTerms) {
      if (term.length <= 3) continue;
      const words = term.split(/\s+/).filter((w) => w.length > 2);
      if (words.length > 0 && words.every((w) => titleLower.includes(w)))
        return true;
    }

    return false;
  }

  // Filter and dedup by URL/number
  const CEREMONIAL_PATTERNS = [
    "honoring the life",
    "honoring the legacy",
    "congratulating",
    "expressing the thanks",
    "expressing the sense of the",
    "recognizing the contributions",
    "commemorating",
    "designating",
    "national day of",
  ];
  
  const seenBillKeys = new Set();

  function addIfNew(bill, arr, tag) {
    if (!bill.title) return;
    const titleLower = bill.title.toLowerCase();
    if (CEREMONIAL_PATTERNS.some((p) => titleLower.includes(p))) return;
    const key = bill.url || `${bill.type}${bill.number}`;
    const titleKey = titleLower.slice(0, 80);
    if (seenBillKeys.has(key) || seenBillKeys.has(titleKey)) return;
    seenBillKeys.add(key);
    seenBillKeys.add(titleKey);
    arr.push({ ...bill, topic: tag });
  }

  for (const bill of sponsored) {
    if (billMatchesAny(bill)) addIfNew(bill, result.sponsored, "sponsored");
  }
  for (const bill of cosponsored) {
    if (billMatchesAny(bill)) addIfNew(bill, result.cosponsored, "cosponsored");
  }

  // Keyword search for "Related" bills removed — broad topic names produce too
  // many false positives and the results add more noise than signal for users.

  // Fetch GovTrack roll-call votes + VoteSmart data in parallel
  const vsEnabled =
    !options.skipVoteSmart &&
    typeof lookupVoteSmart === "function" &&
    typeof CONFIG !== "undefined" &&
    CONFIG.PROXY_URL;

  const [rollCallResult, vsData] = await Promise.all([
    findMemberRollCallVotesOnTopics(member, topics),
    vsEnabled
      ? lookupVoteSmart(member, [
          ...new Set([...(member._main_topics || []), ...topics]),
        ])
      : Promise.resolve(null),
  ]);

  result.rollCallVotes    = rollCallResult.data;
  result._sources_errored = congressErrored && rollCallResult.errored;

  // _govtrack_errored (v0.17.2+): true when GovTrack alone failed for this
  // member, regardless of whether congress.gov succeeded. The existing
  // _sources_errored above is an AND of both - it only trips when BOTH
  // congress.gov AND GovTrack fail for a member, so a lone GovTrack 502
  // (congress.gov succeeding fine) previously produced an incomplete
  // report - a whole missing "Roll-Call Votes" section - with no skip-
  // commit signal at all. Kept separate from _sources_errored rather than
  // loosening that AND to an OR, since _sources_errored's stricter
  // all-members-fully-failed meaning is used elsewhere (background.js's
  // allSourcesFailed check) and shouldn't change shape. This field stands
  // on its own and is checked alongside _votesmart_partial in
  // background.js's "any politician had a degraded result" rule.
  result._govtrack_errored = rollCallResult.errored;

  // _votesmart_partial (v0.17.2+): true when VoteSmart's lookup had to
  // salvage results from a pagination failure (429/502 even after retries)
  // - see votesmart.js's fetchAllVsPages and resolveVoteSmartId. A partial
  // result may be silently missing a real match. Kept as its own field
  // rather than folded into _sources_errored, since the two represent
  // different severities (errored = nothing came back at all; partial =
  // some data is missing but the lookup didn't fully fail) - but
  // background.js's scan-charging check treats either one as a reason not
  // to charge the user. false (not undefined) when VoteSmart was skipped
  // entirely (vsEnabled=false) - skipping isn't a failure, so it shouldn't
  // trigger a free rescan on its own.
  result._votesmart_partial = vsData?.partial || false;

  if (vsData) {
    result.voteSmartId = vsData.candidateId;
    result.voteSmartRatings = vsData.ratings || [];
    result.voteSmartVotes = vsData.votes || [];
  } else {
    result.voteSmartRatings = [];
    result.voteSmartVotes = [];
  }

  logger.info(
    "api",
    `${member.full_name}: ${result.sponsored.length} sponsored, ` +
      `${result.cosponsored.length} cosponsored, ${result.rollCallVotes.length} roll-call hits, ` +
      `${result.voteSmartRatings.length} VS ratings, ${result.voteSmartVotes.length} VS votes`,
  );
  return result;
}

async function findMemberRollCallVotesOnTopics(member, topics) {
  if (!topics.length) return { data: [], errored: false };

  const govtrackId = await resolveGovTrackId(member.bioguide_id);
  if (!govtrackId) {
    logger.warn("api", `GovTrack ID not found for ${member.bioguide_id}`);
    return { data: [], errored: true };
  }

  const cacheKey = `api:govtrack:voter:${govtrackId}`;
  let voterData = await cacheGet(cacheKey);
  if (!voterData) {
    try {
      const url = `${govtrackProxyBase()}/vote_voter?person=${govtrackId}&limit=50&order_by=-created`;
      const auth = await authHeaders();
      const res = await fetch(url, { headers: auth });
      if (!res.ok) throw new Error(`GovTrack HTTP ${res.status}`);
      voterData = await res.json();
      await cacheSet(cacheKey, voterData);
    } catch (e) {
      logger.warn("api", `GovTrack voter fetch failed: ${e.message}`);
      return { data: [], errored: true };
    }
  }

  const voteEntries = voterData?.objects || [];
  if (!voteEntries.length) return { data: [], errored: false };

  // Filter to topic-relevant votes
  const topicsLower = topics.map((t) => t.toLowerCase());

  const matched = voteEntries.filter((entry) => {
    const vote = entry.vote || {};
    const blob = [
      vote.question || "",
      vote.description || "",
      vote.related_bill?.title || "",
    ]
      .join(" ")
      .toLowerCase();

    return topicsLower.some((topic) => {
      if (blob.includes(topic)) return true;
      const keywords =
        (typeof TOPIC_TITLE_KEYWORDS !== "undefined" &&
          TOPIC_TITLE_KEYWORDS[topic]) ||
        [];
      return keywords.some((kw) => blob.includes(kw));
    });
  });

  // Shape to match rollCallVotes format used by content.js
  const data = matched.slice(0, 8).map((entry) => {
    const vote = entry.vote || {};
    const pos = entry.option?.value || entry.vote_type || "-";
    const congress = vote.congress || CURRENT_CONGRESS;
    const session = vote.session || 1;
    const rollNum = vote.number || null;
    const chamberPrefix = vote.chamber === "s" ? "s" : "h";
    const voteUrl = rollNum
      ? `https://www.govtrack.us/congress/votes/${congress}-${session}/${chamberPrefix}${rollNum}`
      : null;

    return {
      session,
      rollNumber: rollNum,
      date: vote.created ? vote.created.slice(0, 10) : "",
      question: vote.question || vote.description || "Roll call vote",
      legislation: vote.related_bill
        ? `${(vote.related_bill.bill_type || "").toUpperCase()} ${vote.related_bill.number || ""}`.trim()
        : "",
      position: normalizeVotePosition(pos),
      voteUrl,
    };
  });

  return { data, errored: false };
}

function normalizeVotePosition(raw) {
  const map = {
    Yea: "Yea",
    Yes: "Yea",
    "+": "Yea",
    Nay: "Nay",
    No: "Nay",
    "-": "Nay",
    P: "Present",
    "Not Voting": "Not Voting",
    Abstain: "Not Voting",
  };
  return map[raw] || raw || "-";
}

async function resolveGovTrackId(bioguideId) {
  if (!bioguideId) return null;

  const cacheKey = `api:govtrack:id:${bioguideId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = legislatorsProxyUrl();
    const cacheKeyAll = "api:govtrack:legislators_map";
    let map = await cacheGet(cacheKeyAll);

    if (!map) {
      // Found via live testing: this fetch had no Authorization header at
      // all, unlike apiFetch() and findMemberRollCallVotesOnTopics' GovTrack
      // call above, both of which correctly attach authHeaders(). If
      // /api/legislators requires requireToken server-side (confirmed via
      // direct curl test — unauthenticated request 401s, authenticated
      // succeeds), this call has been silently failing this whole time,
      // independent of any scan-token/hardening work this session — it's a
      // pre-existing gap, not a regression from anything recent.
      const auth = await authHeaders();
      const res = await fetch(url, { headers: auth });
      if (!res.ok) throw new Error(`legislators fetch HTTP ${res.status}`);
      const data = await res.json();
      map = {};
      for (const leg of data) {
        if (leg.id?.bioguide && leg.id?.govtrack) {
          map[leg.id.bioguide] = leg.id.govtrack;
        }
      }
      await cacheSet(cacheKeyAll, map);
    }

    const id = map[bioguideId] || null;
    if (id) await cacheSet(cacheKey, id);
    return id;
  } catch (e) {
    logger.warn("api", `GovTrack ID resolution failed: ${e.message}`);
    return null;
  }
}

// --- Parallel lookup for all resolved politicians ---
async function lookupAll(memberJobs, options = {}) {
  const results = await Promise.all(
    memberJobs.map(({ member, topics }) => lookupPoliticianOnTopics(member, topics, options))
  );
  return results;
}