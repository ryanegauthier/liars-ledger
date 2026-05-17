import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

const g = loadScript("src/lookup.js", {
  browser: {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
    },
  },
});

describe("normalizeKey", () => {
  it("lowercases and trims", () => {
    assert.equal(g.normalizeKey("  Sen. Warren  "), "sen. warren");
  });
});

describe("stripTitle", () => {
  it("removes senate prefix", () => {
    assert.equal(g.stripTitle("Sen. Warren"), "warren");
  });

  it("removes representative prefix", () => {
    assert.equal(g.stripTitle("Representative Jordan"), "jordan");
  });
});

describe("isNonMemberTitle", () => {
  it("flags president", () => {
    assert.equal(g.isNonMemberTitle("President Biden"), true);
  });

  it("allows senator title", () => {
    assert.equal(g.isNonMemberTitle("Senator Warren"), false);
  });
});
