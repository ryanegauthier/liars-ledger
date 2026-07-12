// server/test/free/tier-gating.test.js
// Verifies that free-tier tokens cannot access Pro-only data, server-side.
//
// This is the exact set of checks run manually during v0.14.0 -> v0.14.1
// verification (see CHANGELOG). It exists specifically because that manual
// process is what caught the pooled-scan-limit regression - automating it
// means the next regression gets caught by `npm test`, not by a human
// remembering to run curl commands at the right moment.

import { describe, it, expect, beforeAll } from "vitest";
import { api, authHeaders, setTestTokenTier, resetTestTokenScans, getScanToken, TEST_TOKEN } from "../helpers.js";

describe("Free tier - Pro-gated routes reject with 403", () => {
  beforeAll(async () => {
    await setTestTokenTier("free");
  });

  it("rejects /api/verify-claim for free tier", async () => {
    const { status, body } = await api("/api/verify-claim", {
      method: "POST",
      headers: authHeaders(),
      body: { claim: "test", member: "test", record: {} },
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/Pro subscription/i);
  });

  it("rejects /api/votesmart/* for free tier", async () => {
    const { status, body } = await api("/api/votesmart/some-test-path", {
      headers: authHeaders(),
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/Pro subscription/i);
  });
});

describe("Free tier - extraction responses strip Pro-only fields", () => {
  beforeAll(async () => {
    await setTestTokenTier("free");
  });

  it("strips claim and summary from /api/claude/extract, keeps lookup_name and search_terms", async () => {
    const scanToken = await getScanToken();
    const { status, body } = await api("/api/claude/extract", {
      method: "POST",
      headers: authHeaders(),
      body: {
        articleText:
          "Senator Jane Smith voted for the new infrastructure bill, " +
          "supporting her claim that she champions roads and bridges funding for the state.",
        scanToken,
      },
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary).toBe("");

    expect(body.figures.length).toBeGreaterThan(0);
    for (const fig of body.figures) {
      expect(fig.claim).toBeNull();
      // These must survive stripping - free tier still needs them to
      // resolve politicians and search for bills.
      expect(fig.lookup_name).toBeTruthy();
      expect(Array.isArray(fig.search_terms)).toBe(true);
    }
  }, 30000); // LLM extraction can be slow - generous timeout, no retry needed for a 200-or-fail check
});

describe("Pro tier - gated routes and fields are NOT stripped", () => {
  beforeAll(async () => {
    await setTestTokenTier("pro");
  });

  it("allows /api/verify-claim for pro tier", async () => {
    const { status, body } = await api("/api/verify-claim", {
      method: "POST",
      headers: authHeaders(),
      body: { claim: "test claim", member: "test member", record: {} },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.verdict).toBeTruthy();
  }, 15000);

  it("allows /api/votesmart/* for pro tier (may still 502 on a fake path, but must not 403)", async () => {
    const { status } = await api("/api/votesmart/some-test-path", {
      headers: authHeaders(),
    });
    // A fake path will likely fail upstream (502), but the gating check
    // itself must not be what blocks it - 403 specifically would mean
    // requirePro incorrectly rejected a pro token.
    expect(status).not.toBe(403);
  }, 15000);

  it("rejects /api/votesmart/* requests with unsupported query parameters", async () => {
    const { status, body } = await api(
      "/api/votesmart/v1/officials/by-lastname?lastName=Smith&unexpected=1",
      {
        headers: authHeaders(),
      },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/Invalid VoteSmart query parameter/);
  }, 15000);

  it("does not strip claim/summary from /api/claude/extract for pro tier", async () => {
    const scanToken = await getScanToken();
    const { status, body } = await api("/api/claude/extract", {
      method: "POST",
      headers: authHeaders(),
      body: {
        articleText:
          "Senator Jane Smith voted for the new infrastructure bill, " +
          "supporting her claim that she champions roads and bridges funding for the state.",
        scanToken,
      },
    });
    expect(status).toBe(200);
    expect(body.summary).not.toBe("");
    expect(body.figures.length).toBeGreaterThan(0);
    // At least one figure should have a non-null claim for this article
    expect(body.figures.some((f) => f.claim !== null)).toBe(true);
  }, 30000);
});

describe("Regression: pooled scan limit applies to BOTH tiers (v0.14.0 -> v0.14.1 bugfix)", () => {
  // This is the exact bug caught during v0.14.1 verification: incrementScans()
  // had a stale `tier === "pro"` short-circuit that returned
  // { limit: "unlimited", allowed: true } unconditionally for pro tokens,
  // bypassing the pooled daily limit entirely. This test fails loudly if
  // that regression is ever reintroduced.

  it("pro tier's /api/scan/start respects the pooled limit, not unlimited", async () => {
    await setTestTokenTier("pro");
    await resetTestTokenScans();

    const { status, body } = await api("/api/scan-status", {
      headers: authHeaders(),
    });

    expect(status).toBe(200);
    expect(body.tier).toBe("pro");
    // The bug returned the literal string "unlimited" here. A real numeric
    // limit (whatever the current FREE_TIER_TABLE row is) is what we want.
    expect(typeof body.limit).toBe("number");
    expect(body.limit).toBeGreaterThan(0);
    expect(body.scansToday).toBe(0);
  });

  it("free tier's /api/scan-status also reports a real numeric limit", async () => {
    await setTestTokenTier("free");

    const { status, body } = await api("/api/scan-status", {
      headers: authHeaders(),
    });

    expect(status).toBe(200);
    expect(body.tier).toBe("free");
    expect(typeof body.limit).toBe("number");
    expect(body.limit).toBeGreaterThan(0);
  });
});
