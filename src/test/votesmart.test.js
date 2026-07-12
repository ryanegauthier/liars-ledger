import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

const createG = () => {
  const storageSession = {};
  // topic-match.js loads before votesmart.js via importScripts in the real
  // extension (see CLAUDE.md load order) - getVoteSmartVotes calls its
  // billMatchesTopic global, so both must load into the same sandbox here.
  return loadScript(["src/topic-match.js", "src/votesmart.js"], {
    browser: {
      storage: {
        session: {
          get: async (key) => ({ [key]: storageSession[key] }),
          set: async (obj) => Object.assign(storageSession, obj),
        },
      },
    },
    CONFIG: {},
    authHeaders: async () => ({}),
    // Real runtime always has this defined - logger.js loads before
    // votesmart.js via importScripts. No-op here since these tests assert
    // on return values/paths, not log output.
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
};

describe("resolveVoteSmartId", () => {
  it("matches a multi-token first name returned by the politician dictionary", async () => {
    const g = createG();
    const member = {
      bioguide_id: "G000600",
      first_name: "Marie Gluesenkamp",
      last_name: "Perez",
      state: "Washington",
      chamber: "house",
    };

    g.vsFetch = async () => ({
      data: [
        {
          id: "12345",
          officeId: "5",
          officeStateId: "WA",
          firstName: "Marie",
          lastName: "Perez",
          nickName: null,
        },
      ],
    });

    const result = await g.resolveVoteSmartId(member);
    assert.equal(result.id, "12345");
    assert.equal(result.partial, false);
  });

  it("matches nickname aliases returned by VoteSmart when member first name is a nickname", async () => {
    const g = createG();
    const member = {
      bioguide_id: "S000148",
      first_name: "Mitch",
      last_name: "McConnell",
      state: "Kentucky",
      chamber: "senate",
    };

    g.vsFetch = async () => ({
      data: [
        {
          id: "67890",
          officeId: "6",
          officeStateId: "KY",
          firstName: "Addison",
          lastName: "McConnell",
          nickName: "Mitch",
        },
      ],
    });

    const result = await g.resolveVoteSmartId(member);
    assert.equal(result.id, "67890");
    assert.equal(result.partial, false);
  });

  it("resolves via the office+state fast path (by-office-id) without ever calling by-lastname", async () => {
    // /v1/officials/by-office-id is the real, working replacement for the
    // old /v1/officials/by-office-state (never a real endpoint - confirmed
    // via live Swagger inspection 2026-07-12). Also guards against
    // by-office-state ever getting called again - the mock throws if it is.
    const g = createG();
    const member = {
      bioguide_id: "P000001",
      first_name: "Jane",
      last_name: "Doe",
      state: "Washington",
      chamber: "house",
    };

    const paths = [];
    g.vsFetch = async (path) => {
      paths.push(path);
      if (path.startsWith("/v1/officials/by-office-state")) {
        throw new Error("by-office-state is not a real endpoint and should never be called");
      }
      if (path.startsWith("/v1/officials/by-office-id")) {
        return {
          data: [
            {
              id: "22222",
              officeId: "5",
              officeStateId: "WA",
              firstName: "Jane",
              lastName: "Doe",
              nickName: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected VoteSmart path: ${path}`);
    };

    const result = await g.resolveVoteSmartId(member);
    assert.equal(result.id, "22222");
    assert.equal(result.partial, false);
    assert.deepEqual(paths, ["/v1/officials/by-office-id?officeId=5&stateId=WA&perPage=50&page=1"]);
  });

  it("does not match a different representative who shares a nickname (Levin vs Thompson bug)", async () => {
    // Confirmed live 2026-07-12: resolving "Mike Thompson" (CA-4) via the
    // office+state fast path incorrectly returned "Mike Levin" (CA-49)
    // instead - both go by "Mike", by-office-id returns the entire state
    // delegation sorted alphabetically by last name, and Array.find()
    // matched Levin ("L" sorts before "T") before ever reaching Thompson's
    // real record. Fixed by requiring an exact lastName match in addition
    // to the existing first-name/nickname check.
    const g = createG();
    const member = {
      bioguide_id: "T000460",
      first_name: "Mike",
      last_name: "Thompson",
      state: "California",
      chamber: "house",
    };

    g.vsFetch = async () => ({
      data: [
        {
          id: "179416",
          officeId: "5",
          officeStateId: "CA",
          firstName: "Michael",
          lastName: "Levin",
          nickName: "Mike",
        },
        {
          id: "3564",
          officeId: "5",
          officeStateId: "CA",
          firstName: "Michael",
          lastName: "Thompson",
          nickName: "Mike",
        },
      ],
    });

    const result = await g.resolveVoteSmartId(member);
    assert.equal(result.id, "3564");
  });

  it("falls back to by-lastname when the office+state fast path finds no match", async () => {
    const g = createG();
    const member = {
      bioguide_id: "P000002",
      first_name: "John",
      last_name: "Smith",
      state: "Texas",
      chamber: "house",
    };

    const paths = [];
    g.vsFetch = async (path) => {
      paths.push(path);
      if (path.startsWith("/v1/officials/by-office-id")) {
        return { data: [], meta: { total: 0, lastPage: 1 } };
      }
      if (path.startsWith("/v1/officials/by-lastname")) {
        return {
          data: [
            {
              id: "33333",
              officeId: "5",
              officeStateId: "TX",
              firstName: "John",
              nickName: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected VoteSmart path: ${path}`);
    };

    const result = await g.resolveVoteSmartId(member);
    assert.equal(result.id, "33333");
    assert.equal(result.partial, false);
    assert.deepEqual(paths, [
      "/v1/officials/by-office-id?officeId=5&stateId=TX&perPage=50&page=1",
      "/v1/officials/by-lastname?lastName=Smith&perPage=50&page=1",
    ]);
  });

  it("retries transient VoteSmart proxy failures before succeeding", async () => {
    const g = createG();
    let fetchCount = 0;
    g.fetch = async () => {
      fetchCount += 1;
      if (fetchCount < 3) {
        const err = new Error("VoteSmart proxy 502 on /v1/officials/by-lastname?lastName=Candidate");
        err.status = 502;
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "99999", officeId: "6", officeStateId: "TS", firstName: "Test", nickName: null }] }),
      };
    };

    const data = await g.vsFetch("/v1/officials/by-lastname?lastName=Candidate");
    assert.equal(data.data[0].id, "99999");
    assert.equal(fetchCount, 3);
  });

  it("does not retry non-retryable VoteSmart failures", async () => {
    const g = createG();
    let fetchCount = 0;
    g.fetch = async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "Bad request" }),
      };
    };

    await assert.rejects(async () => {
      await g.vsFetch("/v1/officials/by-lastname?lastName=Candidate");
    }, {
      message: "VoteSmart proxy 400 on /v1/officials/by-lastname?lastName=Candidate",
    });
    assert.equal(fetchCount, 1);
  });

  it("drops invalid cached VoteSmart responses and retries fresh data", async () => {
    const g = createG();
    let store = {};
    g.browser = {
      storage: {
        session: {
          get: async (key) => ({ [key]: store[key] }),
          set: async (obj) => Object.assign(store, obj),
        },
      },
    };

    store["vs:/v1/officials/by-lastname?lastName=Candidate"] = { data: null };

    let fetchCount = 0;
    g.fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "77777", officeId: "6", officeStateId: "TS", firstName: "Test", nickName: null }] }),
        };
      }
      throw new Error("should not call fetch more than once");
    };

    const data = await g.vsFetch("/v1/officials/by-lastname?lastName=Candidate");
    assert.equal(data.data[0].id, "77777");
    assert.equal(fetchCount, 1);
  });

  it("drops invalid cached VoteSmart responses for non-lastname endpoints and retries fresh data", async () => {
    const g = createG();
    let store = {};
    g.browser = {
      storage: {
        session: {
          get: async (key) => ({ [key]: store[key] }),
          set: async (obj) => Object.assign(store, obj),
        },
      },
    };

    store["vs:/v1/ratings/by-candidate?candidateId=123"] = { data: null };

    let fetchCount = 0;
    g.fetch = async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "77777" }] }),
      };
    };

    const data = await g.vsFetch("/v1/ratings/by-candidate?candidateId=123");
    assert.equal(data.data[0].id, "77777");
    assert.equal(fetchCount, 1);
  });

  it("retries 429 rate-limit responses before succeeding", async () => {
    const g = createG();
    let fetchCount = 0;
    g.fetch = async () => {
      fetchCount += 1;
      if (fetchCount < 3) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: "Too Many Requests" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "88888", officeId: "6", officeStateId: "TS", firstName: "Test", nickName: null }] }),
      };
    };

    const data = await g.vsFetch("/v1/officials/by-lastname?lastName=Candidate");
    assert.equal(data.data[0].id, "88888");
    assert.equal(fetchCount, 3);
  });
});

describe("getVoteSmartVotes", () => {
  it("matches an LLM-phrased topic via its distinctive word, not just a raw substring", async () => {
    // Confirmed live 2026-07-12: LLM search terms like "Medicare for All"
    // almost never appear verbatim in a formal bill title, so the old raw
    // blob.includes(topic) check silently matched almost nothing - this is
    // why "Vote History" showed no overlap with "Legislation" (which uses
    // billMatchesTopic's word-aware matching via src/topic-match.js).
    const g = createG();
    g.vsFetch = async () => ({
      data: [
        { billNumber: "HR 1", title: "Medicare Drug Price Negotiation Act of 2025", vote: "Y", categories: [] },
      ],
    });

    const { votes } = await g.getVoteSmartVotes("3564", ["Medicare for All"]);
    assert.equal(votes.length, 1);
    assert.equal(votes[0].billNumber, "HR 1");
  });

  it("does not match when no topic word appears in the bill title or categories", async () => {
    const g = createG();
    g.vsFetch = async () => ({
      data: [
        { billNumber: "HR 2", title: "Rural Broadband Expansion Act", vote: "N", categories: [] },
      ],
    });

    const { votes } = await g.getVoteSmartVotes("3564", ["Medicare for All"]);
    assert.equal(votes.length, 0);
  });

  it("still matches via VoteSmart category -> canonical topic expansion", async () => {
    const g = createG();
    g.vsFetch = async () => ({
      data: [
        { billNumber: "HR 3", title: "Some Unrelated Sounding Title", vote: "Y", categories: [{ name: "Health Insurance" }] },
      ],
    });

    const { votes } = await g.getVoteSmartVotes("3564", ["health care"]);
    assert.equal(votes.length, 1);
    assert.equal(votes[0].billNumber, "HR 3");
  });
});
