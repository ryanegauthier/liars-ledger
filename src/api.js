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
    console.log("[Liars Ledger] sponsored bills raw:", JSON.stringify(data.sponsoredLegislation?.slice(0,3), null, 2));
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
    console.log("[Liars Ledger] cosponsored bills raw:", JSON.stringify(data.cosponsoredLegislation?.slice(0,3), null, 2));
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
    console.warn("[Liars Ledger] bill search failed for keyword:", keyword, e.message);
    return [];
  }
}

// Keywords to match against bill titles for each topic
const TOPIC_TITLE_KEYWORDS = {
  "foreign policy":   ["foreign", "international", "sanctions", "diplomatic", "treaty", "nato", "ukraine", "israel", "iran", "trade agreement"],
  "labor": ["labor law", "worker", "wage", "employment", "union", "workforce", "pension", "overtime", "workplace", "workers compensation", "minimum wage"],
  "health care":      ["health", "medicare", "medicaid", "drug", "prescription", "hospital", "patient", "insurance", "opioid"],
  "climate change":   ["climate", "emission", "carbon", "clean energy", "renewable", "fossil", "environmental"],
  "immigration":      ["immigration", "immigrant", "border", "asylum", "visa", "daca", "deportat"],
  "firearms":         ["firearm", "gun", "weapon", "ammunition", "background check"],
  "taxation":         ["tax", "irs", "revenue", "deduction", "fiscal"],
  "defense":          ["defense", "military", "veteran", "armed forces", "pentagon", "weapon"],
  "education":        ["education", "school", "student", "teacher", "college", "loan", "tuition"],
  "infrastructure":   ["infrastructure", "highway", "bridge", "transit", "broadband", "rail"],
  "technology":       ["technology", "cyber", "data", "artificial intelligence", "privacy", "surveillance"],
  "trade":            ["trade", "tariff", "import", "export", "manufacturing"],
  "housing":          ["housing", "rent", "mortgage", "eviction", "homeless"],
  "criminal justice": ["criminal", "prison", "police", "sentencing", "incarceration", "justice"],
  "social security":  ["social security", "retirement", "pension", "medicaid", "welfare", "snap"],
  "elections":        ["election", "voting", "ballot", "campaign finance", "gerrymandering"],
  "federal budget":   ["budget", "appropriation", "spending", "deficit", "debt ceiling"],
  "drug policy":      ["drug", "opioid", "fentanyl", "cannabis", "marijuana", "dea"],
};

function billMatchesTopic(bill, topic) {
  // Skip amendments — they have no title
  if (!bill.title) return false;

  const title = bill.title.toLowerCase();
  const keywords = TOPIC_TITLE_KEYWORDS[topic.toLowerCase()] || [topic.toLowerCase()];
  return keywords.some(kw => title.includes(kw));
}

// --- Main: look up a politician's record on given topics ---
// Returns { politician, topics, sponsored, cosponsored, notFound }
async function lookupPoliticianOnTopics(member, topics, apiKey) {
  const result = {
    politician: member,
    topics,
    sponsored: [],   // bills they sponsored related to topics
    cosponsored: [], // bills they cosponsored related to topics
    searched: [],    // topic-matched bills from keyword search
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

  // Filter to topic-relevant bills
  for (const topic of topics) {
    const matchingSponsored = sponsored.filter(b => billMatchesTopic(b, topic));
    const matchingCosponsored = cosponsored.filter(b => billMatchesTopic(b, topic));

    result.sponsored.push(...matchingSponsored.map(b => ({ ...b, topic })));
    result.cosponsored.push(...matchingCosponsored.map(b => ({ ...b, topic })));
  }

  // Also do a direct keyword search and note if they appear
  for (const topic of topics) {
    const bills = await searchBillsByKeyword(topic, apiKey, 10);
    const relevant = bills.filter(b =>
      b.sponsors?.some(s => s.bioguideId === member.bioguide_id)
    );
    result.searched.push(...relevant.map(b => ({ ...b, topic })));
  }

  const rollCallVotes = await findMemberRollCallVotesOnTopics(member, topics, apiKey);
  result.rollCallVotes = rollCallVotes;

  console.log(
    `[Liars Ledger] ${member.full_name}: ${result.sponsored.length} sponsored, ${result.cosponsored.length} cosponsored, ${rollCallVotes.length} roll-call hits`
  );
  return result;
}

// --- Roll-call votes (Congress.gov beta house-vote / senate-vote) ---
function chamberKey(ch) {
  const s = String(ch || "").toLowerCase();
  if (s === "house" || s === "h") return "house";
  if (s === "senate" || s === "s") return "senate";
  return "";
}

function extractRollCallList(chamber, data) {
  const h = chamber === "house";
  const direct = h ? data?.houseRollCallVotes : data?.senateRollCallVotes;
  if (Array.isArray(direct) && direct.length) return direct;
  for (const v of Object.values(data || {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      const first = v[0];
      if ("rollCall" in first || "number" in first || first?.vote?.rollCall) return v;
    }
  }
  return [];
}

function extractRollNumber(vote) {
  if (vote == null) return null;
  const n = vote.rollCall ?? vote.number ?? vote?.vote?.rollCall ?? vote?.vote?.number;
  if (n === undefined || n === null) return null;
  const num = typeof n === "string" ? parseInt(n, 10) : n;
  return Number.isFinite(num) ? num : null;
}

function sessionFromVote(vote) {
  const s = vote.session ?? vote._session ?? vote?.vote?.session;
  const n = typeof s === "string" ? parseInt(s, 10) : s;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function voteSearchBlob(vote) {
  const parts = [
    vote.voteQuestion,
    vote.question,
    vote.questionText,
    vote.description,
    vote.title,
    vote.text,
    vote?.legislation?.title,
    vote?.legislation?.type && vote?.legislation?.number
      ? `${vote.legislation.type} ${vote.legislation.number}`
      : null,
    vote?.legislation?.url,
    vote?.bill?.title,
    vote?.bill?.type && vote?.bill?.number ? `${vote.bill.type} ${vote.bill.number}` : null,
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function rollCallMatchesTopics(vote, topics) {
  const hay = voteSearchBlob(vote);
  if (!hay.trim()) return false;
  for (const topic of topics) {
    const t = String(topic).toLowerCase().trim();
    if (t && hay.includes(t)) return true;
  }
  for (const topic of topics) {
    const titleKeywords = TOPIC_TITLE_KEYWORDS[topic.toLowerCase()];
    if (!titleKeywords) continue;
    if (titleKeywords.some((kw) => hay.includes(kw))) return true;
  }
  return false;
}

function extractMemberVoteRows(data) {
  const keys = ["members", "results", "voteMembers", "rollCallVoteMemberVotes", "memberVotes"];
  for (const k of keys) {
    const v = data?.[k];
    if (Array.isArray(v)) return v;
  }
  for (const val of Object.values(data || {})) {
    if (Array.isArray(val) && val.length && val[0] && typeof val[0] === "object") {
      if ("bioguideId" in val[0] || "bioguide_id" in val[0]) return val;
    }
  }
  return [];
}

function memberVotePosition(row) {
  return (
    row.voteCast ||
    row.memberVote ||
    row.vote ||
    row.position ||
    row.resultVote ||
    ""
  );
}

async function findMemberRollCallVotesOnTopics(member, topics, apiKey) {
  const ck = chamberKey(member.chamber);
  if (!ck || !topics.length) return [];

  const prefix = ck === "house" ? "house-vote" : "senate-vote";
  const congress = CURRENT_CONGRESS;
  const collected = [];

  for (const session of [1, 2]) {
    const path = `/${prefix}/${congress}/${session}?limit=150&offset=0`;
    let data;
    try {
      data = await apiFetch(path, apiKey);
    } catch (e) {
      console.warn("[Liars Ledger] roll-call list failed:", session, e.message);
      continue;
    }
    const list = extractRollCallList(ck, data);
    for (const v of list) {
      collected.push(Object.assign({}, v, { _session: session }));
    }
  }

  const candidates = collected.filter((v) => rollCallMatchesTopics(v, topics));
  candidates.sort((a, b) => {
    const da = new Date(a.updateDate || a.startDate || a.date || 0).getTime();
    const db = new Date(b.updateDate || b.startDate || b.date || 0).getTime();
    return db - da;
  });

  const seenRoll = new Set();
  const unique = [];
  for (const v of candidates) {
    const roll = extractRollNumber(v);
    const sess = sessionFromVote(v);
    if (roll == null) continue;
    const key = `${sess}:${roll}`;
    if (seenRoll.has(key)) continue;
    seenRoll.add(key);
    unique.push(v);
    if (unique.length >= 18) break;
  }

  const out = [];
  const maxFetches = 8;
  for (let i = 0; i < unique.length && out.length < maxFetches; i++) {
    const v = unique[i];
    const roll = extractRollNumber(v);
    const sess = sessionFromVote(v);
    if (roll == null) continue;
    const path = `/${prefix}/${congress}/${sess}/${roll}/members?limit=500`;
    let mdata;
    try {
      mdata = await apiFetch(path, apiKey);
    } catch (e) {
      console.warn("[Liars Ledger] roll-call members fetch failed:", e.message);
      continue;
    }
    const rows = extractMemberVoteRows(mdata);
    const hit = rows.find((r) => (r.bioguideId || r.bioguide_id) === member.bioguide_id);
    if (!hit) continue;

    const pos = String(memberVotePosition(hit) || "").trim() || "—";
    const when = v.updateDate || v.startDate || v.date || "";
    const q = v.voteQuestion || v.question || v.questionText || v.description || "";
    const leg =
      v.legislation?.type && v.legislation?.number
        ? `${v.legislation.type} ${v.legislation.number}`
        : v.bill?.type && v.bill?.number
          ? `${v.bill.type} ${v.bill.number}`
          : "";
    const voteUrl =
      typeof v.url === "string" && v.url.startsWith("http")
        ? v.url
        : `https://www.congress.gov/vote/${congress}th-congress/${ck}-session/${sess}/${roll}`;

    out.push({
      session: sess,
      rollNumber: roll,
      date: when,
      question: q,
      legislation: leg,
      position: pos,
      voteUrl,
    });
    await new Promise((r) => setTimeout(r, 120));
  }

  return out;
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
