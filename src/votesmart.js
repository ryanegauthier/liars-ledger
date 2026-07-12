// Liars Ledger - src/votesmart.js
// VoteSmart v2 API client.
// All calls go through the backend proxy - VoteSmart is CORS-blocked from browsers.
//
// Exports:
//   resolveVoteSmartId(member)             → { id, partial }
//   getVoteSmartRatings(candidateId)       → { ratings: [{ sigId, sigName, rating, ratingText, year, categories }], errored }
//   getVoteSmartVotes(candidateId, topics) → { votes: [{ billNumber, title, vote, date, stage, categories }], errored }
//   lookupVoteSmart(member, topics)        → { candidateId, ratings, votes, partial }
//
// `partial` (added v0.17.2+): true if id resolution had to salvage a
// pagination failure (429/502 even after retries - see fetchAllVsPages),
// OR if the ratings or votes fetch failed outright after candidateId
// resolved successfully. Either way, the data returned may be incomplete
// for a reason that isn't "this politician genuinely has no ratings/votes."
// Threaded up to api.js/background.js so an incomplete scan doesn't get
// charged against the user's daily limit - see background.js's
// skipCommit check.

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
  // safeSessionSet is defined in cache-maintenance.js, which loads before
  // this file via importScripts in background.js.
  if (typeof globalThis.safeSessionSet === "function") {
    await globalThis.safeSessionSet(key, value);
  } else {
    await browser.storage.session.set({ [key]: value });
  }
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

// Per-page resilience (v0.17.2+, same session): confirmed live that a
// single 429/502 on ANY page - even after vsFetch's own VS_MAX_RETRIES (2)
// are exhausted - previously threw and discarded every page already
// successfully accumulated before it. Confirmed live: Hill and Scott both
// failed entirely on a single bad page (page 1 of N, page 2 of N) despite
// earlier pages presumably having succeeded.
//
// Fix has two layers:
//   1. Retry the SPECIFIC failing page up to VS_PAGE_EXTRA_RETRIES more
//      times (beyond vsFetch's own retries) before giving up on it -
//      vsFetch's 2 retries may simply not be enough during a real
//      multi-second outage window, which is what tonight's 502s look like
//      (GovTrack 502ing in the same few seconds on an unrelated endpoint
//      suggests broader third-party flakiness, not something specific to
//      one VoteSmart request).
//   2. If the page still fails after that, SALVAGE whatever pages
//      succeeded rather than discarding them - returns a `partial: true`
//      result instead of throwing, so the caller can proceed with
//      possibly-incomplete data instead of nothing at all.
//
// IMPORTANT correctness tradeoff, deliberate: if the real match was on the
// specific page that failed, a partial result will silently report "no
// match" instead of "lookup failed" - the same silent-failure shape as the
// original truncation bug this session opened with. Mitigated, not
// eliminated, by always logging partial:true loudly (see resolveVoteSmartId
// debug log) so a degraded result is at least diagnosable from console
// output rather than indistinguishable from a clean not-found.
const VS_PAGE_EXTRA_RETRIES = 3;
const VS_PAGE_RETRY_BASE_MS = 400;
const VS_PAGE_RETRY_JITTER_MS = 250;

async function fetchPageWithExtraRetries(pagePath) {
  let attempt = 0;
  while (true) {
    try {
      return await vsFetch(pagePath);
    } catch (e) {
      if (attempt >= VS_PAGE_EXTRA_RETRIES) throw e;
      attempt += 1;
      const delay = VS_PAGE_RETRY_BASE_MS * attempt + Math.floor(Math.random() * VS_PAGE_RETRY_JITTER_MS);
      logger.warn("votesmart", `page retry ${attempt}/${VS_PAGE_EXTRA_RETRIES} for ${pagePath}: ${e.message}`);
      await sleep(delay);
    }
  }
}

/**
 * Returns { officials, partial, failedAtPage }.
 *   officials   - accumulated results from every page fetched successfully
 *   partial     - true if pagination stopped early due to a page that
 *                 failed even after all retries (officials may be
 *                 incomplete - some matches could be on the missing page)
 *   failedAtPage - the page number that ultimately failed, or null
 */
async function fetchAllVsPages(basePath) {
  let page = 1;
  let allData = [];

  while (page <= VS_MAX_PAGES_SAFETY_CAP) {
    let data;
    try {
      data = await fetchPageWithExtraRetries(`${basePath}&page=${page}`);
    } catch (e) {
      logger.warn("votesmart", `pagination: page ${page} failed after all retries, salvaging ${allData.length} result(s) from earlier pages: ${e.message}`);
      return { officials: allData, partial: true, failedAtPage: page };
    }

    const pageData = Array.isArray(data?.data) ? data.data : [];
    allData = allData.concat(pageData);

    const meta = data?.meta;
    if (!meta || typeof meta.lastPage !== "number" || page >= meta.lastPage) {
      return { officials: allData, partial: false, failedAtPage: null };
    }
    page += 1;
  }

  return { officials: allData, partial: false, failedAtPage: null };
}

// --- Resolve member → VoteSmart candidateId ---
function normalizeVoteSmartOfficeId(officeId) {
  return Number(officeId);
}

async function resolveVoteSmartId(member) {
  if (!member?.last_name) return { id: null, partial: false };

  const cacheKey = `vs:id:${member.bioguide_id}`;
  const cached = await vsGet(cacheKey);
  if (cached) return { id: cached, partial: false };

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
    let isPartialResult = false; // true if any pagination step had to salvage a partial page set - see fetchAllVsPages
    let match = null;

    // Office+state fast path (v0.17.8+): /v1/officials/by-office-id.
    // The endpoint previously here, /v1/officials/by-office-state, was
    // never a real path on app.votesmart-api.org (100% 404/502, confirmed
    // across many office/state combos) - it doesn't appear anywhere in the
    // API's own Swagger spec. by-office-id is the real equivalent, and
    // unlike /v1/candidates/by-office-state (which returns every candidate
    // who ever ran - 329 rows for CA House alone), this is pre-filtered by
    // VoteSmart to only currently-active officeholders - confirmed live
    // 2026-07-12: 51 rows for CA House (California's actual seat count),
    // every row officeStatus="active", no client-side status filtering
    // needed. Response has no preferredName field (unlike by-lastname), so
    // this can't replace the compound-surname retry below - it's a fast
    // first pass only, falling through to the unchanged by-lastname flow
    // if it doesn't find a match.
    if (state) {
      pathTried = "by-office-id";
      const officeIdResult = await fetchAllVsPages(
        `/v1/officials/by-office-id?officeId=${targetOffice}&stateId=${encodeURIComponent(state)}&perPage=50`
      );
      // lastName check is required here, unlike the by-lastname path below
      // - by-office-id returns the ENTIRE state delegation (e.g. all 51 CA
      // House members), not narrowed by surname at all, so first-name-only
      // matching isn't enough to disambiguate. Confirmed live: without this
      // check, "Mike Thompson" (CA-4) incorrectly matched "Mike Levin"
      // (CA-49) instead - both go by "Mike", and Levin sorts first
      // alphabetically, so Array.find() picked him and never reached
      // Thompson's actual record.
      match = officeIdResult.officials.find(o =>
        normalizeVoteSmartOfficeId(o.officeId) === targetOffice &&
        o.officeStateId?.toUpperCase() === state &&
        o.lastName?.toLowerCase() === member.last_name.toLowerCase() &&
        firstNameMatches(o)
      );
      if (match) {
        officials = officeIdResult.officials;
        isPartialResult = officeIdResult.partial;
      } else {
        pathTried = "by-office-id-empty-then-lastname";
      }
    }

    if (!match) {
      pathTried = state ? "by-office-id-empty-then-lastname" : "lastname-only";

      // Paginates through every page of by-lastname results rather than
      // trusting a single arbitrary perPage value. Fixed v0.17.0+: the
      // default perPage=10 was silently truncating common surnames (Warren,
      // Gluesenkamp Perez) when their record sorted past page 1, causing a
      // false "no candidate found" with no error surfaced anywhere.
      //
      // perPage raised 10 -> 50 (v0.17.1+, same session): reduces how many
      // pages a typical lookup needs, lowering exposure to a mid-sequence
      // failure (see fetchAllVsPages below for the actual resilience fix).
      //
      // Per-page resilience (v0.17.2+, same session): confirmed live that
      // Hill and Scott's lookups both failed entirely on a single bad page
      // despite earlier pages having succeeded. fetchAllVsPages now retries
      // a failing page (VS_PAGE_EXTRA_RETRIES) before giving up on it, and
      // salvages whatever pages DID succeed (partial: true) instead of
      // discarding everything. See fetchAllVsPages's own comment for the
      // correctness tradeoff this introduces (a partial result can
      // silently miss a match that was on the failed page).
      const lastnameResult = await fetchAllVsPages(
        `/v1/officials/by-lastname?lastName=${encodeURIComponent(member.last_name)}&perPage=50`
      );
      officials = lastnameResult.officials;
      isPartialResult = lastnameResult.partial;

      // TEMP DEBUG - remove after diagnosing name-resolution mismatch
      console.log(`[LL DEBUG] fell back to by-lastname="${member.last_name}", returned ${officials.length} officials across all pages (path=${pathTried}, partial=${isPartialResult}${isPartialResult ? `, failedAtPage=${lastnameResult.failedAtPage}` : ""})`);
      if (isPartialResult) {
        logger.warn("votesmart", `PARTIAL pagination result for "${member.full_name}" - page ${lastnameResult.failedAtPage} failed after all retries. A real match may exist on the missing page and be silently absent here.`);
      }
      // END TEMP DEBUG
    }

    // Pass 1/Pass 2 below assume `officials` was narrowed by a lastname
    // search, so first-name is the only remaining discriminator needed -
    // that assumption does NOT hold for the fast path's `officials` (the
    // entire state delegation, unnarrowed by surname). Re-running them
    // unconditionally previously reintroduced the exact Levin/Thompson bug
    // the fast path's lastName check was meant to fix, by overwriting a
    // correct fast-path match with whichever same-first-name person
    // happens to sort first in the full delegation. Skip both passes
    // entirely once the fast path has already found a match.
    if (!match) {
      // Pass 1: office + state + first/nick/preferred name
      match = officials.find(o =>
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

      const compoundResult = await fetchAllVsPages(
        `/v1/officials/by-lastname?lastName=${encodeURIComponent(compoundLastNameGuess)}&perPage=50`
      );
      const compoundOfficials = compoundResult.officials;
      if (compoundResult.partial) isPartialResult = true;

      // TEMP DEBUG - remove after diagnosing name-resolution mismatch
      console.log(`[LL DEBUG] compound-surname retry lastName="${compoundLastNameGuess}", returned ${compoundOfficials.length} officials (partial=${compoundResult.partial})`);
      if (compoundResult.partial) {
        logger.warn("votesmart", `PARTIAL pagination result for compound-surname retry on "${member.full_name}" - page ${compoundResult.failedAtPage} failed after all retries.`);
      }
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
    console.log(`[LL DEBUG] match result for "${member.full_name}" (pathTried=${pathTried}, partial=${isPartialResult}):`, {
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
    return { id, partial: isPartialResult };
  } catch (e) {
    logger.warn("votesmart", `ID resolution failed: ${e.message}`);
    return { id: null, partial: false };
  }
}

// --- Get interest group ratings ---
// Returns { ratings, errored }. errored=true means the fetch itself failed
// (network error, non-retryable status, etc.) - distinct from a genuine,
// successful "this candidate has zero ratings" result, which is
// errored=false with an empty array. Previously these were indistinguishable
// (both returned []), so a fetch failure looked identical to "no data
// exists" - silently undercounting a politician's record with no signal
// anywhere that something went wrong. Threaded up through lookupVoteSmart
// so background.js's scan-charging check can treat a ratings/votes fetch
// failure the same way it treats a partial pagination result - skip the
// charge rather than charging for data that's missing due to an upstream
// failure, not a genuine absence of ratings.
async function getVoteSmartRatings(candidateId) {
  if (!candidateId) return { ratings: [], errored: false };

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

    return { ratings: [...bySig.values()].sort((a, b) => a.sigName.localeCompare(b.sigName)), errored: false };
  } catch (e) {
    logger.warn("votesmart", `ratings failed: ${e.message}`);
    return { ratings: [], errored: true };
  }
}

// --- Get vote history filtered by topics ---
// Returns { votes, errored } - see getVoteSmartRatings's comment above for
// why errored is tracked separately from a genuine empty result.
async function getVoteSmartVotes(candidateId, topics) {
  if (!candidateId || !topics?.length) return { votes: [], errored: false };
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

    const mapped = matched.slice(0, 10).map(v => ({
      billNumber: v.billNumber || "",
      title:      v.title || "",
      vote:       normalizeVsVote(v.vote),
      date:       v.statusDate || "",
      stage:      v.stage || "",
      categories: (v.categories || []).map(c => c.name),
    }));
    return { votes: mapped, errored: false };
  } catch (e) {
    logger.warn("votesmart", `votes failed: ${e.message}`);
    return { votes: [], errored: true };
  }
}

function normalizeVsVote(raw) {
  const map = { "Y": "Yea", "N": "Nay", "-": "Not Voting", "A": "Abstain", "5": "Present" };
  return map[raw] || raw || "-";
}

// --- Main entry point ---
async function lookupVoteSmart(member, topics) {
  const { id: candidateId, partial: idPartial } = await resolveVoteSmartId(member);
  if (!candidateId) {
    logger.warn("votesmart", `no candidate ID for ${member.full_name}`);
    return { candidateId: null, ratings: [], votes: [], partial: idPartial };
  }

  logger.info("votesmart", `resolved ${member.full_name} → candidateId=${candidateId}`);

  const [ratingsResult, votesResult] = await Promise.all([
    getVoteSmartRatings(candidateId),
    getVoteSmartVotes(candidateId, topics),
  ]);

  // Overall partial = true if id resolution was degraded OR either the
  // ratings or votes fetch failed outright. From the caller's perspective
  // these are all the same kind of problem: this politician's VoteSmart
  // data is incomplete, for a reason that isn't "they genuinely have no
  // ratings/votes" - see getVoteSmartRatings/getVoteSmartVotes's comments.
  const partial = idPartial || ratingsResult.errored || votesResult.errored;

  logger.info("votesmart", `${member.full_name} - ${ratingsResult.ratings.length} ratings, ${votesResult.votes.length} votes${partial ? " (PARTIAL - see above for which part failed)" : ""}`);
  return { candidateId, ratings: ratingsResult.ratings, votes: votesResult.votes, partial };
}