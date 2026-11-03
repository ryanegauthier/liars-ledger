// server/test/unit/scan-token.test.js
// Offline unit tests (no real server, Redis, or provider calls) for the
// v0.17.18 scan authorization: one scan token with a single-use slot per
// provider, counted once, replay rejected, and the reservation released by
// the server when every provider call for the scan failed.
import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for @upstash/redis. Every op awaits once so concurrent
// callers interleave the way real network round trips do.
const store = new Map();
const tick = () => new Promise((r) => setImmediate(r));
const fakeRedis = {
  async get(k) { await tick(); return store.has(k) ? store.get(k) : null; },
  async set(k, v) { await tick(); store.set(k, v); return "OK"; },
  async del(k) { await tick(); return store.delete(k) ? 1 : 0; },
  async incr(k) { await tick(); const n = Number(store.get(k) || 0) + 1; store.set(k, n); return n; },
  async decr(k) { await tick(); const n = Number(store.get(k) || 0) - 1; store.set(k, n); return n; },
  async expire() { await tick(); return 1; },
  async zadd(k, { score, member }) { await tick(); const z = store.get(k) || new Map(); z.set(member, score); store.set(k, z); return 1; },
  async zrem(k, m) { await tick(); const z = store.get(k); return z && z.delete(m) ? 1 : 0; },
  async zcard(k) { await tick(); return store.get(k)?.size || 0; },
  async zremrangebyscore(k, min, max) {
    await tick(); const z = store.get(k); if (!z) return 0; let n = 0;
    for (const [m, s] of z) if (s >= min && s <= max) { z.delete(m); n++; }
    return n;
  },
};
vi.mock("@upstash/redis", () => ({ Redis: class { constructor() { return fakeRedis; } } }));

const { reserveScan, consumeScanToken, commitScan, recordProviderFailure, getScans } = await import("../../providers/store.js");
const { requireScanToken } = await import("../../middleware/auth.js");

const TOKEN_ID = "11111111-2222-3333-4444-555555555555";
const pendingCount = () => {
  const key = [...store.keys()].find((k) => k.startsWith(`scans:pending:${TOKEN_ID}`));
  return key ? store.get(key).size : 0;
};

beforeEach(() => store.clear());

describe("one scan token, one slot per provider", () => {
  it("lets both providers of one scan proceed once each, counted once", async () => {
    const r = await reserveScan(TOKEN_ID, "free");
    expect(r.allowed).toBe(true);
    expect(pendingCount()).toBe(1);
    const [claude, mistral] = await Promise.all([
      consumeScanToken(r.scanToken, "claude"),
      consumeScanToken(r.scanToken, "mistral"),
    ]);
    expect(claude).toBe(TOKEN_ID);
    expect(mistral).toBe(TOKEN_ID);
    await commitScan(r.commitToken);
    expect(await getScans(TOKEN_ID)).toBe(1);
    expect(pendingCount()).toBe(0);
  });

  it("rejects a replay: same token, same provider", async () => {
    const r = await reserveScan(TOKEN_ID, "free");
    expect(await consumeScanToken(r.scanToken, "claude")).toBe(TOKEN_ID);
    expect(await consumeScanToken(r.scanToken, "claude")).toBeNull();
    expect(await consumeScanToken(r.scanToken, "mistral")).toBe(TOKEN_ID);
    expect(await consumeScanToken(r.scanToken, "mistral")).toBeNull();
  });

  it("rejects an unknown provider and a fabricated token", async () => {
    const r = await reserveScan(TOKEN_ID, "free");
    expect(await consumeScanToken(r.scanToken, "gpt")).toBeNull();
    expect(await consumeScanToken("st_fake_token", "claude")).toBeNull();
  });

  it("lets exactly one of two concurrent presentations of the same slot through", async () => {
    const r = await reserveScan(TOKEN_ID, "free");
    const results = await Promise.all([
      consumeScanToken(r.scanToken, "claude"),
      consumeScanToken(r.scanToken, "claude"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a second scan needs a new token: the old one authorizes nothing", async () => {
    const first = await reserveScan(TOKEN_ID, "free");
    await consumeScanToken(first.scanToken, "claude");
    await consumeScanToken(first.scanToken, "mistral");
    await commitScan(first.commitToken);
    expect(await consumeScanToken(first.scanToken, "claude")).toBeNull();
    expect(await consumeScanToken(first.scanToken, "mistral")).toBeNull();
  });
});

describe("both providers failed: reservation released, not charged", () => {
  it("one failure does not release; the second releases the reservation", async () => {
    const r = await reserveScan(TOKEN_ID, "free");
    const before = r.remaining + 1; // remaining already counts this reservation
    expect((await recordProviderFailure(r.scanToken)).released).toBe(false);
    expect(pendingCount()).toBe(1);
    expect((await recordProviderFailure(r.scanToken)).released).toBe(true);
    expect(pendingCount()).toBe(0);
    expect(await getScans(TOKEN_ID)).toBe(0);
    // A later commit for the released scan does nothing.
    expect((await commitScan(r.commitToken)).committed).toBe(false);
    expect(await getScans(TOKEN_ID)).toBe(0);
    // The next reservation sees the full allowance again.
    const next = await reserveScan(TOKEN_ID, "free");
    expect(next.remaining + 1).toBe(before);
  });

  it("an already committed scan stays committed", async () => {
    const r = await reserveScan(TOKEN_ID, "free");
    await commitScan(r.commitToken);
    await recordProviderFailure(r.scanToken);
    expect((await recordProviderFailure(r.scanToken)).released).toBe(false);
    expect(await getScans(TOKEN_ID)).toBe(1);
  });

  it("returns the web-origin site budget too", async () => {
    const r = await reserveScan(TOKEN_ID, "free", true);
    const webKey = [...store.keys()].find((k) => k.startsWith("web:scans:"));
    expect(store.get(webKey)).toBe(1);
    await recordProviderFailure(r.scanToken);
    await recordProviderFailure(r.scanToken);
    expect(store.get(webKey)).toBe(0);
  });
});

describe("requireScanToken(provider) middleware", () => {
  const run = async (mw, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let nexted = false;
    await mw({ body, tokenId: TOKEN_ID }, res, () => { nexted = true; });
    return { res, nexted };
  };

  it("passes each provider once and rejects the replay with ERR-SCAN-AUTH", async () => {
    const r = await reserveScan(TOKEN_ID, "free");
    expect((await run(requireScanToken("claude"), { scanToken: r.scanToken })).nexted).toBe(true);
    expect((await run(requireScanToken("mistral"), { scanToken: r.scanToken })).nexted).toBe(true);
    const replay = await run(requireScanToken("claude"), { scanToken: r.scanToken });
    expect(replay.nexted).toBe(false);
    expect(replay.res.statusCode).toBe(403);
    expect(replay.res.body.code).toBe("ERR-SCAN-AUTH");
  });

  it("rejects a missing scan token", async () => {
    const { res, nexted } = await run(requireScanToken("claude"), {});
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
