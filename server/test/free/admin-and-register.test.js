// server/test/free/admin-and-register.test.js
// Covers: admin endpoint auth (fail-closed), and /register's behavior.
//
// Deliberately does NOT test the rate limiter's actual threshold (5
// requests/hour) by sending 6 requests — that would pollute global:user_count
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
    // Uses a fresh, throwaway token — this DOES increment global:user_count
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
