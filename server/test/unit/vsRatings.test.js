// server/test/unit/vsRatings.test.js
// Curated VoteSmart ratings. Fixture: real /v1/ratings/by-candidate rows for
// Elizabeth Warren (candidateId 141272), pulled 2026-11-27, up to two rows
// per relevant group plus one letter-grade row.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { curateRatings, toLegacyRatingsResponse, createRatingsService, RATING_GROUPS } from "../../providers/vsRatings.js";

const WARREN = JSON.parse(readFileSync(new URL("./fixtures/votesmart-ratings-warren-141272.json", import.meta.url), "utf8"));

// The extension's own table (src/votesmart.js SIG_NAMES, as shipped).
const EXTENSION_SIG_NAMES = {
  1034: "NRA", 5: "ACLU", 2: "AFL-CIO", 310: "Club for Growth", 125: "Human Rights Campaign",
  130: "Sierra Club", 674: "Humane Society", 1110: "Veterans of Foreign Wars", 599: "NORML",
  188: "Planned Parenthood", 1627: "American Family Association", 174: "US Chamber of Commerce",
  94: "AFL-CIO COPE", 32: "Americans for Democratic Action",
};

describe("curateRatings", () => {
  const curated = curateRatings(WARREN.data);
  const byGroup = Object.fromEntries(curated.map((r) => [r.group, r]));

  it("finds the groups the extension meant, under their real IDs", () => {
    expect(byGroup["Human Rights Campaign"]).toMatchObject({ sigId: 1256, rating: 100, year: "2025-2026" });
    expect(byGroup["American Civil Liberties Union (ACLU)"]).toMatchObject({ sigId: 1378, rating: 100 });
    expect(byGroup["National Rifle Association (NRA)"]).toMatchObject({ sigId: 1034, rating: 0 });
    expect(byGroup["Planned Parenthood Action Fund"].sigId).toBe(1578);
  });

  it("never reports the stale IDs' groups (125, 674, 1110, 1627 are other organizations)", () => {
    const ids = curated.map((r) => r.sigId);
    for (const stale of [125, 674, 1110, 1627]) expect(ids).not.toContain(stale);
  });

  it("labels 310 as Americans for Prosperity, not Club for Growth", () => {
    expect(byGroup["Americans for Prosperity"]).toMatchObject({ sigId: 310, rating: 17 });
    expect(byGroup["Club for Growth"]).toMatchObject({ sigId: 1734, rating: 10 });
  });

  it("skips letter grades and keeps the most recent numeric score", () => {
    expect(curated.every((r) => Number.isInteger(r.rating) && r.rating >= 0 && r.rating <= 100)).toBe(true);
    expect(curateRatings([
      { id: 1256, timespan: "2022", rating: "80", ratingText: "Supported the interests (Standard)", categories: [] },
      { id: 1256, timespan: "2025-2026", rating: "A", ratingText: "Supported the interests (Standard)", categories: [] },
      { id: 1256, timespan: "2024", rating: "95", ratingText: "Supported the interests (Standard)", categories: [] },
    ])[0]).toMatchObject({ rating: 95, year: "2024" });
  });

  it("drops a row whose text names a different group than its ID", () => {
    expect(curateRatings([{
      id: 1256, timespan: "2026", rating: "40",
      ratingText: "Senator X supported the interests of the Some Other Group 40 percent in 2026.", categories: [],
    }])).toEqual([]);
  });
});

describe("legacy response for extensions in the Chrome Web Store", () => {
  const legacy = toLegacyRatingsResponse(curateRatings(WARREN.data));

  it("passes the extension's response check and uses only IDs it labels correctly", () => {
    expect(Array.isArray(legacy.data)).toBe(true);
    const shown = legacy.data.map((r) => EXTENSION_SIG_NAMES[r.id]);
    expect(shown.every(Boolean)).toBe(true);
    // Every row's text agrees with the name the extension will show.
    for (const r of legacy.data) {
      const name = EXTENSION_SIG_NAMES[r.id];
      const group = RATING_GROUPS.find((g) => g.legacyId === r.id);
      expect(group, name).toBeTruthy();
      if (/interests of/i.test(r.ratingText)) expect(group.text.test(r.ratingText), `${name}: ${r.ratingText}`).toBe(true);
    }
    expect(legacy.data.find((r) => r.id === 125)?.rating).toBe("100"); // HRC, from real ID 1256
  });

  it("leaves out Americans for Prosperity, whose real ID is the extension's Club for Growth slot", () => {
    const at310 = legacy.data.find((r) => r.id === 310);
    expect(at310?.ratingText ?? "").not.toMatch(/Americans for Prosperity/);
    expect(at310?.rating).toBe("10"); // Club for Growth's real score, sent under 310
  });

  it("has the fields src/votesmart.js reads, and numeric scores", () => {
    for (const r of legacy.data) {
      expect(r).toEqual(expect.objectContaining({ id: expect.any(Number), timespan: expect.any(String), ratingText: expect.any(String), rating: expect.any(String), categories: expect.any(Array) }));
      expect(Number.isNaN(parseInt(r.rating, 10))).toBe(false);
    }
  });
});

describe("ratings service", () => {
  function fakeVotesmart(pages) {
    const calls = [];
    return {
      calls,
      fetch: async (path) => {
        calls.push(path);
        const page = Number(new URL(`http://x${path}`).searchParams.get("page"));
        return pages[page - 1];
      },
    };
  }

  it("fetches every page once, then serves from cache", async () => {
    const half = Math.ceil(WARREN.data.length / 2);
    const vs = fakeVotesmart([
      { meta: { lastPage: 2 }, data: WARREN.data.slice(0, half) },
      { meta: { lastPage: 2 }, data: WARREN.data.slice(half) },
    ]);
    const svc = createRatingsService({ votesmart: vs });
    const [a, b] = await Promise.all([svc.get(141272), svc.get(141272)]);
    expect(a).toEqual(b);
    await svc.get(141272);
    expect(vs.calls).toHaveLength(2);
    expect(vs.calls[0]).toContain("perPage=1000");
    expect(a.find((r) => r.group === "Human Rights Campaign")).toBeTruthy();
  });

  it("treats VoteSmart's 404 (no ratings at all) as an empty list, and caches it", async () => {
    let calls = 0;
    const vs = { fetch: async () => { calls++; const e = new Error("VoteSmart 404 on /v1/ratings/by-candidate: Not Found"); e.status = 404; throw e; } };
    const svc = createRatingsService({ votesmart: vs });
    expect(await svc.get(231029)).toEqual([]);
    expect(await svc.get(231029)).toEqual([]);
    expect(calls).toBe(1);
  });

  it("still fails on other VoteSmart errors, without caching", async () => {
    let calls = 0;
    const vs = { fetch: async () => { calls++; const e = new Error("VoteSmart 502"); e.status = 502; throw e; } };
    const svc = createRatingsService({ votesmart: vs });
    await expect(svc.get(1)).rejects.toThrow("502");
    await expect(svc.get(1)).rejects.toThrow("502");
    expect(calls).toBe(2);
  });

  it("uses the Redis copy before calling VoteSmart", async () => {
    const stored = curateRatings(WARREN.data);
    const kv = { getJson: async () => stored, setJson: async () => {} };
    const vs = fakeVotesmart([]);
    const svc = createRatingsService({ votesmart: vs, kv });
    expect(await svc.get(141272)).toEqual(stored);
    expect(vs.calls).toEqual([]);
  });
});
