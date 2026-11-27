// server/providers/vsRatings.js
// Curated VoteSmart interest group ratings for one candidate, built
// server-side and cached.
//
// Why this exists (found live 2026-11-27):
//   - /v1/ratings/by-candidate pages 10 rows at a time, newest first
//     (Warren: 834 ratings over 84 pages; Sanders: 2,397). The extension read
//     page 1 only, so most members showed 0 ratings.
//   - The extension's hard-coded group IDs (src/votesmart.js SIG_NAMES) are
//     mostly stale. Only NRA (1034) and NORML (599) still match; 125, which it
//     labels "Human Rights Campaign", is another group (HRC is 1256), and 310,
//     labeled "Club for Growth", is Americans for Prosperity (Club for Growth
//     is 1734). Any match on a stale ID showed one group's score under
//     another group's name.
//
// IDs below were confirmed against the rating text VoteSmart returns ("...
// supported the interests of the Human Rights Campaign 100 percent in
// 2025-2026"), across Warren, Sanders, Thompson, and Sherman. Groups the
// extension listed but that could not be confirmed (Humane Society, VFW,
// American Family Association, AFL-CIO COPE) are left out, not guessed.

export const RATING_GROUPS = [
  // legacyId: the ID extensions already in the Chrome Web Store expect for
  // this group (their SIG_NAMES table), or null if they don't list it.
  { name: "National Rifle Association (NRA)",      id: 1034, legacyId: 1034, text: /National Rifle Association/i },
  { name: "American Civil Liberties Union (ACLU)", id: 1378, legacyId: 5,    text: /American Civil Liberties Union|\bACLU\b/i },
  { name: "AFL-CIO",                               id: 1161, legacyId: 2,    text: /AFL-CIO/i },
  { name: "Human Rights Campaign",                 id: 1256, legacyId: 125,  text: /Human Rights Campaign/i },
  { name: "Planned Parenthood Action Fund",        id: 1578, legacyId: 188,  text: /Planned Parenthood/i },
  { name: "Sierra Club",                           id: 657,  legacyId: 130,  text: /Sierra Club/i },
  { name: "Club for Growth",                       id: 1734, legacyId: 310,  text: /Club for Growth/i },
  { name: "U.S. Chamber of Commerce",              id: 755,  legacyId: 174,  text: /Chamber of Commerce/i },
  { name: "Americans for Democratic Action",       id: 978,  legacyId: 32,   text: /Americans for Democratic Action/i },
  { name: "NORML",                                 id: 599,  legacyId: 599,  text: /NORML|Reform of Marijuana Laws/i },
  { name: "League of Conservation Voters",         id: 1012, legacyId: null, text: /League of Conservation Voters/i },
  { name: "Heritage Action for America",           id: 2061, legacyId: null, text: /Heritage Action/i },
  { name: "National Right to Life Committee",      id: 252,  legacyId: null, text: /National Right to Life/i },
  { name: "Americans for Prosperity",              id: 310,  legacyId: null, text: /Americans for Prosperity/i },
  { name: "National Education Association",        id: 1015, legacyId: null, text: /National Education Association/i },
  { name: "NumbersUSA",                            id: 1985, legacyId: null, text: /NumbersUSA/i },
];
const BY_ID = new Map(RATING_GROUPS.map((g) => [g.id, g]));

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // ratings change a few times a year
const REDIS_TTL_SECONDS = 24 * 60 * 60;
const MAX_PAGES = 10;                        // perPage=1000, so 10,000 ratings

// "2025-2026" -> 2026, "2024" -> 2024
function endYear(timespan) {
  const years = String(timespan || "").match(/\d{4}/g);
  return years ? Number(years[years.length - 1]) : 0;
}

/**
 * Raw VoteSmart rating rows -> one entry per curated group: its most recent
 * numeric (0-100) score. Letter grades are skipped because the extension
 * renders scores as "N%".
 *
 * A row is also skipped when its text names a different group than the one
 * its ID is supposed to be, so a future ID reshuffle at VoteSmart drops the
 * row instead of mislabeling it. Rows with generic text ("Supported the
 * interests (Standard)") are accepted on ID alone.
 */
export function curateRatings(rows) {
  const best = new Map(); // group id -> row
  for (const r of rows || []) {
    const g = BY_ID.get(Number(r.id));
    if (!g) continue;
    const text = String(r.ratingText || "");
    if (/interests of/i.test(text) && !g.text.test(text)) continue;
    const score = String(r.rating ?? "").trim();
    if (!/^\d{1,3}$/.test(score) || Number(score) > 100) continue;
    const prev = best.get(g.id);
    if (!prev || endYear(r.timespan) > endYear(prev.timespan)) best.set(g.id, r);
  }
  return [...best.entries()]
    .map(([id, r]) => {
      const g = BY_ID.get(id);
      return {
        group: g.name,
        sigId: g.id,
        legacyId: g.legacyId,
        rating: Number(r.rating),
        ratingName: r.ratingName || "",
        ratingText: r.ratingText || "",
        year: String(r.timespan || ""),
        categories: (r.categories || []).map((c) => c?.name).filter(Boolean),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

/**
 * VoteSmart-shaped response for extensions already in the Chrome Web Store:
 * src/votesmart.js reads data[].{id, ratingText, rating, timespan,
 * categories[].name} and keeps rows whose id is in its own table. Only groups
 * that table names correctly after translation are included.
 */
export function toLegacyRatingsResponse(curated) {
  const data = curated
    .filter((r) => r.legacyId != null)
    .map((r) => ({
      id: r.legacyId,
      timespan: r.year,
      ratingName: r.ratingName,
      ratingText: r.ratingText,
      rating: String(r.rating),
      categories: r.categories.map((name) => ({ name })),
    }));
  return { meta: { total: data.length, lastPage: 1, currentPage: 1, perPage: data.length, prev: null, next: null }, data };
}

export function createRatingsService({ votesmart, kv = null, now = Date.now } = {}) {
  const memory = new Map(); // candidateId -> { at, value }
  const inflight = new Map();

  async function fetchAll(candidateId) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      let r;
      try {
        r = await votesmart.fetch(`/v1/ratings/by-candidate?candidateId=${candidateId}&perPage=1000&page=${page}`);
      } catch (e) {
        // VoteSmart answers 404 when a candidate has no ratings at all (seen
        // live for Analilia Mejia, a new member). That is an empty list.
        if (e.status === 404 && page === 1) return [];
        throw e;
      }
      rows.push(...(r?.data || []));
      const last = Number(r?.meta?.lastPage) || 1;
      if (page >= last) break;
    }
    return rows;
  }

  /** Curated ratings for one candidate. Throws if VoteSmart fails and nothing is cached. */
  async function get(candidateId) {
    const id = String(candidateId);
    const hit = memory.get(id);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
    if (inflight.has(id)) return inflight.get(id);

    const p = (async () => {
      if (kv) {
        const stored = await kv.getJson(`vsr:v1:${id}`).catch(() => null);
        if (stored) { memory.set(id, { at: now(), value: stored }); return stored; }
      }
      const value = curateRatings(await fetchAll(id));
      memory.set(id, { at: now(), value });
      if (kv) await kv.setJson(`vsr:v1:${id}`, value, { ttlSeconds: REDIS_TTL_SECONDS }).catch(() => {});
      return value;
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  return { get };
}
