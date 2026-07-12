import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

// api.js depends on topic-match.js's globals (billMatchesTopic,
// topicWordsMatchText, TOPIC_TITLE_KEYWORDS) exactly like it does via real
// importScripts load order in background.js - loading both into the same
// sandbox exercises the real integration between the two files instead of
// re-mocking already-tested matching logic.
const createG = (configOverrides = {}) => {
  const store = {};
  return loadScript(["src/topic-match.js", "src/api.js"], {
    CONFIG: { PROXY_URL: "https://api.liarsledger.com", ...configOverrides },
    browser: {
      storage: {
        session: {
          get: async (key) => ({ [key]: store[key] }),
        },
      },
    },
    safeSessionSet: async (key, value) => { store[key] = value; },
    authHeaders: async () => ({ Authorization: "Bearer test-token" }),
    // Real runtime always has this defined - logger.js loads before api.js
    // via importScripts. No-op here since these tests assert on return
    // values, not log output.
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
};

describe("proxy base URL helpers", () => {
  it("uses CONFIG.PROXY_URL when set", () => {
    const g = createG({ PROXY_URL: "https://custom.example.com" });
    assert.equal(g.congressProxyBase(), "https://custom.example.com/api/congress");
    assert.equal(g.govtrackProxyBase(), "https://custom.example.com/api/govtrack");
    assert.equal(g.legislatorsProxyUrl(), "https://custom.example.com/api/legislators");
  });

  it("falls back to the production URL when CONFIG.PROXY_URL is not set", () => {
    const g = createG({ PROXY_URL: undefined });
    assert.equal(g.congressProxyBase(), "https://api.liarsledger.com/api/congress");
  });
});

describe("cacheGet/cacheSet", () => {
  it("returns null on a cache miss", async () => {
    const g = createG();
    assert.equal(await g.cacheGet("api:nothing-here"), null);
  });

  it("cacheSet routes through safeSessionSet and cacheGet reads it back", async () => {
    const g = createG();
    await g.cacheSet("api:some-key", { hello: "world" });
    assert.deepEqual(await g.cacheGet("api:some-key"), { hello: "world" });
  });
});

describe("apiFetch (via getMemberSponsoredBills)", () => {
  it("fetches and caches on a miss, then serves the cache on the next call", async () => {
    const g = createG();
    let fetchCalls = 0;
    g.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ sponsoredLegislation: [{ title: "Test Act" }] }) };
    };

    const first = await g.getMemberSponsoredBills("B000001");
    const second = await g.getMemberSponsoredBills("B000001");

    assert.equal(first.errored, false);
    assert.equal(first.data[0].title, "Test Act");
    assert.deepEqual(second.data, first.data);
    assert.equal(fetchCalls, 1);
  });

  it("returns errored:true when the proxy responds non-ok", async () => {
    const g = createG();
    g.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

    const result = await g.getMemberCosponsoredBills("B000002");

    assert.equal(result.errored, true);
    assert.equal(result.data.length, 0);
  });
});

describe("normalizeVotePosition", () => {
  it("maps common raw values to normalized positions", () => {
    const g = createG();
    assert.equal(g.normalizeVotePosition("Yea"), "Yea");
    assert.equal(g.normalizeVotePosition("Yes"), "Yea");
    assert.equal(g.normalizeVotePosition("+"), "Yea");
    assert.equal(g.normalizeVotePosition("Nay"), "Nay");
    assert.equal(g.normalizeVotePosition("No"), "Nay");
    assert.equal(g.normalizeVotePosition("-"), "Nay");
    assert.equal(g.normalizeVotePosition("P"), "Present");
    assert.equal(g.normalizeVotePosition("Not Voting"), "Not Voting");
    assert.equal(g.normalizeVotePosition("Abstain"), "Not Voting");
  });

  it("falls back to the raw value, or a dash for nullish input", () => {
    const g = createG();
    assert.equal(g.normalizeVotePosition("Weird"), "Weird");
    assert.equal(g.normalizeVotePosition(undefined), "-");
    assert.equal(g.normalizeVotePosition(null), "-");
  });
});

describe("resolveGovTrackId", () => {
  it("returns a cached ID directly without fetching", async () => {
    const g = createG();
    g.fetch = async () => { throw new Error("should not be called - id was cached"); };
    await g.cacheSet("api:govtrack:id:B1", 999);

    assert.equal(await g.resolveGovTrackId("B1"), 999);
  });

  it("builds the legislators map from a fetch, then reuses the cached map for later members", async () => {
    const g = createG();
    let fetchCalls = 0;
    g.fetch = async (url) => {
      fetchCalls += 1;
      if (url.includes("/api/legislators")) {
        return {
          ok: true,
          status: 200,
          json: async () => ([
            { id: { bioguide: "B1", govtrack: 111 } },
            { id: { bioguide: "B2", govtrack: 222 } },
          ]),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    assert.equal(await g.resolveGovTrackId("B2"), 222);
    assert.equal(fetchCalls, 1);
    // B1 was in the same map response - resolving it should reuse the
    // cached map rather than fetching again.
    assert.equal(await g.resolveGovTrackId("B1"), 111);
    assert.equal(fetchCalls, 1);
  });
});

describe("findMemberRollCallVotesOnTopics", () => {
  it("returns empty immediately when there are no topics", async () => {
    const g = createG();
    const result = await g.findMemberRollCallVotesOnTopics({ bioguide_id: "B1" }, []);
    assert.equal(result.data.length, 0);
    assert.equal(result.errored, false);
  });

  it("returns errored when a GovTrack ID cannot be resolved", async () => {
    const g = createG();
    g.fetch = async (url) => {
      if (url.includes("/api/legislators")) return { ok: true, status: 200, json: async () => ([]) };
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await g.findMemberRollCallVotesOnTopics({ bioguide_id: "NOTFOUND" }, ["health care"]);

    assert.equal(result.errored, true);
    assert.equal(result.data.length, 0);
  });

  it("matches a roll-call vote via a TOPIC_TITLE_KEYWORDS category (real topic-match.js)", async () => {
    const g = createG();
    g.fetch = async (url) => {
      if (url.includes("/api/legislators")) {
        return { ok: true, status: 200, json: async () => ([{ id: { bioguide: "B1", govtrack: 12345 } }]) };
      }
      if (url.includes("/vote_voter")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            objects: [{
              vote: {
                question: "On Passage of the Medicare Drug Price Negotiation Act",
                congress: 119, session: 1, number: 42, chamber: "h", created: "2026-01-01",
              },
              option: { value: "Yea" },
            }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await g.findMemberRollCallVotesOnTopics({ bioguide_id: "B1" }, ["health care"]);

    assert.equal(result.errored, false);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].position, "Yea");
  });
});

describe("lookupPoliticianOnTopics", () => {
  function mockFetchFor({ sponsored = [], cosponsored = [] } = {}) {
    return async (url) => {
      if (url.includes("/sponsored-legislation")) {
        return { ok: true, status: 200, json: async () => ({ sponsoredLegislation: sponsored }) };
      }
      if (url.includes("/cosponsored-legislation")) {
        return { ok: true, status: 200, json: async () => ({ cosponsoredLegislation: cosponsored }) };
      }
      if (url.includes("/vote_voter")) {
        return { ok: true, status: 200, json: async () => ({ objects: [] }) };
      }
      if (url.includes("/api/legislators")) {
        return { ok: true, status: 200, json: async () => ([]) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  }

  it("matches bills via billMatchesTopic's category keywords and excludes ceremonial bills", async () => {
    const g = createG();
    g.fetch = mockFetchFor({
      sponsored: [
        { title: "Medicare Drug Price Negotiation Act of 2025", url: "https://congress.gov/bill/1", type: "hr", number: "1" },
        { title: "Honoring the life of a local hero", url: "https://congress.gov/bill/2", type: "hr", number: "2" },
      ],
    });

    const member = { bioguide_id: "B000001", full_name: "Test Member" };
    const result = await g.lookupPoliticianOnTopics(member, ["health care"], { skipVoteSmart: true });

    assert.ok(result.sponsored.some((b) => b.title.includes("Medicare Drug Price")));
    assert.ok(!result.sponsored.some((b) => b.title.includes("Honoring the life")));
  });

  it("matches a bill via an LLM search term through the filler-word-aware fallback", async () => {
    const g = createG();
    // "hospital funding" isn't a TOPIC_TITLE_KEYWORDS category - it only
    // matches via topicWordsMatchText's distinctive-word logic (see the
    // filler-word fix: "funding" alone is filler, "hospital" survives).
    g.fetch = mockFetchFor({
      cosponsored: [
        { title: "Rural Hospital Support Act", url: "https://congress.gov/bill/3", type: "hr", number: "3" },
      ],
    });

    const member = { bioguide_id: "B000001", full_name: "Test Member", _llm_search_terms: ["hospital funding"] };
    const result = await g.lookupPoliticianOnTopics(member, ["technology"], { skipVoteSmart: true });

    assert.ok(result.cosponsored.some((b) => b.title.includes("Rural Hospital Support")));
  });

  it("dedups a bill that appears in both sponsored and cosponsored lists", async () => {
    const g = createG();
    const dupeBill = { title: "Medicare Expansion Act", url: "https://congress.gov/bill/dupe", type: "hr", number: "9" };
    g.fetch = mockFetchFor({ sponsored: [dupeBill], cosponsored: [dupeBill] });

    const member = { bioguide_id: "B000002", full_name: "Test Member" };
    const result = await g.lookupPoliticianOnTopics(member, ["health care"], { skipVoteSmart: true });

    assert.equal(result.sponsored.length, 1);
    assert.equal(result.cosponsored.length, 0);
  });

  it("skips VoteSmart entirely when lookupVoteSmart isn't defined (proxy not configured)", async () => {
    const g = createG();
    g.fetch = mockFetchFor();

    const member = { bioguide_id: "B000003", full_name: "Test Member" };
    const result = await g.lookupPoliticianOnTopics(member, ["health care"]);

    assert.equal(result.voteSmartId, undefined);
    // .length checks, not deepEqual against [] - result.voteSmartRatings is
    // an array from the vm sandbox's own Array realm, which fails
    // deepStrictEqual's prototype/reference check against an outer-realm []
    // literal even when both are empty.
    assert.equal(result.voteSmartRatings.length, 0);
    assert.equal(result.voteSmartVotes.length, 0);
    assert.equal(result._votesmart_partial, false);
  });
});

describe("lookupAll batching", () => {
  it("processes every member, preserves order, and caps concurrency at the batch size", async () => {
    const g = createG();
    let current = 0;
    let maxConcurrent = 0;

    // Override the real lookupPoliticianOnTopics with a concurrency-tracking
    // stub - this isolates the batching behavior in lookupAll from the full
    // Congress.gov/GovTrack/VoteSmart dependency chain, which is already
    // covered by the tests above.
    g.lookupPoliticianOnTopics = async (member) => {
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      current -= 1;
      return { id: member.id };
    };

    const memberJobs = Array.from({ length: 8 }, (_, i) => ({
      member: { id: i },
      topics: ["health care"],
    }));

    const results = await g.lookupAll(memberJobs);

    assert.equal(results.length, 8);
    // Per-element check, not deepEqual against a literal array - results
    // comes from the vm sandbox's own Array realm (same reason as the
    // .length workaround above).
    results.forEach((r, i) => assert.equal(r.id, i));
    assert.ok(maxConcurrent <= 3, `expected concurrency capped at 3, saw ${maxConcurrent}`);
  });
});
