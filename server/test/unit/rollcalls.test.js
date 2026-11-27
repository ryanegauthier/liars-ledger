// server/test/unit/rollcalls.test.js
// Offline tests for the roll-call vote store that replaced GovTrack.
// Fixtures are real House Clerk and Senate LIS files (downloaded 2026-11-27),
// trimmed to a few members.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseHouseRoll, parseSenateVote, parseSenateMenu, normalizeBill,
  officialVoteUrl, createRollCallStore, toGovTrackEntry, firstYearOf,
} from "../../providers/rollcalls.js";

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const HOUSE_74 = fx("house-roll-2026-074.xml");
const HOUSE_QUORUM = fx("house-roll-2026-001-quorum.xml");
const SENATE_1 = fx("senate-vote-119-2-00001.xml");
const SENATE_MENU = fx("senate-menu-119-2.xml");
const CLERK_ERROR = '<xml>Error sanitizing file "roll999.xml". Please try again.</xml>';

const LIS = { S428: "A000382", S354: "B001230", S429: "B001299" };

describe("parsing official vote files", () => {
  it("parses a House Clerk roll call", () => {
    const v = parseHouseRoll(HOUSE_74);
    expect(v).toMatchObject({
      c: "h", g: 119, s: 2, n: 74, d: "2026-02-24T14:18",
      q: "On Agreeing to the Resolution", r: "Passed", b: "HRES 1075",
    });
    expect(v.t).toMatch(/^Providing for consideration of the bill \(H\.R\. 4626\)/);
    // House recorded votes use Aye/No; stored as Y/N.
    expect(v.p).toEqual({ A000370: "N", A000055: "Y", A000371: "N", A000379: "Y" });
    expect(v.x).toBeUndefined();
  });

  it("keeps quorum calls but with no positions", () => {
    const v = parseHouseRoll(HOUSE_QUORUM);
    expect(v).toMatchObject({ c: "h", n: 1, x: 1, b: null });
    expect(v.p).toBeUndefined();
  });

  it("rejects the Clerk's error body (returned with HTTP 200)", () => {
    expect(parseHouseRoll(CLERK_ERROR)).toBeNull();
  });

  it("parses a Senate LIS vote, mapping LIS IDs to bioguide", () => {
    const v = parseSenateVote(SENATE_1, LIS);
    expect(v).toMatchObject({ c: "s", g: 119, s: 2, n: 1, d: "2026-01-05T17:31", q: "On the Nomination" });
    expect(v.b).toBeNull(); // a nomination (PN12-1) is not a bill
    expect(v.t).toMatch(/Keith Bass/);
    expect(v.p).toEqual({ A000382: "N", B001230: "N", B001299: "Y" });
  });

  it("drops senators with no bioguide mapping instead of guessing", () => {
    expect(parseSenateVote(SENATE_1, { S428: "A000382" }).p).toEqual({ A000382: "N" });
  });

  it("lists vote numbers from a Senate vote menu", () => {
    expect(parseSenateMenu(SENATE_MENU)).toEqual([279, 278, 277]);
  });

  it("normalizes bill identifiers from both chambers", () => {
    expect(normalizeBill("H R", "4626")).toBe("HR 4626");
    expect(normalizeBill("H.J.Res.", "12")).toBe("HJRES 12");
    expect(normalizeBill("S.", "2503")).toBe("S 2503");
    expect(normalizeBill("", "1")).toBeNull();
  });

  it("builds official vote links", () => {
    expect(firstYearOf(119)).toBe(2025);
    expect(officialVoteUrl({ c: "h", g: 119, s: 2, n: 74 })).toBe("https://clerk.house.gov/Votes/202674");
    expect(officialVoteUrl({ c: "s", g: 119, s: 2, n: 1 })).toBe("https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00001.htm");
  });
});

// ── Store ────────────────────────────────────────────────────────────────────

function memoryKv() {
  const data = new Map();
  return {
    data,
    async getJson(k) { return data.has(k) ? JSON.parse(data.get(k)) : null; },
    async setJson(k, v) { data.set(k, JSON.stringify(v)); },
    async mgetJson(keys) { return keys.map((k) => (data.has(k) ? JSON.parse(data.get(k)) : null)); },
  };
}

function fakes({ houseCount = { 1: 0, 2: 2 }, clerk = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    let body;
    if (url.includes("clerk.house.gov/evs/2026/roll074.xml")) body = HOUSE_74;
    else if (url.includes("clerk.house.gov/evs/2026/roll001.xml")) body = HOUSE_QUORUM;
    else if (url.includes("clerk.house.gov/evs/2026/roll002.xml")) body = clerk[2] ?? HOUSE_74.replace(/<rollcall-num>74</, "<rollcall-num>2<").replace("24-Feb-2026", "7-Jan-2026");
    else if (url.includes("vote_menu_119_2.xml")) body = "<vote_summary><votes><vote><vote_number>00001</vote_number></vote></votes></vote_summary>";
    else if (url.includes("vote_menu_119_1.xml")) body = "<vote_summary><votes></votes></vote_summary>";
    else if (url.includes("vote_119_2_00001.xml")) body = SENATE_1;
    else return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  };
  const congress = {
    fetch: async (path) => {
      calls.push(path);
      const hv = path.match(/^\/house-vote\/119\/(\d)\?/);
      if (hv) return { pagination: { count: houseCount[hv[1]] || 0 } };
      if (path.startsWith("/bill/119/hres/1075")) return { bill: { title: "Providing for consideration of the bill (H.R. 4626) ..." } };
      throw new Error("Congress.gov 404");
    },
  };
  const govtrack = {
    legislators: async () => [
      { id: { bioguide: "A000382", lis: "S428", govtrack: 456001 } },
      { id: { bioguide: "B001230", lis: "S354", govtrack: 456002 } },
      { id: { bioguide: "B001299", lis: "S429", govtrack: 456003 } },
      { id: { bioguide: "A000055", govtrack: 400004 } },
    ],
  };
  return { fetchImpl, congress, govtrack, calls };
}

const quiet = { log: () => {}, error: () => {} };
const opts = (f, extra = {}) => ({ fetchImpl: f.fetchImpl, congress: f.congress, govtrack: f.govtrack, log: quiet, senateDelayMs: 0, ...extra });

describe("roll-call store", () => {
  it("syncs both chambers, indexes members newest first, and fetches bill titles once", async () => {
    // House session 2 has two rolls: 1 is the quorum fixture, 2 a recorded vote.
    const f = fakes({ houseCount: { 1: 0, 2: 2 } });
    const kv = memoryKv();
    const store = createRollCallStore(opts(f, { kv }));
    const r = await store.sync();
    expect(r.failures).toBe(0);
    expect(store.size()).toBe(3); // quorum + 1 House vote + 1 Senate vote

    const aderholt = store.memberVotes("A000055");
    expect(aderholt).toHaveLength(1); // quorum calls never appear in a record
    expect(aderholt[0]).toMatchObject({
      chamber: "house", number: 2, position: "Yea", bill: "HRES 1075",
      billTitle: "Providing for consideration of the bill (H.R. 4626) ...",
      url: "https://clerk.house.gov/Votes/20262",
    });
    expect(store.memberVotes("B001299")[0]).toMatchObject({ chamber: "senate", position: "Yea", number: 1 });

    // Persisted in chunks, with a meta key listing them and the titles.
    expect([...kv.data.keys()].sort()).toEqual([
      "rc:v1:h:119:2:0", "rc:v1:meta:119", "rc:v1:s:119:2:0", "rc:v1:titles:119",
    ]);
  });

  it("loads from Redis on restart without refetching stored votes", async () => {
    const f = fakes();
    const kv = memoryKv();
    await createRollCallStore(opts(f, { kv })).sync();

    const g = fakes();
    const restarted = createRollCallStore(opts(g, { kv }));
    await restarted.load();
    expect(restarted.memberVotes("A000055")).toHaveLength(1);
    await restarted.sync();
    // Only the indexes are checked again; no vote file or title is refetched.
    expect(g.calls.filter((u) => /roll\d+\.xml|vote_119_2_\d+\.xml|\/bill\//.test(u))).toEqual([]);
  });

  it("skips a roll the Clerk fails to serve and retries it on the next sync", async () => {
    const clerk = { 2: CLERK_ERROR };
    const f = fakes({ clerk });
    const store = createRollCallStore(opts(f, { kv: memoryKv() }));
    const first = await store.sync();
    expect(first.failures).toBe(1);
    expect(store.memberVotes("A000055")).toEqual([]);

    delete clerk[2]; // the Clerk serves it properly this time
    const second = await store.sync();
    expect(second).toMatchObject({ added: 1, failures: 0 });
    expect(store.memberVotes("A000055")).toHaveLength(1);
  });

  it("stops the Senate part of a run on a 403 and resumes on the next run", async () => {
    const f = fakes();
    let blocked = true;
    const fetchImpl = async (url) => (blocked && url.includes("senate.gov")
      ? { ok: false, status: 403, text: async () => "Access Denied" }
      : f.fetchImpl(url));
    const store = createRollCallStore(opts(f, { kv: null, fetchImpl }));
    await store.sync();
    expect(store.memberVotes("B001299")).toEqual([]);
    expect(store.memberVotes("A000055")).toHaveLength(1); // House unaffected
    const senateCalls = () => f.calls.length;
    blocked = false;
    await store.sync();
    expect(store.memberVotes("B001299")).toHaveLength(1);
    expect(senateCalls()).toBeGreaterThan(0);
  });

  it("shares one run between concurrent sync calls", async () => {
    const f = fakes();
    const store = createRollCallStore(opts(f, { kv: null }));
    await Promise.all([store.sync(), store.sync(), store.sync()]);
    expect(f.calls.filter((u) => u.includes("vote_119_2_00001.xml"))).toHaveLength(1);
  });
});

describe("GovTrack-compatible shape for extensions already installed", () => {
  it("has every field src/api.js reads", () => {
    const e = toGovTrackEntry({
      chamber: "house", congress: 119, session: 2, number: 74, date: "2026-02-24T14:18",
      question: "On Agreeing to the Resolution", result: "Passed", bill: "HRES 1075",
      billTitle: "Providing for consideration of H.R. 4626", description: "Providing for consideration...",
      position: "Yea", url: "https://clerk.house.gov/Votes/202674",
    });
    expect(e.option).toEqual({ key: "+", value: "Yea" });
    expect(e.vote).toMatchObject({
      created: "2026-02-24T14:18:00", question: "On Agreeing to the Resolution",
      chamber: "h", congress: 119, session: 2, number: 74,
      related_bill: { bill_type: "hres", number: 1075, display_number: "HRES 1075", title: "Providing for consideration of H.R. 4626" },
    });
    // src/api.js slices created to a date and matches topics against
    // question + description + related_bill.title.
    expect(e.vote.created.slice(0, 10)).toBe("2026-02-24");
    expect(e.vote.description).toContain("Providing for consideration");
  });

  it("doesn't repeat the bill title when the description is the same text", () => {
    const e = toGovTrackEntry({ chamber: "house", congress: 119, session: 2, number: 327, date: "2026-11-19T09:43", question: "On Motion to Suspend the Rules and Pass", bill: "HR 4464", billTitle: "Preventive Health Savings Act", description: "Preventive Health Savings Act", position: "Yea" });
    expect(e.vote.description).toBe("Preventive Health Savings Act");
  });

  it("emits a null related_bill for nominations and procedural votes", () => {
    const e = toGovTrackEntry({ chamber: "senate", congress: 119, session: 2, number: 1, date: "2026-01-05T17:31", question: "On the Nomination", bill: null, description: "Keith Bass", position: "Nay" });
    expect(e.vote.related_bill).toBeNull();
    expect(e.vote.chamber).toBe("s");
    expect(e.option.value).toBe("Nay");
  });
});
