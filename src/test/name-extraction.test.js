// Name extraction and title handling (v0.17.18): abbreviation-aware title
// stripping, title-only candidates dropped, first-name check on the
// last-name fallback, and the content.js regex fallback. Uses the REAL
// dictionary (src/data/politicians.json) so membership checks match production.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadScript } from "./helpers/load-script.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DICTIONARY = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/politicians.json"), "utf8"));

// Results built inside the vm sandbox have a different Array prototype;
// copy them out before deepEqual.
const plain = (x) => JSON.parse(JSON.stringify(x));

function loadLookup() {
  return loadScript("src/lookup.js", {
    browser: { runtime: { getURL: (p) => `chrome-extension://test/${p}` } },
    fetch: async () => ({ json: async () => DICTIONARY }),
  });
}

function loadContentScript() {
  const runtime = { onMessage: { addListener() {} }, sendMessage() {}, getURL: () => "" };
  const sandbox = {
    console,
    window: { browser: { runtime }, location: { hostname: "test" }, addEventListener() {} },
    document: { addEventListener() {}, querySelector() { return null; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "content.js"), "utf8"), sandbox);
  return sandbox;
}

describe("cleanName - titles stripped before lookup", () => {
  const g = loadLookup();
  const cases = [
    ["Republican Gov. Joe Lombardo", "Joe Lombardo"],
    ["Rep. Beth Doglio", "Beth Doglio"],
    ["Sen. Elizabeth Warren", "Elizabeth Warren"],
    ["Dr. Jane Smith, R-Ohio", "Jane Smith"],
    ["U.S. Rep. Jasmine Crockett", "Jasmine Crockett"],
    ["state Attorney General Ken Paxton", "Ken Paxton"],
    ["Lt. Gov. Dan Patrick", "Dan Patrick"],
    ["Sen. Jim Justice", "Jim Justice"],
    ["Sen. Justice", "Justice"], // a surname that is also a title word is kept
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> "${expected}"`, () => assert.equal(g.cleanName(input), expected));
  }
});

describe("isTitleOnly - title fragments are not people", () => {
  const g = loadLookup();
  it("flags a title plus party word", () => assert.equal(g.isTitleOnly("Republican Gov"), true));
  it("flags U.S. Rep alone", () => assert.equal(g.isTitleOnly("U.S. Rep."), true));
  it("does not flag a real name", () => assert.equal(g.isTitleOnly("Joe Lombardo"), false));
  it("does not flag a surname that is also a title word", () => assert.equal(g.isTitleOnly("Justice"), false));
});

describe("resolveAll - full names, titles stripped, Congress decided by the dictionary", () => {
  it("handles the four example sentences from the bug report", async () => {
    const g = loadLookup();
    const { resolved, notFound, notMembers } = plain(await g.resolveAll([
      "Republican Gov", "Joe Lombardo", "Rep. Beth Doglio", "Sen. Elizabeth Warren", "Dr. Jane Smith, R-Ohio",
    ]));
    assert.deepEqual(resolved.map((r) => r.full_name), ["Elizabeth Warren"]);
    const unresolved = [...notFound, ...notMembers];
    assert.ok(!unresolved.some((n) => /Gov/.test(n)), "no title fragment candidate");
    assert.ok(unresolved.includes("Beth Doglio"), "Rep. title does not make her a member");
    assert.ok(unresolved.includes("Jane Smith"), "surname match alone does not make her a member");
    assert.ok(unresolved.includes("Joe Lombardo"));
  });

  it("last-name fallback needs a compatible first name (John Smith is not Adrian Smith)", async () => {
    const g = loadLookup();
    const { resolved, notFound } = plain(await g.resolveAll(["John Smith"]));
    assert.equal(resolved.length, 0);
    assert.deepEqual(notFound, ["John Smith"]);
  });

  it("nicknames still pass the first-name check", async () => {
    const g = loadLookup();
    const { resolved } = plain(await g.resolveAll(["Chuck Grassley", "Bernie Sanders"]));
    assert.deepEqual(resolved.map((r) => r.last_name).sort(), ["Grassley", "Sanders"]);
  });

  it("full-article regression: Crockett resolves, Paxton and Talarico are not current members", async () => {
    const crockett = Object.values(DICTIONARY.members).find((m) => m.full_name === "Jasmine Crockett");
    assert.ok(crockett?.is_current, "dictionary still lists Jasmine Crockett as current");
    const g = loadLookup();
    // Names as the updated prompt asks the model to return them.
    const { resolved, notFound } = plain(await g.resolveAll(["Jasmine Crockett", "Ken Paxton", "James Talarico"]));
    assert.deepEqual(resolved.map((r) => r.full_name), ["Jasmine Crockett"]);
    assert.equal(resolved[0].chamber, "house");
    assert.deepEqual(notFound.sort(), ["James Talarico", "Ken Paxton"]);
  });
});

describe("content.js fallback regex - abbreviation-aware, no title fragments", () => {
  const c = loadContentScript();
  const extract = (t) => Array.from(c.extractPoliticianNames(t));

  it("Republican Gov. Joe Lombardo", () => assert.deepEqual(extract("Republican Gov. Joe Lombardo signed it."), ["Gov. Joe Lombardo"]));
  it("Rep. Beth Doglio", () => assert.deepEqual(extract("Rep. Beth Doglio said."), ["Rep. Beth Doglio"]));
  it("Sen. Elizabeth Warren", () => assert.deepEqual(extract("Sen. Elizabeth Warren spoke."), ["Sen. Elizabeth Warren"]));
  it("Dr. Jane Smith, R-Ohio", () => assert.deepEqual(extract("Dr. Jane Smith, R-Ohio, agreed."), ["Dr. Jane Smith"]));
  it("middle initials are not sentence ends", () => assert.deepEqual(extract("Sen. Charles E. Schumer spoke."), ["Sen. Charles E. Schumer"]));
  it("a bare party word needs a full name after it", () => {
    assert.deepEqual(extract("in a Democratic Senate primary"), []);
    assert.deepEqual(extract("Republican Thomas Massie voted no."), ["Republican Thomas Massie"]);
  });

  it("article text where inline links split U.S. and Rep. across lines", () => {
    // innerText of "<a>U.S.</a>\n<a>Rep. Jasmine Crockett</a>" style markup
    const text =
      "The unassuming state lawmaker had beaten U.S.\nRep. Jasmine Crockett in a Democratic Senate primary. " +
      "state Attorney General Ken Paxton, the GOP nominee, said little.";
    const names = extract(text);
    assert.deepEqual(names, ["Rep. Jasmine Crockett", "Attorney General Ken Paxton"]);
    assert.ok(!names.some((n) => /^(Republican|Democratic) (Gov|Senate)/.test(n)));
  });
});
