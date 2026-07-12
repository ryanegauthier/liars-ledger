// Liars Ledger - src/keywords.js
// Extracts topic keywords from article text for use in Congress.gov bill searches.

// Common words to ignore
const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with",
  "is","are","was","were","be","been","being","have","has","had","do","does",
  "did","will","would","could","should","may","might","shall","can","need",
  "this","that","these","those","it","its","he","she","they","we","you","i",
  "his","her","their","our","my","your","who","what","when","where","how","why",
  "said","says","told","also","just","more","about","after","before","during",
  "from","into","through","over","under","between","among","against","within",
  "both","each","other","than","then","now","here","there","up","down","out",
  "not","no","nor","so","yet","if","as","by","about","because","while","though",
  "congress","congressional","legislation","bill","law","act","house","senate",
  "member","members","vote","voted","voting","votes","passed","failed","signed",
  "president","representative","senator","rep","sen","democrat","republican",
  "committee","amendment","federal","government","state","national","american",
  "new","last","first","second","third","year","years","month","week","day",
  "percent","million","billion","trillion","number","people","country","united",
  "states","washington","dc","white","house","administration"
]);

// Policy topic patterns - maps article keywords to Congress.gov search terms
const TOPIC_MAP = [
  { pattern: /\b(climate|emissions?|carbon|greenhouse|fossil\s+fuel|clean\s+energy|renewable|solar|wind\s+power|net\s+zero)\b/gi, term: "climate change" },
  { pattern: /\b(healthcare?|health\s+care|medicaid|medicare|affordable\s+care|obamacare|insurance|prescription|drug\s+price)\b/gi, term: "health care" },
  { pattern: /\b(immigration|immigrants?|migrants?|border|asylum|deportat|undocumented|daca|visa)\b/gi, term: "immigration" },
  { pattern: /\b(gun|firearms?|weapon|ammunition|second\s+amendment|nra|background\s+check|assault\s+weapon)\b/gi, term: "firearms" },
  { pattern: /\b(tax(es|ing|ation|payer)?|irs|deduction|income\s+tax|corporate\s+tax|wealth\s+tax)\b/gi, term: "taxation" },
  { pattern: /\b(defense|military|pentagon|troops?|veteran|army|navy|air\s+force|nato|nuclear\s+weapon|missile)\b/gi, term: "defense" },
  { pattern: /\b(education|school|student|teacher|college|university|loan|tuition|curriculum)\b/gi, term: "education" },
  { pattern: /\b(infrastructure|roads?|bridges?|highway|transit|rail|broadband|internet\s+access)\b/gi, term: "infrastructure" },
  { pattern: /\b(abortion|reproductive|roe|planned\s+parenthood|pro.life|pro.choice)\b/gi, term: "abortion" },
  { pattern: /\b(data\s+center|artificial\s+intelligence|ai\b|tech(nology)?|cyber|surveillance|privacy|social\s+media|big\s+tech)\b/gi, term: "technology" },
  { pattern: /\b(trade|tariff|import|export|china|outsourc|manufacturing|supply\s+chain)\b/gi, term: "trade" },
  { pattern: /\b(housing|rent|mortgage|eviction|homelessness|affordable\s+housing|hud)\b/gi, term: "housing" },
  { pattern: /\b(police|law\s+enforcement|crime|prison|incarceration|criminal\s+justice|sentencing)\b/gi, term: "criminal justice" },
  { pattern: /\b(social\s+security|retirement|pension|medicare|medicaid|entitlement|welfare|snap|food\s+stamp)\b/gi, term: "social security" },
  { pattern: /\b(election|voting|ballot|voter\s+(id|suppression|fraud)|gerrymandering|campaign\s+finance)\b/gi, term: "elections" },
  { pattern: /\b(israel|ukraine|foreign\s+aid|nato|russia|china|iran|north\s+korea|middle\s+east)\b/gi, term: "foreign policy" },
  { pattern: /\b(spending|deficit|debt|budget|appropriations?|fiscal|sequester)\b/gi, term: "federal budget" },
  { pattern: /\b(drug|opioid|fentanyl|addiction|substance\s+abuse|dea|marijuana|cannabis)\b/gi, term: "drug policy" },
  { pattern: /\b(minimum\s+wage|labor|union|worker|employment|unemployment|job|workforce)\b/gi, term: "labor" },
];

// Extract topic keywords from article text, ranked by mention count - a
// topic whose keywords appear 6 times in the article outranks one that
// appears once, rather than falling back to TOPIC_MAP's arbitrary
// declaration order.
function extractTopics(text) {
  const scored = [];

  for (const { pattern, term } of TOPIC_MAP) {
    pattern.lastIndex = 0; // reset regex state
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      scored.push({ term, count: matches.length });
    }
  }

  scored.sort((a, b) => b.count - a.count);
  return scored.map((s) => s.term);
}

// Extract significant freeform words as fallback search terms
function extractSignificantWords(text, maxWords = 5) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 5 && !STOP_WORDS.has(w));

  // Count frequency
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWords)
    .map(([word]) => word);
}

// Main export: get search terms from article text
function getSearchTerms(articleText) {
  const topics = extractTopics(articleText);

  // If we found mapped topics, use those
  if (topics.length > 0) {
    console.log("[Liars Ledger] topics detected:", topics);
    return topics;
  }

  // Fallback to significant words
  const words = extractSignificantWords(articleText);
  console.log("[Liars Ledger] no topics matched, using significant words:", words);
  return words;
}
