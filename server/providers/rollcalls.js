// server/providers/rollcalls.js
// Roll-call votes for the current Congress, from the official sources,
// stored server-side. Replaces GovTrack's /vote_voter, whose API was shut
// down in 2026 (every request 403s; see CHANGELOG Known Issues).
//
// Sources (all free, no key except Congress.gov, confirmed live 2026-11):
//   House  - Clerk XML per roll call:
//              https://clerk.house.gov/evs/{year}/roll{NNN}.xml
//            members identified by bioguide ID (name-id attribute).
//            A roll that doesn't exist yet returns HTTP 200 with
//            <xml>Error sanitizing file ...</xml>, the same body a transient
//            failure can produce, so the number of rolls per session comes
//            from Congress.gov's /house-vote index instead of probing.
//   Senate - LIS vote menu (list of votes per session) and XML per vote:
//              https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{c}_{s}.xml
//              https://www.senate.gov/legislative/LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{NNNNN}.xml
//            members identified by LIS ID (S366), mapped to bioguide with
//            the congress-legislators dataset (id.lis, all 100 senators).
//   Titles - Congress.gov /bill/{c}/{type}/{n}, fetched once per bill.
//
// Every member appears in the same roll calls, so each vote is fetched
// once for everyone and any member's record is read from memory.
//
// Storage: Redis holds everything (so a Render restart or deploy doesn't
// refetch ~1,600 files), in chunks of 50 votes per chamber/session to keep
// each value well under Upstash's 1MB limit and startup to a few dozen
// reads. Memory holds the same data plus a per-member index for reads.

import { govtrack as govtrackDefault } from "./govtrack.js";
import { congress as congressDefault } from "./congress.js";

export const CURRENT_CONGRESS = 119;
const CHUNK = 50;
const KEY = "rc:v1";
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
// House Clerk files are fetched 4 at a time. senate.gov starts returning 403
// after a burst (seen live 2026-11: 44 of 659 votes refused at 4 at a time,
// then the next session's menu), so Senate files go one at a time with a
// pause, and a 403 stops the Senate part of that sync run; the rest is
// picked up by the next run.
const FETCH_CONCURRENCY = 4;
const SENATE_DELAY_MS = 400;
const UA = "Mozilla/5.0 (compatible; LiarsLedgerBot/1.0; +https://liarsledger.com)";

// Position codes stored per member per vote.
const CODE = { Y: "Yea", N: "Nay", P: "Present", V: "Not Voting" };
const TO_CODE = {
  Yea: "Y", Aye: "Y", Yes: "Y", Guilty: "Y",
  Nay: "N", No: "N", "Not Guilty": "N",
  Present: "P", "Present, Giving Live Pair": "P",
  "Not Voting": "V",
};

export function firstYearOf(congressNo) {
  return 1789 + 2 * (congressNo - 1); // 119 -> 2025
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function tagText(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
}

// "H R 4626" / "H.R." + "4626" / "S.J.Res." -> "HR 4626", "SJRES 12"
export function normalizeBill(type, number) {
  const t = String(type || "").toUpperCase().replace(/[^A-Z]/g, "");
  const n = String(number || "").trim();
  if (!t || !n) return null;
  return `${t} ${n}`;
}

const BILL_TYPES = new Set(["HR", "S", "HRES", "SRES", "HJRES", "SJRES", "HCONRES", "SCONRES"]);

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** Parse one House Clerk roll-call XML file. Returns null if it isn't one. */
export function parseHouseRoll(xml) {
  if (!/<rollcall-vote>/.test(xml)) return null;
  const meta = xml.match(/<vote-metadata>([\s\S]*?)<\/vote-metadata>/)?.[1] || "";
  const number = Number(tagText(meta, "rollcall-num"));
  const session = parseInt(tagText(meta, "session"), 10);
  const congressNo = Number(tagText(meta, "congress"));
  if (!number || !session || !congressNo) return null;

  // "24-Feb-2026" and time-etz="14:18"
  const dm = tagText(meta, "action-date").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  const time = meta.match(/time-etz="(\d{1,2}:\d{2})"/)?.[1] || "00:00";
  const date = dm ? `${dm[3]}-${MONTHS[dm[2]] || "01"}-${dm[1].padStart(2, "0")}T${time.padStart(5, "0")}` : "";

  const legis = tagText(meta, "legis-num"); // "H RES 1075", "QUORUM", ""
  const lm = legis.match(/^([A-Z][A-Z .]*?)\s+(\d+)$/i);
  const bill = lm ? normalizeBill(lm[1], lm[2]) : null;
  const voteType = tagText(meta, "vote-type");

  const vote = {
    c: "h", g: congressNo, s: session, n: number, d: date,
    q: tagText(meta, "vote-question"),
    r: tagText(meta, "vote-result"),
    b: bill && BILL_TYPES.has(bill.split(" ")[0]) ? bill : null,
    t: tagText(meta, "vote-desc"),
  };
  // Quorum calls are kept (so they aren't refetched every sync) but carry
  // no positions and are left out of every member record.
  if (/QUORUM/i.test(voteType)) return { ...vote, x: 1 };

  const p = {};
  const re = /<recorded-vote>\s*<legislator\b[^>]*\bname-id="([A-Z]\d{6})"[^>]*>[\s\S]*?<\/legislator>\s*<vote>([\s\S]*?)<\/vote>/g;
  let m;
  while ((m = re.exec(xml))) {
    const code = TO_CODE[decode(m[2])];
    if (code) p[m[1]] = code;
  }
  return { ...vote, p };
}

/** Parse one Senate LIS roll-call XML file. lisToBioguide maps "S366" -> "W000817". */
export function parseSenateVote(xml, lisToBioguide) {
  if (!/<roll_call_vote>/.test(xml)) return null;
  const number = Number(tagText(xml, "vote_number"));
  const session = Number(tagText(xml, "session"));
  const congressNo = Number(tagText(xml, "congress"));
  if (!number || !session || !congressNo) return null;

  // "January 5, 2026,  05:31 PM"
  let date = "";
  const dm = tagText(xml, "vote_date").match(/^([A-Za-z]+) (\d{1,2}), (\d{4}),\s+(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (dm) {
    const mon = MONTHS[dm[1].slice(0, 3)] || "01";
    let h = Number(dm[4]) % 12;
    if (dm[6] === "PM") h += 12;
    date = `${dm[3]}-${mon}-${dm[2].padStart(2, "0")}T${String(h).padStart(2, "0")}:${dm[5]}`;
  }

  const doc = xml.match(/<document>([\s\S]*?)<\/document>/)?.[1] || "";
  const bill = normalizeBill(tagText(doc, "document_type"), tagText(doc, "document_number"));
  const purpose = tagText(xml.match(/<amendment>([\s\S]*?)<\/amendment>/)?.[1] || "", "amendment_purpose");

  const p = {};
  const re = /<member>([\s\S]*?)<\/member>/g;
  let m;
  while ((m = re.exec(xml))) {
    const bio = lisToBioguide[tagText(m[1], "lis_member_id")];
    const code = TO_CODE[tagText(m[1], "vote_cast")];
    if (bio && code) p[bio] = code;
  }

  return {
    c: "s", g: congressNo, s: session, n: number, d: date,
    q: tagText(xml, "question") || tagText(xml, "vote_question_text"),
    r: tagText(xml, "vote_result") || tagText(xml, "vote_result_text"),
    b: bill && BILL_TYPES.has(bill.split(" ")[0]) ? bill : null,
    t: tagText(xml, "vote_title") || tagText(doc, "document_title") || (purpose && !/^No Statement/i.test(purpose) ? purpose : ""),
    p,
  };
}

/** Vote numbers listed in a Senate vote menu XML. */
export function parseSenateMenu(xml) {
  return [...xml.matchAll(/<vote_number>\s*(\d+)\s*<\/vote_number>/g)].map((m) => Number(m[1]));
}

// ── Links ─────────────────────────────────────────────────────────────────────

export function officialVoteUrl(v) {
  const year = firstYearOf(v.g) + (v.s - 1);
  if (v.c === "h") return `https://clerk.house.gov/Votes/${year}${v.n}`;
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${v.g}${v.s}/vote_${v.g}_${v.s}_${String(v.n).padStart(5, "0")}.htm`;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export function createRollCallStore({
  kv = null,
  fetchImpl = fetch,
  govtrack = govtrackDefault,
  congress = congressDefault,
  congressNo = CURRENT_CONGRESS,
  log = console,
  senateDelayMs = SENATE_DELAY_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const votes = new Map();   // "h119-2-74" -> vote
  const titles = {};         // "HR 4626" -> title
  let byMember = new Map();  // bioguide -> [vote keys, newest first]
  let loaded = false;
  let syncing = null;
  let lastSyncAt = 0;

  const keyOf = (v) => `${v.c}${v.g}-${v.s}-${v.n}`;
  const chunkKey = (c, s, idx) => `${KEY}:${c}:${congressNo}:${s}:${idx}`;
  const chunkIndex = (n) => Math.floor((n - 1) / CHUNK);

  function reindex() {
    const sorted = [...votes.values()].filter((v) => !v.x).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    const idx = new Map();
    for (const v of sorted) {
      for (const bio of Object.keys(v.p || {})) {
        if (!idx.has(bio)) idx.set(bio, []);
        idx.get(bio).push(keyOf(v));
      }
    }
    byMember = idx;
  }

  async function load() {
    if (loaded || !kv) { loaded = true; return; }
    try {
      const meta = (await kv.getJson(`${KEY}:meta:${congressNo}`)) || { chunks: [] };
      const stored = await kv.mgetJson(meta.chunks || []);
      for (const chunk of stored) for (const v of chunk || []) votes.set(keyOf(v), v);
      Object.assign(titles, (await kv.getJson(`${KEY}:titles:${congressNo}`)) || {});
      lastSyncAt = meta.syncedAt || 0;
      reindex();
      log.log?.(`[rollcalls] loaded ${votes.size} votes, ${Object.keys(titles).length} titles from Redis`);
    } catch (e) {
      log.error?.(`[rollcalls] load from Redis failed: ${e.message}`);
    }
    loaded = true;
  }

  async function getText(url) {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} on ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  }

  async function houseRollCount(session) {
    const key = process.env.CONGRESS_API_KEY || "";
    const r = await congress.fetch(`/house-vote/${congressNo}/${session}?limit=1&format=json&api_key=${key}`);
    return Number(r?.pagination?.count) || 0;
  }

  // Runs `worker` over `items` with a small concurrency cap.
  async function pool(items, worker) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
      while (i < items.length) await worker(items[i++]);
    }));
  }

  async function lisMap() {
    const map = {};
    for (const l of (await govtrack.legislators()) || []) if (l.id?.lis && l.id?.bioguide) map[l.id.lis] = l.id.bioguide;
    return map;
  }

  /** Fetch any votes not yet stored. Safe to call often; concurrent calls share one run. */
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      await load();
      const firstYear = firstYearOf(congressNo);
      const thisYear = new Date().getUTCFullYear();
      // Current session first, so recent votes land first if a run is cut short.
      const sessions = [2, 1].filter((s) => firstYear + s - 1 <= thisYear);
      const dirty = new Set();
      const failures = [];
      let added = 0;

      const lis = await lisMap().catch((e) => { failures.push(`legislators: ${e.message}`); return {}; });
      let senateBlocked = false;

      for (const s of sessions) {
        const year = firstYear + s - 1;

        // House: roll numbers are contiguous, 1..count.
        let houseNums = [];
        try {
          const count = await houseRollCount(s);
          houseNums = Array.from({ length: count }, (_, k) => k + 1).filter((n) => !votes.has(`h${congressNo}-${s}-${n}`));
        } catch (e) { failures.push(`house index ${s}: ${e.message}`); }
        await pool(houseNums, async (n) => {
          try {
            const v = parseHouseRoll(await getText(`https://clerk.house.gov/evs/${year}/roll${String(n).padStart(3, "0")}.xml`));
            if (!v) throw new Error("not a roll-call file (Clerk 'Error sanitizing' body)");
            votes.set(keyOf(v), v); dirty.add(chunkKey("h", s, chunkIndex(n))); added++;
          } catch (e) { failures.push(`house ${year} roll ${n}: ${e.message}`); }
        });

        // Senate: the menu lists every vote in the session.
        let senateNums = [];
        if (Object.keys(lis).length && !senateBlocked) {
          try {
            const menu = await getText(`https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congressNo}_${s}.xml`);
            senateNums = parseSenateMenu(menu).filter((n) => !votes.has(`s${congressNo}-${s}-${n}`));
          } catch (e) {
            failures.push(`senate menu ${s}: ${e.message}`);
            if (e.status === 403) senateBlocked = true;
          }
        }
        // Newest first, so a run cut short by a 403 still has recent votes.
        for (const n of senateNums.sort((a, b) => b - a)) {
          if (senateBlocked) break;
          try {
            const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congressNo}${s}/vote_${congressNo}_${s}_${String(n).padStart(5, "0")}.xml`;
            const v = parseSenateVote(await getText(url), lis);
            if (!v) throw new Error("not a roll-call file");
            votes.set(keyOf(v), v); dirty.add(chunkKey("s", s, chunkIndex(n))); added++;
          } catch (e) {
            failures.push(`senate ${s} vote ${n}: ${e.message}`);
            if (e.status === 403) senateBlocked = true;
          }
          if (senateDelayMs) await sleep(senateDelayMs);
        }
      }

      // Bill titles for topic matching, once per bill. House files only
      // carry the bill number; Senate files carry a title but the official
      // bill title is used for both so matching is consistent.
      const needTitles = [...new Set([...votes.values()].map((v) => v.b).filter((b) => b && !titles[b]))];
      let titlesAdded = 0;
      await pool(needTitles, async (b) => {
        const [type, num] = b.split(" ");
        try {
          const r = await congress.fetch(`/bill/${congressNo}/${type.toLowerCase()}/${num}?format=json&api_key=${process.env.CONGRESS_API_KEY || ""}`);
          const title = r?.bill?.title;
          if (title) { titles[b] = title; titlesAdded++; }
        } catch (e) { failures.push(`title ${b}: ${e.message}`); }
      });

      if (added || titlesAdded) reindex();
      lastSyncAt = Date.now();

      if (kv && (dirty.size || titlesAdded)) {
        try {
          for (const ck of dirty) {
            const [, , c, , s, idx] = ck.split(":");
            const lo = Number(idx) * CHUNK + 1;
            const chunk = [...votes.values()]
              .filter((v) => v.c === c && v.s === Number(s) && v.n >= lo && v.n < lo + CHUNK)
              .sort((a, b) => a.n - b.n);
            await kv.setJson(ck, chunk);
          }
          const allChunks = new Set([...votes.values()].map((v) => chunkKey(v.c, v.s, chunkIndex(v.n))));
          await kv.setJson(`${KEY}:meta:${congressNo}`, { chunks: [...allChunks].sort(), syncedAt: lastSyncAt });
          if (titlesAdded) await kv.setJson(`${KEY}:titles:${congressNo}`, titles);
        } catch (e) {
          failures.push(`redis write: ${e.message}`);
        }
      }

      const summary = { added, titlesAdded, total: votes.size, failures: failures.length };
      if (added || titlesAdded || failures.length) {
        log.log?.(`[rollcalls] sync: +${added} votes, +${titlesAdded} titles, ${votes.size} stored, ${failures.length} failed${failures.length ? ` (first: ${failures[0]})` : ""}`);
      }
      return summary;
    })().finally(() => { syncing = null; });
    return syncing;
  }

  /** Sync now if the last one is older than SYNC_INTERVAL_MS. Never throws. */
  function syncIfStale() {
    if (Date.now() - lastSyncAt < SYNC_INTERVAL_MS) return null;
    return sync().catch((e) => log.error?.(`[rollcalls] sync failed: ${e.message}`));
  }

  /**
   * A member's votes, newest first:
   * [{ chamber, congress, session, number, date, question, result, bill,
   *    billTitle, description, position, url }]
   */
  function memberVotes(bioguideId, { limit = 50, offset = 0 } = {}) {
    const keys = byMember.get(bioguideId) || [];
    return keys.slice(offset, offset + limit).map((k) => {
      const v = votes.get(k);
      return {
        chamber: v.c === "s" ? "senate" : "house",
        congress: v.g, session: v.s, number: v.n, date: v.d,
        question: v.q, result: v.r, bill: v.b,
        billTitle: (v.b && titles[v.b]) || null,
        description: v.t || "",
        position: CODE[v.p[bioguideId]] || "-",
        url: officialVoteUrl(v),
      };
    });
  }

  function memberVoteCount(bioguideId) {
    return (byMember.get(bioguideId) || []).length;
  }

  return {
    load, sync, syncIfStale, memberVotes, memberVoteCount,
    isLoaded: () => loaded,
    size: () => votes.size,
    _votes: votes, _titles: titles, _reindex: reindex,
  };
}

/**
 * One entry in GovTrack's /vote_voter response shape, for extensions
 * already in the Chrome Web Store: src/api.js reads option.value and
 * vote.{question, description, related_bill.{title, bill_type, number},
 * congress, session, number, chamber ("h"/"s"), created}.
 */
export function toGovTrackEntry(mv) {
  const [type, num] = (mv.bill || "").split(" ");
  return {
    option: { key: { Yea: "+", Nay: "-", Present: "P", "Not Voting": "0" }[mv.position] || "0", value: mv.position },
    vote: {
      created: mv.date ? `${mv.date}:00` : null,
      question: mv.question,
      // The House description is often just the bill title; don't repeat it.
      description: [...new Set([mv.description, mv.billTitle].filter(Boolean))].join(" - "),
      result: mv.result,
      chamber: mv.chamber === "senate" ? "s" : "h",
      congress: mv.congress,
      session: mv.session,
      number: mv.number,
      link: mv.url,
      related_bill: mv.bill
        ? { bill_type: type.toLowerCase(), number: Number(num), display_number: mv.bill, title: mv.billTitle || mv.description || "" }
        : null,
    },
  };
}
