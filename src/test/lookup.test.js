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

// Mirrors the real dictionary's actual ambiguity: a bare "smith" alias can
// only point at one bioguide_id (Adrian Smith), same as production data.
const FIXTURE_DICTIONARY = {
  members: {
    S000510: {
      full_name: "Adam Smith", first_name: "Adam", last_name: "Smith",
      state: "Washington", party: "Democratic", chamber: "house", is_current: true,
    },
    S001172: {
      full_name: "Adrian Smith", first_name: "Adrian", last_name: "Smith",
      state: "Nebraska", party: "Republican", chamber: "house", is_current: true,
    },
    S001177: {
      full_name: "Jason Smith", first_name: "Jason", last_name: "Smith",
      state: "Missouri", party: "Republican", chamber: "house", is_current: true,
    },
  },
  aliases: {
    "adam smith": "S000510",
    "smith": "S001172",
    "adrian smith": "S001172",
    "jason smith": "S001177",
  },
};

function loadWithFixtureDictionary() {
  return loadScript("src/lookup.js", {
    browser: {
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
      },
    },
    fetch: async () => ({ json: async () => FIXTURE_DICTIONARY }),
  });
}

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

describe("resolveAll - bare surname coreference", () => {
  it("attributes a later bare surname to a fuller name already resolved this scan, not the dictionary's ambiguous alias", async () => {
    // Confirmed live: "Rep. Adam Smith" then later "Rep. Smith" in the same
    // article resolved to two different people - Adam Smith (D-WA) from the
    // full name, and Adrian Smith (R-NE) from the dictionary's single
    // hardcoded "smith" alias - instead of both referring to Adam Smith.
    // Not deepEqual against literal arrays - resolved/notFound come from
    // the vm sandbox's own Array realm (see api.test.js for the same
    // workaround), so per-element/.length checks instead.
    const fx = loadWithFixtureDictionary();
    const { resolved, notFound } = await fx.resolveAll([
      "Rep. Adam Smith",
      "Rep. Smith",
      "Rep. Sawant",
    ]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].full_name, "Adam Smith");
    assert.equal(notFound.length, 1);
    // Titles are stripped from the displayed name as of v0.17.18.
    assert.equal(notFound[0], "Sawant");
  });

  it("still resolves a bare surname via the dictionary alias when no fuller name appeared earlier in the scan", async () => {
    const fx = loadWithFixtureDictionary();
    const { resolved } = await fx.resolveAll(["Rep. Smith"]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].full_name, "Adrian Smith");
  });

  it("does not let a bare surname suppress an unrelated same-surname person resolved later", async () => {
    // Order matters: the bare mention only defers to a surname already
    // seen earlier in the list, not one that appears afterward.
    const fx = loadWithFixtureDictionary();
    const { resolved } = await fx.resolveAll(["Rep. Smith", "Rep. Adam Smith"]);
    const names = resolved.map((r) => r.full_name).sort();
    assert.equal(names.length, 2);
    assert.equal(names[0], "Adam Smith");
    assert.equal(names[1], "Adrian Smith");
  });

  it("does not guess between two distinct same-surname members already resolved this scan", async () => {
    // An article naming two different real Smiths by full name before a
    // later bare "Smith" has no safe single antecedent to defer to -
    // guessing between them would be confidently wrong in a way the old
    // arbitrary dictionary fallback wasn't. The bare mention should fall
    // through to normal resolution (the dictionary alias) rather than
    // being silently collapsed into either already-resolved candidate.
    const fx = loadWithFixtureDictionary();
    const { resolved } = await fx.resolveAll([
      "Rep. Adam Smith",
      "Rep. Jason Smith",
      "Rep. Smith",
    ]);
    const names = resolved.map((r) => r.full_name).sort();
    assert.equal(names.length, 3);
    assert.equal(names[0], "Adam Smith");
    assert.equal(names[1], "Adrian Smith");
    assert.equal(names[2], "Jason Smith");
  });
});
