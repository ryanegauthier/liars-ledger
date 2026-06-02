// Liars Ledger - src/topic-match.js
// Bill title and roll-call vote text matching against policy topics.

const TOPIC_TITLE_KEYWORDS = {
  "foreign policy":   ["foreign", "international", "sanctions", "diplomatic", "treaty", "nato", "ukraine", "israel", "iran", "trade agreement"],
  "labor": ["labor law", "worker", "wage", "employment", "union", "workforce", "pension", "overtime", "workplace", "workers compensation", "minimum wage"],
  "health care":      ["health", "medicare", "medicaid", "drug", "prescription", "hospital", "patient", "insurance", "opioid"],
  "climate change":   ["climate", "emission", "carbon", "clean energy", "renewable", "fossil", "environmental"],
  "immigration":      ["immigration", "immigrant", "border", "asylum", "visa", "daca", "deportat"],
  "firearms":         ["firearm", "gun", "weapon", "ammunition", "background check", "atf", "second amendment", "nra"],
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
  if (!bill.title) return false;
  const title = bill.title.toLowerCase();
  const keywords = TOPIC_TITLE_KEYWORDS[topic.toLowerCase()];
  if (keywords) return keywords.some((kw) => title.includes(kw));

  // LLM search terms — check that all significant words appear in the title
  const words = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => title.includes(w));
}

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
  return row.voteCast || row.memberVote || row.vote || row.position || row.resultVote || "";
}

function mergeTopicsForMember(fig, mainTopicsGlobal, fallbackTopics) {
  const figSearchTerms = fig?.search_terms || [];
  const llmTopics = [...figSearchTerms, ...mainTopicsGlobal].filter(Boolean);
  // When the LLM provided specific terms, use only those.
  // Mixing in broad keyword fallback (taxation, defense, etc.) produces
  // too many irrelevant bill matches.
  return [...new Set(llmTopics.length > 0 ? llmTopics : fallbackTopics)];
}
