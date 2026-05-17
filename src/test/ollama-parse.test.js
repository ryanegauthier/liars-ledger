import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

const g = loadScript("src/ollama-parse.js");

describe("stripJsonFences", () => {
  it("strips markdown json fences", () => {
    const raw = '```json\n{"a":1}\n```';
    assert.equal(g.stripJsonFences(raw), '{"a":1}');
  });

  it("returns trimmed plain JSON unchanged", () => {
    assert.equal(g.stripJsonFences('  {"x": true}  '), '{"x": true}');
  });
});

function jsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

describe("parseOllamaJson", () => {
  it("parses valid JSON", () => {
    jsonEqual(g.parseOllamaJson('{"figures":[]}'), { figures: [] });
  });

  it("extracts JSON object from surrounding prose", () => {
    const out = g.parseOllamaJson('Here is output:\n{"article_summary":"ok","main_topics":[],"figures":[]}');
    assert.equal(out.article_summary, "ok");
  });

  it("throws when no JSON object found", () => {
    assert.throws(() => g.parseOllamaJson("not json"), /Could not parse JSON/);
  });
});

describe("parseArticleAnalysisContent", () => {
  it("normalizes figures and topics", () => {
    const json = JSON.stringify({
      article_summary: "  Summary text. ",
      main_topics: [" health care ", "health care", ""],
      figures: [
        {
          lookup_name: "Sen. Warren",
          claim: "Supports Medicare expansion",
          search_terms: ["medicare", "  "],
        },
        { lookup_name: "", claim: "skip" },
      ],
    });
    const r = g.parseArticleAnalysisContent(json);
    assert.equal(r.summary, "Summary text.");
    assert.ok(r.main_topics.includes("health care"));
    assert.equal(r.figures.length, 1);
    assert.equal(r.figures[0].lookup_name, "Sen. Warren");
    jsonEqual(r.figures[0].search_terms, ["medicare"]);
  });

  it("coerces null claim", () => {
    const json = JSON.stringify({
      article_summary: "x",
      main_topics: [],
      figures: [{ lookup_name: "Rep. Smith", claim: null, search_terms: [] }],
    });
    const r = g.parseArticleAnalysisContent(json);
    assert.equal(r.figures[0].claim, null);
  });
});

describe("dedupeTopicStrings", () => {
  it("dedupes case-insensitively and caps count", () => {
    const terms = ["Tax", "tax", "Defense", "defense", "Trade", "Climate", "Energy"];
    jsonEqual(g.dedupeTopicStrings(terms, 3), ["Tax", "Defense", "Trade"]);
  });
});

describe("mergeTopicsForMember", () => {
  it("merges figure, main topics, and fallback when any exist", () => {
    const merged = g.mergeTopicsForMember(
      { search_terms: ["border security"] },
      ["immigration"],
      ["federal budget"]
    );
    assert.ok(merged.includes("border security"));
    assert.ok(merged.includes("immigration"));
    assert.ok(merged.includes("federal budget"));
  });

  it("uses fallback only when figure and main topics empty", () => {
    jsonEqual(g.mergeTopicsForMember(null, [], ["climate change"]), ["climate change"]);
  });
});

describe("buildArticleAnalysisPrompt", () => {
  it("includes article excerpt and truncates long text", () => {
    const long = "word ".repeat(5000);
    const prompt = g.buildArticleAnalysisPrompt(long);
    assert.ok(prompt.includes("Article excerpt"));
    assert.ok(prompt.length < long.length);
  });
});
