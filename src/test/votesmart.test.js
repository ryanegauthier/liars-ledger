import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

const createG = () => {
  const storageSession = {};
  return loadScript("src/votesmart.js", {
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
          nickName: null,
        },
      ],
    });

    const candidateId = await g.resolveVoteSmartId(member);
    assert.equal(candidateId, "12345");
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
          nickName: "Mitch",
        },
      ],
    });

    const candidateId = await g.resolveVoteSmartId(member);
    assert.equal(candidateId, "67890");
  });

  it("prefers state-scoped VoteSmart office lookup before lastname fallback", async () => {
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
        return {
          data: [
            {
              id: "22222",
              officeId: "5",
              officeStateId: "WA",
              firstName: "Jane",
              nickName: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected VoteSmart path: ${path}`);
    };

    const candidateId = await g.resolveVoteSmartId(member);
    assert.equal(candidateId, "22222");
    assert.deepEqual(paths, ["/v1/officials/by-office-state?officeId=5&stateId=WA"]);
  });

  it("falls back to lastname if the state office lookup returns no officials", async () => {
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
      if (path.startsWith("/v1/officials/by-office-state")) {
        return { data: [] };
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

    const candidateId = await g.resolveVoteSmartId(member);
    assert.equal(candidateId, "33333");
    assert.deepEqual(paths, [
      "/v1/officials/by-office-state?officeId=5&stateId=TX",
      "/v1/officials/by-lastname?lastName=Smith",
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
