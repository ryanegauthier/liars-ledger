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
  try {
    await browser.storage.session.set({ [key]: value });
  } catch {}
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

  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Congress proxy error: ${res.status} on ${path}`);

  const data = await res.json();
  await cacheSet(cacheKey, data);
  return data;
}

// --- Get sponsored legislation for a member ---
async function getMemberSponsoredBills(bioguideId, limit = 250) {
  const path = `/member/${bioguideId}/sponsored-legislation?limit=${limit}`;
  try {
    const data = await apiFetch(path);
    return data.sponsoredLegislation || [];
  } catch (e) {
    logger.warn("api", `sponsored bills fetch failed: ${e.message}`);
    return [];
  }
}

// --- Get cosponsored legislation for a member ---
async function getMemberCosponsoredBills(bioguideId, limit = 250) {
  const path = `/member/${bioguideId}/cosponsored-legislation?limit=${limit}`;
  try {
    const data = await apiFetch(path);
    return data.cosponsoredLegislation || [];
  } catch (e) {
    logger.warn("api", `cosponsored bills fetch failed: ${e.message}`);
    return [];
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
      `bill search failed for keyword: ${keyword} — ${e.message}`,
    );
    return [];
  }
}

// --- Main: look up a politician's record on given topics ---
// Returns { politician, topics, sponsored, cosponsored, notFound }
async function lookupPoliticianOnTopics(member, topics) {
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
  const [sponsored, cosponsored] = await Promise.all([
    getMemberSponsoredBills(member.bioguide_id),
    getMemberCosponsoredBills(member.bioguide_id),
  ]);

  // --- Bill relevance check ---
  // Two-pass matching:
  // Pass 1: billMatchesTopic() — existing keyword category matching (19 topics)
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

    // Pass 2: LLM search terms — word-level matching
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

  // Direct keyword search — use a subset of most specific LLM terms
  // to avoid too many API calls; cap at 6 most distinctive terms
  const searchTermsToQuery = [
    ...new Set([...llmSearchTerms.slice(0, 4), ...topics.slice(0, 2)]),
  ].slice(0, 6);

  // Parallel keyword searches — all independent, safe to batch
  const searchResults = await Promise.all(
    searchTermsToQuery.map((term) => searchBillsByKeyword(term, 10)),
  );
  searchTermsToQuery.forEach((term, i) => {
    for (const b of searchResults[i]) addIfNew(b, result.searched, term);
  });

  // Fetch GovTrack roll-call votes + VoteSmart data in parallel
  const vsEnabled =
    typeof lookupVoteSmart === "function" &&
    typeof CONFIG !== "undefined" &&
    CONFIG.PROXY_URL;

  const [rollCallVotes, vsData] = await Promise.all([
    findMemberRollCallVotesOnTopics(member, topics),
    vsEnabled
      ? lookupVoteSmart(member, [
          ...new Set([...(member._main_topics || []), ...topics]),
        ])
      : Promise.resolve(null),
  ]);

  result.rollCallVotes = rollCallVotes;

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
      `${result.cosponsored.length} cosponsored, ${rollCallVotes.length} roll-call hits, ` +
      `${result.voteSmartRatings.length} VS ratings, ${result.voteSmartVotes.length} VS votes`,
  );
  return result;
}

async function findMemberRollCallVotesOnTopics(member, topics) {
  if (!topics.length) return [];

  const govtrackId = await resolveGovTrackId(member.bioguide_id);
  if (!govtrackId) {
    logger.warn("api", `GovTrack ID not found for ${member.bioguide_id}`);
    return [];
  }

  const cacheKey = `govtrack:voter:${govtrackId}`;
  let voterData = await cacheGet(cacheKey);
  if (!voterData) {
    try {
      const url = `${govtrackProxyBase()}/vote_voter?person=${govtrackId}&limit=50&order_by=-created`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GovTrack HTTP ${res.status}`);
      voterData = await res.json();
      await cacheSet(cacheKey, voterData);
    } catch (e) {
      logger.warn("api", `GovTrack voter fetch failed: ${e.message}`);
      return [];
    }
  }

  const voteEntries = voterData?.objects || [];
  if (!voteEntries.length) return [];

  // Step 3: filter to topic-relevant votes
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

  // Step 4: shape to match existing rollCallVotes format used by content.js
  return matched.slice(0, 8).map((entry) => {
    const vote = entry.vote || {};
    const pos = entry.option?.value || entry.vote_type || "—";
    const chamber = vote.chamber === "s" ? "senate" : "house";
    const congress = vote.congress || CURRENT_CONGRESS;
    const session = vote.session || 1;
    const rollNum = vote.number || null;

    const voteUrl = rollNum
      ? `https://www.govtrack.us/congress/votes/${congress}-${session}/${chamber}${rollNum}`
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
  return map[raw] || raw || "—";
}

async function resolveGovTrackId(bioguideId) {
  if (!bioguideId) return null;

  const cacheKey = `govtrack:id:${bioguideId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = legislatorsProxyUrl();
    const cacheKeyAll = "govtrack:legislators_map";
    let map = await cacheGet(cacheKeyAll);

    if (!map) {
      const res = await fetch(url);
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

// --- Batch lookup for all resolved politicians ---
async function lookupAll(memberJobs) {
  const results = [];
  for (const { member, topics } of memberJobs) {
    const result = await lookupPoliticianOnTopics(member, topics);
    results.push(result);
    await new Promise((r) => setTimeout(r, 150));
  }
  return results;
}
