// Liars Ledger - src/api.js
// Handles all Congress.gov API calls from the background worker.
// Uses session caching and batching to stay within free tier limits.

const BASE_URL = "https://api.congress.gov/v3";
const CURRENT_CONGRESS = 119;

// --- Session cache ---
// Keyed by cache key string, cleared when browser closes
async function cacheGet(key) {
  try {
    const result = await browser.storage.session.get(key);
    return result[key] || null;
  } catch {
    return null; // session storage not available in all contexts
  }
}

async function cacheSet(key, value) {
  try {
    await browser.storage.session.set({ [key]: value });
  } catch {
    // fail silently
  }
}

// --- Core fetch wrapper ---
async function apiFetch(path, apiKey) {
  const cacheKey = `api:${path}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    console.log("[Liars Ledger] cache hit:", path.slice(0, 60));
    return cached;
  }

  const url = `${BASE_URL}${path}&api_key=${apiKey}&format=json`;
  console.log("[Liars Ledger] fetching:", path.slice(0, 80));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Congress.gov API error: ${res.status} on ${path}`);
  }

  const data = await res.json();
  await cacheSet(cacheKey, data);
  return data;
}

// --- Get sponsored legislation for a member filtered by keyword ---
async function getMemberSponsoredBills(bioguideId, apiKey, limit = 50) {
  const path = `/member/${bioguideId}/sponsored-legislation?limit=${limit}&congress=${CURRENT_CONGRESS}`;
  try {
    const data = await apiFetch(path, apiKey);
    console.log(
      "[Liars Ledger] sponsored bills raw:",
      JSON.stringify(data.sponsoredLegislation?.slice(0, 3), null, 2),
    );
    return data.sponsoredLegislation || [];
  } catch (e) {
    console.warn("[Liars Ledger] sponsored bills fetch failed:", e.message);
    return [];
  }
}

// --- Get cosponsored legislation for a member ---
async function getMemberCosponsoredBills(bioguideId, apiKey, limit = 50) {
  const path = `/member/${bioguideId}/cosponsored-legislation?limit=${limit}&congress=${CURRENT_CONGRESS}`;
  try {
    const data = await apiFetch(path, apiKey);
    console.log(
      "[Liars Ledger] cosponsored bills raw:",
      JSON.stringify(data.cosponsoredLegislation?.slice(0, 3), null, 2),
    );
    return data.cosponsoredLegislation || [];
  } catch (e) {
    console.warn("[Liars Ledger] cosponsored bills fetch failed:", e.message);
    return [];
  }
}

// --- Search bills by keyword ---
async function searchBillsByKeyword(keyword, apiKey, limit = 10) {
  const encoded = encodeURIComponent(keyword);
  const path = `/bill?congress=${CURRENT_CONGRESS}&query=${encoded}&limit=${limit}&sort=updateDate+desc`;
  try {
    const data = await apiFetch(path, apiKey);
    return data.bills || [];
  } catch (e) {
    console.warn(
      "[Liars Ledger] bill search failed for keyword:",
      keyword,
      e.message,
    );
    return [];
  }
}

// --- Main: look up a politician's record on given topics ---
// Returns { politician, topics, sponsored, cosponsored, notFound }
async function lookupPoliticianOnTopics(member, topics, apiKey) {
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
    getMemberSponsoredBills(member.bioguide_id, apiKey),
    getMemberCosponsoredBills(member.bioguide_id, apiKey),
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

    // Pass 2: direct LLM search term substring match
    for (const term of llmSearchTerms) {
      if (term.length > 3 && titleLower.includes(term)) return true;
    }

    return false;
  }

  // Filter and dedup by URL/number
  const seenBillKeys = new Set();

  function addIfNew(bill, arr, tag) {
    if (!bill.title) return; // skip untitled amendments
    const key = bill.url || `${bill.type}${bill.number}`;
    if (seenBillKeys.has(key)) return;
    seenBillKeys.add(key);
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

  for (const term of searchTermsToQuery) {
    const bills = await searchBillsByKeyword(term, apiKey, 10);
    const relevant = bills.filter((b) =>
      b.sponsors?.some((s) => s.bioguideId === member.bioguide_id),
    );
    for (const b of relevant) addIfNew(b, result.searched, term);
  }

  // Fetch GovTrack roll-call votes + VoteSmart data in parallel
  const vsEnabled =
    typeof lookupVoteSmart === "function" &&
    typeof CONFIG !== "undefined" &&
    CONFIG.PROXY_URL;

  const [rollCallVotes, vsData] = await Promise.all([
    findMemberRollCallVotesOnTopics(member, topics, apiKey),
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

  console.log(
    `[Liars Ledger] ${member.full_name}: ${result.sponsored.length} sponsored, ` +
      `${result.cosponsored.length} cosponsored, ${rollCallVotes.length} roll-call hits, ` +
      `${result.voteSmartRatings.length} VS ratings, ${result.voteSmartVotes.length} VS votes`,
  );
  return result;
}

// --- Roll-call votes via GovTrack ---
// Congress.gov senate-vote / house-vote endpoints return 404 for the 119th
// Congress — they are in beta and not yet available. GovTrack is free,
// requires no API key, and has full vote history for both chambers.
// GovTrack API: https://www.govtrack.us/developers/api

const GOVTRACK_BASE = "https://www.govtrack.us/api/v2";

async function findMemberRollCallVotesOnTopics(member, topics, apiKey) {
  if (!topics.length) return [];

  // Step 1: resolve bioguide_id → GovTrack person ID (cached)
  const govtrackId = await resolveGovTrackId(member.bioguide_id);
  if (!govtrackId) {
    console.warn(
      "[Liars Ledger] GovTrack ID not found for",
      member.bioguide_id,
    );
    return [];
  }

  // Step 2: fetch recent votes cast by this person
  const cacheKey = `govtrack:voter:${govtrackId}`;
  let voterData = await cacheGet(cacheKey);
  if (!voterData) {
    try {
      const url = `${GOVTRACK_BASE}/vote_voter?person=${govtrackId}&limit=50&order_by=-created`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GovTrack HTTP ${res.status}`);
      voterData = await res.json();
      await cacheSet(cacheKey, voterData);
    } catch (e) {
      console.warn("[Liars Ledger] GovTrack voter fetch failed:", e.message);
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
    const url =
      "https://unitedstates.github.io/congress-legislators/legislators-current.json";
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
    console.warn("[Liars Ledger] GovTrack ID resolution failed:", e.message);
    return null;
  }
}

// --- Batch lookup for all resolved politicians ---
// memberJobs: [{ member, topics }, ...] — topics differ per member when using claim extraction
async function lookupAll(memberJobs, apiKey) {
  const results = [];
  for (const { member, topics } of memberJobs) {
    const result = await lookupPoliticianOnTopics(member, topics, apiKey);
    results.push(result);
    await new Promise((r) => setTimeout(r, 150));
  }
  return results;
}
