// server/test/cost/extraction-quality.test.js
// Tests that actually call Claude/Mistral extraction — real, small API costs
// (~$0.001/call combined). Does NOT run with `npm test` by default.
//
// Run explicitly with: npm run test:cost
//
// These exist to catch a different class of bug than test/free/ — not
// "is the gating correct" but "is the extraction actually working and
// returning sensible data." Keep this suite small and deliberate; every
// test here costs real money every time it runs.

import { describe, it, expect, beforeAll } from "vitest";
import { api, authHeaders, setTestTokenTier } from "../helpers.js";

const SAMPLE_ARTICLE =
  "Senator Jane Smith voted for the new infrastructure bill, supporting " +
  "her claim that she champions roads and bridges funding for the state. " +
  "Representative John Doe opposed the measure, citing budget concerns.";

describe("Claude extraction — basic sanity (real API call)", () => {
  beforeAll(async () => {
    await setTestTokenTier("pro"); // pro so we can check the full unstripped shape
  });

  it("extracts at least one figure with a populated lookup_name", async () => {
    const { status, body } = await api("/api/claude/extract", {
      method: "POST",
      headers: authHeaders(),
      body: { articleText: SAMPLE_ARTICLE },
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.figures.length).toBeGreaterThan(0);
    expect(body.figures[0].lookup_name).toBeTruthy();
  }, 30000);

  it("returns an article summary for pro tier (non-deterministic LLM output - " +
     "checking it's present in the response shape, not asserting on length, " +
     "since short test articles can legitimately produce a brief summary)", async () => {
    const { body } = await api("/api/claude/extract", {
      method: "POST",
      headers: authHeaders(),
      body: { articleText: SAMPLE_ARTICLE },
    });
    expect(typeof body.summary).toBe("string");
  }, 30000);
});

describe("Mistral extraction — basic sanity (real API call)", () => {
  beforeAll(async () => {
    await setTestTokenTier("pro");
  });

  it("extracts at least one figure with a populated lookup_name", async () => {
    const { status, body } = await api("/api/mistral/extract", {
      method: "POST",
      headers: authHeaders(),
      body: { articleText: SAMPLE_ARTICLE },
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.figures.length).toBeGreaterThan(0);
    expect(body.figures[0].lookup_name).toBeTruthy();
  }, 30000);
});
