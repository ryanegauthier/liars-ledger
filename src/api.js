// Worth Noting - src/api.js
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
    console.log("[Worth Noting] cache hit:", path.slice(0, 60));
    return cached;
  }

  const url = `${BASE_URL}${path}&api_key=${apiKey}&format=json`;
  console.log("[Worth Noting] fetching:", path.slice(0, 80));

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
    console.log("[Worth Noting] sponsored bills raw:", JSON.stringify(data.sponsoredLegislation?.slice(0,3), null, 2));
    return data.sponsoredLegislation || [];
  } catch (e) {
    console.warn("[Worth Noting] sponsored bills fetch failed:", e.message);
    return [];
  }
}

// --- Get cosponsored legislation for a member ---
async function getMemberCosponsoredBills(bioguideId, apiKey, limit = 50) {
  const path = `/member/${bioguideId}/cosponsored-legislation?limit=${limit}&congress=${CURRENT_CONGRESS}`;
  try {
    const data = await apiFetch(path, apiKey);
    console.log("[Worth Noting] cosponsored bills raw:", JSON.stringify(data.cosponsoredLegislation?.slice(0,3), null, 2));
    return data.cosponsoredLegislation || [];
  } catch (e) {
    console.warn("[Worth Noting] cosponsored bills fetch failed:", e.message);
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
    console.warn("[Worth Noting] bill search failed for keyword:", keyword, e.message);
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

  if (topics.length === 0) return result;

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

  console.log(`[Worth Noting] ${member.full_name}: ${result.sponsored.length} sponsored, ${result.cosponsored.length} cosponsored on topics`);
  return result;
}

// --- Batch lookup for all resolved politicians ---
async function lookupAll(resolvedMembers, topics, apiKey) {
  // Run lookups in parallel but cap concurrency to avoid rate limiting
  const results = [];
  for (const member of resolvedMembers) {
    const result = await lookupPoliticianOnTopics(member, topics, apiKey);
    results.push(result);
    // Small delay between members to be polite
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}
