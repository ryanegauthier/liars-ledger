import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

const g = loadScript("src/keywords.js");

describe("extractTopics", () => {
  it("detects health care from article text", () => {
    const text =
      "Senator Sanders reintroduced Medicare for All legislation expanding health care coverage.";
    const topics = g.extractTopics(text);
    assert.ok(topics.includes("health care"));
  });

  it("detects firearms from gun control language", () => {
    const text = "The committee advanced a bill requiring universal background checks for firearm purchases.";
    const topics = g.extractTopics(text);
    assert.ok(topics.includes("firearms"));
  });

  it("returns empty set for unrelated financial copy", () => {
    const text = "Markets fell on inflation fears. Analysts expect volatility through the quarter.";
    const topics = g.extractTopics(text);
    assert.equal(topics.length, 0);
  });
});

describe("getSearchTerms", () => {
  it("returns mapped topics when patterns match", () => {
    const terms = g.getSearchTerms("Lawmakers debated immigration reform and border security measures.");
    assert.ok(terms.includes("immigration"));
  });

  it("falls back to significant words when no topic matches", () => {
    const terms = g.getSearchTerms("Zephyr analysts revised quarterly volatility forecasts upward dramatically.");
    assert.ok(terms.length > 0);
    assert.ok(terms.every((w) => typeof w === "string" && w.length > 0));
  });
});
