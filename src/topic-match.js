// Liars Ledger - src/topic-match.js
// Bill title and roll-call vote text matching against policy topics.

// "retirement" deliberately excluded - too broad, matches unrelated
// pension bills (public safety employee retirement timing, military
// retirement pay, private 401k rules) that have nothing to do with
// Social Security policy specifically. Confirmed live: "Protecting
// Public Safety Employees' Timely Retirement Act" matched here and had
// no connection to the article being fact-checked.
const TOPIC_TITLE_KEYWORDS = {
  "foreign policy":   ["foreign policy", "foreign affairs", "foreign relations", "international relations", "diplomatic", "treaty", "nato", "ukraine", "israel", "iran", "trade agreement", "iron dome", "security assistance", "foreign aid", "supplemental appropriation", "arms sale", "weapons transfer", "ceasefire", "humanitarian aid", "peacekeeping", "embassy", "ambassador"],
  "israel":           ["israel", "iron dome", "hamas", "hezbollah", "gaza", "west bank", "palestinian", "antisemit", "two-state", "abraham accords", "israeli", "jerusalem", "golan"],
  "china":            ["china", "chinese", "taiwan", "tiktok", "huawei", "uyghur", "hong kong", "indo-pacific", "pacific deterrence", "chips act", "semiconductor"],
  "ukraine":          ["ukraine", "ukrainian", "kyiv", "crimea", "zelensky", "russian aggression", "lend-lease"],
  "russia":           ["russia", "russian", "kremlin", "putin", "magnitsky", "oligarch"],
  "labor":            ["labor law", "worker rights", "minimum wage", "labor union", "workforce", "pension", "overtime", "workplace safety", "workers compensation", "collective bargaining", "gig economy", "paid leave", "fair labor"],
  "health care":      ["health care", "healthcare", "medicare", "medicaid", "prescription drug", "hospital", "patient", "health insurance", "opioid", "mental health", "public health", "affordable care", "vaccine", "telehealth", "nursing home"],
  "climate change":   ["climate", "emission", "carbon", "clean energy", "renewable", "fossil fuel", "greenhouse", "paris agreement", "methane", "solar energy", "wind energy", "electric vehicle"],
  "energy":           ["energy policy", "oil and gas", "fracking", "lng", "pipeline", "nuclear power", "solar energy", "wind energy", "drilling", "petroleum", "power grid", "hydroelectric", "energy independence"],
  "immigration":      ["immigration", "immigrant", "border security", "border wall", "asylum", "visa", "daca", "deportat", "refugee", "citizenship", "migrant", "undocumented"],
  "firearms":         ["firearm", "gun control", "gun violence", "gun safety", "ammunition", "background check", "second amendment", "concealed carry", "assault weapon", "red flag", "bump stock"],
  "taxation":         ["tax cut", "tax reform", "tax credit", "tax rate", "taxation", "internal revenue", "estate tax", "capital gains", "corporate tax", "income tax", "tax deduction", "tax relief"],
  "defense":          ["defense", "military", "veteran", "armed forces", "pentagon", "national security", "department of defense", "army", "navy", "air force", "marine corps", "coast guard", "missile", "drone", "cybersecurity", "national guard"],
  "education":        ["education", "school", "student loan", "student debt", "teacher", "college", "tuition", "pell grant", "title ix", "charter school", "head start", "higher education", "university"],
  "infrastructure":   ["infrastructure", "highway", "bridge", "transit", "broadband", "railroad", "amtrak", "water system", "airport", "public works", "road safety"],
  "technology":       ["artificial intelligence", "data privacy", "surveillance", "social media", "big tech", "antitrust", "encryption", "net neutrality", "data center", "quantum computing", "cybersecurity", "online privacy"],
  "trade":            ["trade agreement", "tariff", "import duty", "export control", "manufacturing", "usmca", "trade deficit", "supply chain", "trade war"],
  "housing":          ["housing", "affordable housing", "rent", "mortgage", "eviction", "homeless", "section 8", "zoning", "tenant", "foreclosure", "first-time home"],
  "criminal justice": ["criminal justice", "prison reform", "sentencing", "incarceration", "bail reform", "parole", "death penalty", "fentanyl", "trafficking", "cartel", "organized crime", "hate crime", "domestic violence", "law enforcement"],
  "social security":  ["social security", "medicaid", "food stamp", "disability", "supplemental nutrition"],
  "elections":        ["election", "voting rights", "ballot", "campaign finance", "gerrymandering", "redistricting", "voter id", "voter registration", "electoral", "political action committee"],
  "federal budget":   ["budget", "appropriation", "deficit", "debt ceiling", "continuing resolution", "omnibus", "sequester", "government shutdown", "national debt", "fiscal year"],
  "drug policy":      ["opioid", "fentanyl", "cannabis", "marijuana", "controlled substance", "narcotics", "substance abuse", "overdose", "drug enforcement"],
  "abortion":         ["abortion", "reproductive rights", "pro-life", "pro-choice", "contraception", "planned parenthood", "family planning"],
  "environment":      ["environmental protection", "pollution", "superfund", "clean water", "clean air", "endangered species", "conservation", "national park", "wildlife", "pfas", "toxic"],
  "agriculture":      ["agriculture", "farm bill", "farmer", "livestock", "food safety", "pesticide", "crop insurance", "rural development", "ethanol"],
};

// Generic words that pad out LLM-generated search terms (e.g. "Medicare
// expansion", "healthcare reform") without being distinctive enough to
// safely require in an AND-match, but too common to accept as an OR-match
// on their own either -- matching a bill on "funding" or "reform" alone
// would false-positive against nearly any policy bill.
// e.g. "insurance" confirmed live: search terms like "health insurance
// reform" left "insurance" as the only surviving distinctive word (once
// "reform" was filtered), which alone matched "Smoke Exposure Crop
// Insurance Act" - a farm bill with nothing to do with the health care
// article being scanned. Only meaningful paired with its subject
// ("health insurance", "flood insurance"), not distinctive alone.
const GENERIC_TOPIC_FILLER_WORDS = new Set([
  "for", "all", "the", "and", "with",
  "reform", "reforms", "expansion", "restoration", "funding", "access",
  "affordability", "cuts", "subsidy", "subsidies", "policy", "act", "bill",
  "law", "program", "rights", "support", "protection", "relief",
  "assistance", "initiative", "plan", "insurance", "public", "option",
  "cost", "costs",
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-bounded check, not a plain substring check -- confirmed live:
// "public" (see below) matched "Republic of Cuba" via a bare
// `text.includes("public")`, since "republic" contains "public" as
// characters. Bill/vote text is free-form prose, not a controlled
// vocabulary, so short distinctive words need boundaries to avoid
// matching inside unrelated words.
function wordBoundaryIncludes(text, word) {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(text);
}

// Matches a raw topic/search-term string (not necessarily a
// TOPIC_TITLE_KEYWORDS key) against a title/description blob. Requires at
// least one distinctive (non-filler) word rather than every word -- real
// bill titles rarely contain LLM-paraphrased filler like "reform" or
// "funding" verbatim, but do contain the actual subject (e.g. "medicare").
// Requires every word (not just one) when the whole term is filler --
// confirmed live: "public option" (both words filler) fell back to an
// OR-match on "public" alone, which then substring-matched "Republic of
// Cuba" in a war-powers resolution with no connection to the health care
// article being scanned. A term with zero distinctive words carries no
// reliable signal on its own; requiring all of it, word-bounded, is a much
// narrower net than any single generic word.
function topicWordsMatchText(topic, text) {
  const words = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const distinctive = words.filter((w) => !GENERIC_TOPIC_FILLER_WORDS.has(w));
  if (distinctive.length === 0) {
    return words.every((w) => wordBoundaryIncludes(text, w));
  }
  return distinctive.some((w) => wordBoundaryIncludes(text, w));
}

function billMatchesTopic(bill, topic) {
  if (!bill.title) return false;
  const title = bill.title.toLowerCase();
  const keywords = TOPIC_TITLE_KEYWORDS[topic.toLowerCase()];
  if (keywords) return keywords.some((kw) => title.includes(kw));

  return topicWordsMatchText(topic, title);
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
    if (titleKeywords) {
      if (titleKeywords.some((kw) => hay.includes(kw))) return true;
      continue;
    }
    if (topicWordsMatchText(topic, hay)) return true;
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
