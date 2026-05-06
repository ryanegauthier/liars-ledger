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
async function getMemberSponsoredBills(bioguideId, apiKey, limit = 20) {
  const path = `/member/${bioguideId}/sponsored-legislation?limit=${limit}&congress=${CURRENT_CONGRESS}`;
  try {
    const data = await apiFetch(path, apiKey);
    return data.sponsoredLegislation || [];
  } catch (e) {
    console.warn("[Worth Noting] sponsored bills fetch failed:", e.message);
    return [];
  }
}

// --- Get cosponsored legislation for a member ---
async function getMemberCosponsoredBills(bioguideId, apiKey, limit = 20) {
  const path = `/member/${bioguideId}/cosponsored-legislation?limit=${limit}&congress=${CURRENT_CONGRESS}`;
  try {
    const data = await apiFetch(path, apiKey);
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

// --- Filter bills by topic relevance ---
const TOPIC_TO_POLICY_AREA = {
  "foreign policy": ["international affairs", "foreign policy", "armed forces", "international trade"],
  "labor": ["labor and employment", "economics and public finance", "labor"],
  "health care": ["health", "medicare", "medicaid"],
  "climate change": ["environmental protection", "energy", "climate"],
  "immigration": ["immigration", "border security"],
  "firearms": ["firearms", "crime and law enforcement"],
  "taxation": ["taxation", "economics and public finance"],
  "defense": ["armed forces and national security", "defense"],
  "education": ["education", "higher education"],
  "infrastructure": ["transportation and public works", "infrastructure"],
  "technology": ["science, technology, communications", "technology"],
  "trade": ["foreign trade and international finance", "trade"],
  "housing": ["housing and community development", "housing"],
  "criminal justice": ["crime and law enforcement", "criminal justice"],
  "social security": ["social welfare", "social security"],
  "elections": ["government operations and politics", "elections"],
  "federal budget": ["economics and public finance", "budget"],
  "drug policy": ["crime and law enforcement", "drug trafficking"],
};

function billMatchesTopic(bill, topic) {
  const title = (bill.title || "").toLowerCase();
  const policyArea = (bill.policyArea?.name || "").toLowerCase();
  const topicLower = topic.toLowerCase();

  // Direct match first
  if (title.includes(topicLower) || policyArea.includes(topicLower)) return true;

  // Check mapped policy areas
  const mappedAreas = TOPIC_TO_POLICY_AREA[topicLower] || [];
  return mappedAreas.some(area => policyArea.includes(area) || title.includes(area));
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
