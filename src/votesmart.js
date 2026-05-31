// Liars Ledger - src/votesmart.js
// VoteSmart v2 API client.
// All calls go through the backend proxy — VoteSmart is CORS-blocked from browsers.
//
// Exports:
//   resolveVoteSmartId(member)             → candidateId or null
//   getVoteSmartRatings(candidateId)       → [{ sigId, sigName, rating, ratingText, year, categories }]
//   getVoteSmartVotes(candidateId, topics) → [{ billNumber, title, vote, date, stage, categories }]
//   lookupVoteSmart(member, topics)        → { candidateId, ratings, votes }

// --- State name → abbreviation map ---
const STATE_ABBR = {
  "Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA",
  "Colorado":"CO","Connecticut":"CT","Delaware":"DE","Florida":"FL","Georgia":"GA",
  "Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA",
  "Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD",
  "Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS",
  "Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH",
  "New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC",
  "North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA",
  "Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN",
  "Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA",
  "West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY","District of Columbia":"DC"
};

// --- VoteSmart office IDs ---
const VS_SENATE_OFFICE = 6;
const VS_HOUSE_OFFICE  = 5;

// --- Key SIG IDs → display names ---
// SIG = Special Interest Group. These are the most recognizable for a political fact-checker.
const SIG_NAMES = {
  1034: "NRA",                          // National Rifle Association
  5:    "ACLU",                         // American Civil Liberties Union
  2:    "AFL-CIO",                      // American Federation of Labor
  310:  "Club for Growth",              // Fiscal conservative
  125:  "Human Rights Campaign",        // LGBTQ rights
  130:  "Sierra Club",                  // Environment
  674:  "Humane Society",              // Animal welfare
  1110: "Veterans of Foreign Wars",     // VFW
  599:  "NORML",                        // Marijuana policy
  188:  "Planned Parenthood",           // Reproductive rights
  1627: "American Family Association",  // Social conservative
  174:  "US Chamber of Commerce",       // Business
  94:   "AFL-CIO COPE",                 // Labor political
  32:   "Americans for Democratic Action", // Liberal
  1:    "Americans for Tax Reform",     // Fiscal conservative
};

const KEY_SIG_IDS = Object.keys(SIG_NAMES).map(Number);

// --- VoteSmart category → our topic keyword map ---
// Broadens vote matching beyond exact string match
const VS_CATEGORY_TOPICS = {
  "Defense":              ["defense", "military", "national security", "foreign policy"],
  "Foreign Affairs":      ["foreign policy", "trade", "immigration"],
  "Finance and Banking":  ["taxation", "federal budget", "economy"],
  "Economy and Fiscal":   ["taxation", "federal budget", "trade"],
  "Health Insurance":     ["health care"],
  "Government Budget":    ["federal budget"],
  "Environment":          ["climate change", "energy"],
  "Energy":               ["climate change", "energy", "technology"],
  "Labor":                ["labor"],
  "Immigration":          ["immigration"],
  "Civil Rights":         ["elections", "criminal justice"],
  "Elections":            ["elections"],
  "Education":            ["education"],
  "Technology":           ["technology"],
  "Social Security":      ["social security"],
  "Housing":              ["housing", "infrastructure"],
};

// --- Proxy base ---
function proxyBase() {
  if (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL) {
    return CONFIG.PROXY_URL + "/api/votesmart";
  }
  return "https://api.liarsledger.com/api/votesmart";
}

// --- Session cache ---
async function vsGet(key) {
  try {
    const result = await browser.storage.session.get(key);
    return result[key] || null;
  } catch { return null; }
}

async function vsSet(key, value) {
  try { await browser.storage.session.set({ [key]: value }); }
  catch {}
}

// --- Fetch wrapper with caching ---
async function vsFetch(path) {
  const cacheKey = `vs:${path}`;
  const cached = await vsGet(cacheKey);
  if (cached) return cached;

  const url = `${proxyBase()}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VoteSmart proxy ${res.status} on ${path}`);
  const data = await res.json();
  await vsSet(cacheKey, data);
  return data;
}

// --- Resolve member → VoteSmart candidateId ---
async function resolveVoteSmartId(member) {
  if (!member?.last_name) return null;

  const cacheKey = `vs:id:${member.bioguide_id}`;
  const cached = await vsGet(cacheKey);
  if (cached) return cached;

  try {
    const data = await vsFetch(`/v1/officials/by-lastname?lastName=${encodeURIComponent(member.last_name)}`);
    const officials = data?.data || [];

    const targetOffice = member.chamber === "senate" ? VS_SENATE_OFFICE : VS_HOUSE_OFFICE;
    const firstName    = (member.first_name || "").toLowerCase();
    const rawState     = member.state_id || member.state || "";
    const state        = STATE_ABBR[rawState] || rawState.toUpperCase();

    // Pass 1: office + state + first/nick name
    let match = officials.find(o =>
      o.officeId === targetOffice &&
      o.officeStateId?.toUpperCase() === state &&
      (o.firstName?.toLowerCase() === firstName || o.nickName?.toLowerCase() === firstName)
    );

    // Pass 2: office + state only
    if (!match) {
      match = officials.find(o =>
        o.officeId === targetOffice &&
        o.officeStateId?.toUpperCase() === state
      );
    }

    const id = match?.id || null;
    if (id) await vsSet(cacheKey, id);
    return id;
  } catch (e) {
    console.warn("[Liars Ledger] VoteSmart ID resolution failed:", e.message);
    return null;
  }
}

// --- Get interest group ratings ---
async function getVoteSmartRatings(candidateId) {
  if (!candidateId) return [];

  try {
    const data    = await vsFetch(`/v1/ratings/by-candidate?candidateId=${candidateId}`);
    const ratings = data?.data || [];

    // One entry per SIG, most recent year (data sorted desc by timespan)
    const bySig = new Map();
    for (const r of ratings) {
      const sigId = r.id;
      if (!KEY_SIG_IDS.includes(sigId)) continue;
      if (!bySig.has(sigId)) {
        bySig.set(sigId, {
          sigId,
          sigName:    SIG_NAMES[sigId] || `SIG ${sigId}`,
          ratingText: r.ratingText || "",
          rating:     parseInt(r.rating, 10),
          year:       r.timespan || "",
          categories: (r.categories || []).map(c => c.name),
        });
      }
    }

    return [...bySig.values()].sort((a, b) => a.sigName.localeCompare(b.sigName));
  } catch (e) {
    console.warn("[Liars Ledger] VoteSmart ratings failed:", e.message);
    return [];
  }
}

// --- Get vote history filtered by topics ---
async function getVoteSmartVotes(candidateId, topics) {
  if (!candidateId || !topics?.length) return [];
  console.log(`[VS votes] candidateId=${candidateId}, topics=`, topics);
  try {
    const data  = await vsFetch(`/v2/votes/bills/by-official?candidateId=${candidateId}`);
    const votes = data?.data || [];

    const topicsLower = topics.map(t => t.toLowerCase());

    const matched = votes.filter(v => {
      const voteCategories = (v.categories || []).map(c => c.name);

      // Direct title/category match against topics
      const blob = [v.title || "", ...voteCategories].join(" ").toLowerCase();
      if (topicsLower.some(topic => blob.includes(topic))) return true;

      // Category → topic expansion match
      for (const cat of voteCategories) {
        const mappedTopics = VS_CATEGORY_TOPICS[cat] || [];
        if (mappedTopics.some(mt => topicsLower.includes(mt))) return true;
      }

      return false;
    });

    return matched.slice(0, 10).map(v => ({
      billNumber: v.billNumber || "",
      title:      v.title || "",
      vote:       normalizeVsVote(v.vote),
      date:       v.statusDate || "",
      stage:      v.stage || "",
      categories: (v.categories || []).map(c => c.name),
    }));
  } catch (e) {
    console.warn("[Liars Ledger] VoteSmart votes failed:", e.message);
    return [];
  }
}

function normalizeVsVote(raw) {
  const map = { "Y": "Yea", "N": "Nay", "-": "Not Voting", "A": "Abstain" };
  return map[raw] || raw || "—";
}

// --- Main entry point ---
async function lookupVoteSmart(member, topics) {
  const candidateId = await resolveVoteSmartId(member);
  if (!candidateId) {
    console.warn("[Liars Ledger] VoteSmart: no candidate ID for", member.full_name);
    return { candidateId: null, ratings: [], votes: [] };
  }

  console.log(`[Liars Ledger] VoteSmart: resolved ${member.full_name} → candidateId=${candidateId}`);

  const [ratings, votes] = await Promise.all([
    getVoteSmartRatings(candidateId),
    getVoteSmartVotes(candidateId, topics),
  ]);

  console.log(`[Liars Ledger] VoteSmart: ${member.full_name} — ${ratings.length} ratings, ${votes.length} votes`);
  return { candidateId, ratings, votes };
}