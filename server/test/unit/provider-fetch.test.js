// server/test/unit/provider-fetch.test.js
// Offline unit tests for providerFetch.js: bounded retry on upstream 429 and
// 5xx, no retry on other 4xx, error categories, and the time budget.
import { describe, it, expect } from "vitest";
import { fetchWithRetry } from "../../providers/providerFetch.js";

function fakeFetch(statuses) {
  const calls = [];
  const impl = async () => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push(status);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => `status ${status}` };
  };
  return { impl, calls };
}

const noSleep = async () => {};

describe("fetchWithRetry", () => {
  it("retries an upstream 429 and succeeds", async () => {
    const f = fakeFetch([429, 200]);
    const r = await fetchWithRetry("u", {}, { label: "Mistral", fetchImpl: f.impl, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("gives up after two retries and reports rate_limited", async () => {
    const f = fakeFetch([429]);
    const r = await fetchWithRetry("u", {}, { label: "Mistral", fetchImpl: f.impl, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(3);
    expect(r.category).toBe("rate_limited");
    expect(r.error).toMatch(/Mistral HTTP 429/);
  });

  it("reports upstream after repeated 5xx", async () => {
    const f = fakeFetch([503]);
    const r = await fetchWithRetry("u", {}, { label: "Claude", fetchImpl: f.impl, sleep: noSleep });
    expect(f.calls).toHaveLength(3);
    expect(r.category).toBe("upstream");
  });

  it("never retries a 403", async () => {
    const f = fakeFetch([403]);
    const r = await fetchWithRetry("u", {}, { label: "Claude", fetchImpl: f.impl, sleep: noSleep });
    expect(f.calls).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it("does not start a retry that would overrun the time budget", async () => {
    let t = 0;
    const f = fakeFetch([500]);
    const r = await fetchWithRetry("u", {}, {
      label: "Claude", fetchImpl: async (...a) => { t += 24000; return f.impl(...a); },
      sleep: noSleep, now: () => t, budgetMs: 25000,
    });
    expect(f.calls).toHaveLength(1);
    expect(r.category).toBe("upstream");
  });

  it("categorizes a timed-out attempt as timeout without retrying", async () => {
    let n = 0;
    const r = await fetchWithRetry("u", {}, {
      label: "Claude", sleep: noSleep,
      fetchImpl: async () => { n++; throw Object.assign(new Error("t"), { name: "TimeoutError" }); },
    });
    expect(n).toBe(1);
    expect(r.category).toBe("timeout");
  });
});
