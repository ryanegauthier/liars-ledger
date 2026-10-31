// Dual-model extraction error handling (v0.17.18): one scan token sent to
// both providers, single-model fallback with the loser's category, and the
// combined category when both fail (what background.js turns into the
// "busy" or "could not be verified" message, never "limit reached").
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "./helpers/load-script.js";

const CLAUDE_URL  = "https://proxy.test/api/claude/extract";
const MISTRAL_URL = "https://proxy.test/api/mistral/extract";

const OK_BODY = (name) => ({
  ok: true, summary: "s", main_topics: ["energy"],
  figures: [{ lookup_name: name, claim: null, search_terms: ["energy"] }],
});

// responses: { claude: [status, body], mistral: [status, body] } or an Error to throw
function loadWith(responses, calls = []) {
  const respond = (key, init) => {
    calls.push({ key, body: JSON.parse(init.body) });
    const r = responses[key];
    if (r instanceof Error) throw r;
    const [status, body] = r;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };
  return loadScript("src/llm.js", {
    AbortSignal,
    authHeaders: async () => ({ Authorization: "Bearer test" }),
    fetch: async (url, init) => respond(url === CLAUDE_URL ? "claude" : "mistral", init),
  });
}

const OPTS = { provider: "dual", claudeEndpoint: CLAUDE_URL, mistralEndpoint: MISTRAL_URL, scanToken: "st_test", timeoutMs: 1000 };
const plain = (x) => JSON.parse(JSON.stringify(x));

describe("dual mode with one scan token", () => {
  it("sends the same scan token to both providers and merges both results", async () => {
    const calls = [];
    const g = loadWith({ claude: [200, OK_BODY("Elizabeth Warren")], mistral: [200, OK_BODY("Elizabeth Warren")] }, calls);
    const r = plain(await g.extractArticleAnalysis("article", OPTS));
    assert.equal(r.ok, true);
    assert.equal(r._meta.provider, "dual_verified");
    assert.deepEqual(calls.map((c) => c.body.scanToken), ["st_test", "st_test"]);
  });

  it("uses the other provider when one hits an upstream 429, and records the category", async () => {
    const g = loadWith({
      claude: [200, OK_BODY("Elizabeth Warren")],
      mistral: [502, { ok: false, error: "Mistral HTTP 429: rate limited", category: "rate_limited" }],
    });
    const r = plain(await g.extractArticleAnalysis("article", OPTS));
    assert.equal(r.ok, true);
    assert.equal(r._meta.provider, "single_model");
    assert.equal(r._meta.winner, "claude");
    assert.equal(r._meta.loser_category, "rate_limited");
    assert.match(r._meta.loser_error, /429/);
  });
});

describe("both providers fail", () => {
  it("Request B shape (auth 403 + upstream 429) is a busy failure, not auth and not quota", async () => {
    const g = loadWith({
      claude: [403, { error: "Scan authorization invalid, expired, or already used.", code: "ERR-SCAN-AUTH" }],
      mistral: [502, { ok: false, error: "Mistral HTTP 429: rate limited", category: "rate_limited" }],
    });
    const r = plain(await g.extractArticleAnalysis("article", OPTS));
    assert.equal(r.ok, false);
    assert.equal(r.category, "rate_limited");
    assert.deepEqual(r.categories, { claude: "auth", mistral: "rate_limited" });
  });

  it("both rejected by scan authorization is an auth failure", async () => {
    const body = { error: "Scan authorization invalid, expired, or already used.", code: "ERR-SCAN-AUTH" };
    const g = loadWith({ claude: [403, body], mistral: [403, body] });
    const r = plain(await g.extractArticleAnalysis("article", OPTS));
    assert.equal(r.category, "auth");
  });

  it("timeouts are categorized as timeout", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const g = loadWith({ claude: timeout, mistral: timeout });
    const r = plain(await g.extractArticleAnalysis("article", OPTS));
    assert.equal(r.category, "timeout");
  });
});
