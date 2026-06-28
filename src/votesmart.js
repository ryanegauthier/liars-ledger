// Liars Ledger - src/votesmart.js
// VoteSmart v2 API client.
// All calls go through the backend proxy - VoteSmart is CORS-blocked from browsers.
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

async function vsRemove(key) {
  try {
    if (browser.storage.session.remove) {
      return await browser.storage.session.remove(key);
    }
    return await vsSet(key, null);
  } catch {}
}

function isValidVsFetchResponse(path, data) {
  if (data == null || typeof data !== "object") return false;
  if (data.error || data.errors) return false;
  if (path.startsWith("/v1/officials/by-lastname")) {
    return Array.isArray(data.data);
  }
  return data.data !== undefined && data.data !== null;
}

// --- Fetch wrapper with caching ---
const VS_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const VS_MAX_RETRIES = 2;
const VS_RETRY_BASE_MS = 250;
const VS_RETRY_JITTER_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  const base = VS_RETRY_BASE_MS * attempt;
  const jitter = Math.floor(Math.random() * VS_RETRY_JITTER_MS);
  return base + jitter;
}

async function vsFetch(path) {
  const cacheKey = `vs:${path}`;
  let cached = await vsGet(cacheKey);
  if (cached) {
    if (isValidVsFetchResponse(path, cached)) return cached;
    await vsRemove(cacheKey);
    cached = null;
  }

  const url = `${proxyBase()}${path}`;
  const auth = await authHeaders();

  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, { headers: auth });
      if (!res.ok) {
        const err = new Error(`VoteSmart proxy ${res.status} on ${path}`);
        err.status = res.status;
        if (VS_RETRYABLE_STATUSES.has(res.status) && attempt < VS_MAX_RETRIES) {
          attempt += 1;
          await sleep(retryDelay(attempt));
          continue;
        }
        throw err;
      }

      const data = await res.json();
      if (!isValidVsFetchResponse(path, data)) {
        throw new Error(`VoteSmart proxy invalid response on ${path}`);
      }

      await vsSet(cacheKey, data);
      return data;
    } catch (e) {
      const isRetryable = e.status && VS_RETRYABLE_STATUSES.has(e.status);
      if (attempt < VS_MAX_RETRIES && isRetryable) {
        attempt += 1;
        await sleep(retryDelay(attempt));
        continue;
      }
      throw e;
    }
  }
}

// --- Paginated fetch (by-lastname only - confirmed to return a `meta`
// envelope with { total, lastPage, currentPage, next } via live testing) ---
const VS_MAX_PAGES_SAFETY_CAP = 10; // circuit-breaker, not an expected ceiling

async function fetchAllVsPages(basePath) {
  let page = 1;
  let allData = [];

  while (page <= VS_MAX_PAGES_SAFETY_CAP) {
    const data = await vsFetch(`${basePath}&page=${page}`);
    const pageData = Array.isArray(data?.data) ? data.data : [];
    allData = allData.concat(pageData);

    const meta = data?.meta;
    if (!meta || typeof meta.lastPage !== "number" || page >= meta.lastPage) {
      break;
    }
    page += 1;
  }

  return allData;
}

// --- Resolve member → VoteSmart candidateId ---
function normalizeVoteSmartOfficeId(officeId) {
  return Number(officeId);
}

async function resolveVoteSmartId(member) {
  if (!member?.last_name) return null;

  const cacheKey = `vs:id:${member.bioguide_id}`;
  const cached = await vsGet(cacheKey);
  if (cached) return cached;

  try {
    const targetOffice = member.chamber === "senate" ? VS_SENATE_OFFICE : VS_HOUSE_OFFICE;
    const firstName    = (member.first_name || "").toLowerCase();
    const firstNameParts = firstName.split(/\s+/).filter(Boolean);
    const firstNameCandidates = new Set([firstName, ...firstNameParts]);
    const rawState     = member.state_id || member.state || "";
    const state        = STATE_ABBR[rawState] || rawState.toUpperCase();

    function firstNameMatches(candidate) {
      const candidateFirst = (candidate.firstName || "").toLowerCase();
      const candidateNick  = (candidate.nickName || "").toLowerCase();
      const candidatePreferred = (candidate.preferredName || "").toLowerCase();
      // preferredName added v0.17.1+: confirmed live that VoteSmart's
      // legal firstName can differ entirely from the name a politician
      // actually goes by (e.g. Marie Gluesenkamp Perez's VoteSmart record
      // has firstName="Kristina", middleName="Marie", preferredName="Marie"
      // - "Marie" never appeared in firstName or nickName at all, so this
      // member would fail Pass 1 even with a correct lastname match).
      return firstNameCandidates.has(candidateFirst) ||
             firstNameCandidates.has(candidateNick) ||
             firstNameCandidates.has(candidatePreferred);
    }

    let officials = [];
    let pathTried = "lastname-only";

    /* ----------------------------------------------------------------------
     * OPTION B - office+state-scoped lookup (DISABLED, see CHANGELOG/notes)
     *
     * /v1/officials/by-office-state consistently 502s on app.votesmart-api.org
     * for every officeId/stateId combo tested (confirmed across Warren/MA,
     * Hill/AR, Thune/SD - 100% failure rate, not transient/rate-limit related).
     * Root cause suspected to be a host/endpoint mismatch: the classic
     * api.votesmart.org SOAP-era docs and the votesmartjs wrapper both
     * document getByOfficeState(officeId, stateId), but app.votesmart-api.org
     * may not implement the same method/shape, or may require different
     * params (e.g. officeTypeId letter code instead of numeric officeId -
     * see "C"/"N"/"L" values observed in raw by-lastname responses).
     *
     * Re-enable once the correct endpoint/params are confirmed against
     * app.votesmart-api.org's actual Swagger spec (not the legacy docs).
     * Until then, this falls straight through to the lastname lookup below,
     * which now requests a larger perPage to avoid the page-1-of-10
     * truncation bug that silently dropped common surnames (Warren,
     * Gluesenkamp Perez) when results sorted outside the default page.
     *
    if (state) {
      pathTried = "by-office-state";
      try {
        const stateData = await vsFetch(`/v1/officials/by-office-state?officeId=${targetOffice}&stateId=${encodeURIComponent(state)}`);
        officials = Array.isArray(stateData?.data) ? stateData.data : [];
      } catch (e) {
        officials = [];
      }
    }
    ---------------------------------------------------------------------- */

    if (!officials.length) {
      pathTried = officials.length === 0 && state ? "by-office-state-empty-then-lastname" : "lastname-only";

      // Paginates through every page of by-lastname results rather than
      // trusting a single arbitrary perPage value. Fixed v0.17.0+: the
      // default perPage=10 was silently truncating common surnames (Warren,
      // Gluesenkamp Perez) when their record sorted past page 1, causing a
      // false "no candidate found" with no error surfaced anywhere.
      //
      // perPage raised 10 -> 50 (v0.17.1+, same session): confirmed live
      // that VoteSmart's 429/502 errors during this debugging session hit
      // a SPECIFIC page mid-sequence (e.g. page 3 of 4 for Warren), and a
      // single failed page currently discards every page successfully
      // fetched before it - see TODO below. Fewer pages per lookup directly
      // lowers how often any single lookup is exposed to a transient
      // failure landing mid-sequence. Does not eliminate multi-page lookups
      // (a surname with 50+ nationwide matches still chains pages), and
      // does not fix VoteSmart's underlying reliability - it only reduces
      // how often the gap below gets triggered.
      //
      // TODO(reliability): fetchAllVsPages has no per-page resilience - one
      // bad page (429/502, even after vsFetch's own retries are exhausted)
      // throws and discards every page already successfully accumulated.
      // Confirmed live: Warren's lookup failed entirely on page 3/4 despite
      // pages 1-2 having presumably succeeded. Proper fix: catch a single
      // page's failure inside the loop, retry that page a few extra times
      // before giving up, and/or return whatever pages DID succeed rather
      // than losing all of them. Not built tonight - perPage=50 above is a
      // mitigation (fewer pages = less exposure), not the actual fix.
      officials = await fetchAllVsPages(
        `/v1/officials/by-lastname?lastName=${encodeURIComponent(member.last_name)}&perPage=50`
      );

      // TEMP DEBUG - remove after diagnosing name-resolution mismatch
      console.log(`[LL DEBUG] fell back to by-lastname="${member.last_name}", returned ${officials.length} officials across all pages (path=${pathTried})`);
      // END TEMP DEBUG
    }

    // Pass 1: office + state + first/nick/preferred name
    let match = officials.find(o =>
      normalizeVoteSmartOfficeId(o.officeId) === targetOffice &&
      o.officeStateId?.toUpperCase() === state &&
      firstNameMatches(o)
    );

    // Pass 2: office + state only
    if (!match) {
      match = officials.find(o =>
        normalizeVoteSmartOfficeId(o.officeId) === targetOffice &&
        o.officeStateId?.toUpperCase() === state
      );
    }

    // Compound-surname retry (v0.17.1+, confirmed live): if no match yet
    // AND member.first_name has multiple words, VoteSmart may file this
    // person under a multi-word lastName that our dictionary's first/last
    // split doesn't match. Confirmed live: Marie Gluesenkamp Perez is
    // dictionary-split as first_name="Marie Gluesenkamp", last_name="Perez",
    // but VoteSmart's actual record has lastName="Gluesenkamp Perez" as one
    // field - searching lastName="Perez" alone never finds her, no matter
    // how much of that result set gets paginated through. Guess: the last
    // word of first_name + last_name, joined, as a second lastname query.
    // Only attempted when the simple lastname search already failed to
    // produce a match, so single-word-surname members (the common case)
    // pay no extra request cost.
    if (!match && firstNameParts.length > 1) {
      const compoundLastNameGuess = `${firstNameParts[firstNameParts.length - 1]} ${member.last_name}`;
      pathTried = `${pathTried}-then-compound-surname-retry`;

      const compoundOfficials = await fetchAllVsPages(
        `/v1/officials/by-lastname?lastName=${encodeURIComponent(compoundLastNameGuess)}&perPage=50`
      );

      // TEMP DEBUG - remove after diagnosing name-resolution mismatch
      console.log(`[LL DEBUG] compound-surname retry lastName="${compoundLastNameGuess}", returned ${compoundOfficials.length} officials`);
      // END TEMP DEBUG

      match = compoundOfficials.find(o =>
        normalizeVoteSmartOfficeId(o.officeId) === targetOffice &&
        o.officeStateId?.toUpperCase() === state &&
        firstNameMatches(o)
      );

      if (!match) {
        match = compoundOfficials.find(o =>
          normalizeVoteSmartOfficeId(o.officeId) === targetOffice &&
          o.officeStateId?.toUpperCase() === state
        );
      }

      if (match) officials = compoundOfficials; // for the debug log below
    }

    // TEMP DEBUG - remove after diagnosing name-resolution mismatch
    console.log(`[LL DEBUG] match result for "${member.full_name}" (pathTried=${pathTried}):`, {
      targetOffice,
      state,
      firstNameCandidates: [...firstNameCandidates],
      officialsConsidered: officials.length,
      matchFound: !!match,
      match: match || null,
    });
    // END TEMP DEBUG

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
  return map[raw] || raw || "-";
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

  console.log(`[Liars Ledger] VoteSmart: ${member.full_name} - ${ratings.length} ratings, ${votes.length} votes`);
  return { candidateId, ratings, votes };
}