// server/test/free/admin-and-register.test.js
// Covers: admin endpoint auth (fail-closed), and /register's behavior.
//
// Deliberately does NOT test the rate limiter's actual threshold (5
// requests/hour) by sending 6 requests - that would pollute global:user_count
// with throwaway test tokens every single test run, which directly degrades
// the real pooled scan limit for real users. Instead, it tests the things
// that don't have that side effect: that admin routes reject bad/missing
// keys, and that /register's basic validation behaves correctly.

import { describe, it, expect } from "vitest";
import { api, adminHeaders, freshTokenId } from "../helpers.js";

describe("Admin endpoints fail closed", () => {
  it("rejects /admin/set-tier with no x-admin-key header", async () => {
    const { status, body } = await api("/admin/set-tier", {
      method: "POST",
      body: { tokenId: "whatever", tier: "pro" },
    });
    expect(status).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("rejects /admin/set-tier with a wrong x-admin-key", async () => {
    const { status, body } = await api("/admin/set-tier", {
      method: "POST",
      headers: { "x-admin-key": "definitely-not-the-real-secret" },
      body: { tokenId: "whatever", tier: "pro" },
    });
    expect(status).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("rejects /admin/reset-scans with no x-admin-key header", async () => {
    const { status, body } = await api("/admin/reset-scans", {
      method: "POST",
      body: { tokenId: "whatever" },
    });
    expect(status).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("rejects /admin/set-tier with a valid key but invalid tier value", async () => {
    const { status, body } = await api("/admin/set-tier", {
      method: "POST",
      headers: adminHeaders(),
      body: { tokenId: "whatever", tier: "ultra-mega-pro" },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tier must be/i);
  });

  it("rejects /admin/set-tier with a valid key but missing tokenId", async () => {
    const { status, body } = await api("/admin/set-tier", {
      method: "POST",
      headers: adminHeaders(),
      body: { tier: "pro" },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tokenId required/i);
  });
});

describe("/register validation", () => {
  it("rejects a missing tokenId", async () => {
    const { status, body } = await api("/register", {
      method: "POST",
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tokenId required/i);
  });

  it("rejects a tokenId shorter than 16 characters", async () => {
    const { status, body } = await api("/register", {
      method: "POST",
      body: { tokenId: "short" },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tokenId required/i);
  });

  it("accepts a valid new tokenId and returns a numeric limit (not hardcoded 5)", async () => {
    // Uses a fresh, throwaway token - this DOES increment global:user_count
    // by one, same as a real install would. Acceptable for a single test run;
    // do not loop this.
    const tokenId = freshTokenId();
    const { status, body } = await api("/register", {
      method: "POST",
      body: { tokenId },
    });
    expect(status).toBe(200);
    expect(body.status).toBe("created");
    expect(body.tier).toBe("free");
    expect(typeof body.limit).toBe("number");
    expect(body.limit).toBeGreaterThan(0);
  });
});

describe("/register rate limiting is keyed by IP+fingerprint, not IP alone", () => {
  // registerLimiter is keyed by fingerprintKey(req) - IP plus a hash of
  // User-Agent/Accept-Language/Accept-Encoding (see server/index.js) - so an
  // office/university/mobile-carrier NAT sharing one IP doesn't exhaust the
  // bucket for every unrelated visitor behind it.
  //
  // These tests send an empty body, which the route handler rejects with 400
  // before ever touching global:user_count or Redis - same "no side effect"
  // property the tests above rely on. The limiter middleware runs (and sets
  // its RateLimit-* headers) before that validation, so bucketing is
  // observable without registering a single real token.
  //
  // Each test invents a brand-new random User-Agent, so its fingerprint has
  // never been hit before - that makes "remaining == 4" (max 5, minus this
  // first hit) deterministic no matter how many times this suite has already
  // run against this same long-lived, in-memory limiter store this hour.

  function freshUserAgent() {
    return `ll-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  it("two requests with the same fingerprint share one bucket", async () => {
    const headers = { "User-Agent": freshUserAgent() };
    const first = await api("/register", { method: "POST", headers, body: {} });
    const second = await api("/register", { method: "POST", headers, body: {} });

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    const firstRemaining = Number(first.headers.get("ratelimit-remaining"));
    const secondRemaining = Number(second.headers.get("ratelimit-remaining"));
    expect(firstRemaining).toBe(4);
    expect(secondRemaining).toBe(firstRemaining - 1);
  });

  it("two requests with different fingerprints get independent buckets", async () => {
    const first = await api("/register", {
      method: "POST",
      headers: { "User-Agent": freshUserAgent() },
      body: {},
    });
    const second = await api("/register", {
      method: "POST",
      headers: { "User-Agent": freshUserAgent() },
      body: {},
    });

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    // Both are the first-ever hit on their own fingerprint. If they shared a
    // bucket (the old IP-only behavior), the second would read one lower.
    expect(first.headers.get("ratelimit-remaining")).toBe("4");
    expect(second.headers.get("ratelimit-remaining")).toBe("4");
  });
});
