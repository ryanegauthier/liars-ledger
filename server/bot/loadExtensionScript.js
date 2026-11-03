// Loads select src/*.js extension scripts (classic scripts, no ES module
// syntax - see CLAUDE.md) into a Node vm sandbox so the bot reuses the same
// politician-resolution, bill/vote topic-matching, and government-data
// fetch+dedup orchestration the browser extension uses, instead of
// re-deriving it and risking the exact kind of duplicated-logic drift
// CHANGELOG.md already documents happening once (the v0.17.7
// rollCallMatchesTopics/topicWordsMatchText split).
//
// Loaded, in real importScripts order: topic-match.js, keywords.js, llm.js,
// api.js, votesmart.js, lookup.js, verify.js (keywords.js and lookup.js have
// no dependency on the others; order doesn't matter for either). This gives
// the sandbox real, working copies of billMatchesTopic, mergeTopicsForMember,
// getSearchTerms (keyword fallback topics), extractArticleAnalysisDualVerified
// (Claude + Mistral in parallel, Jaccard merge), lookupAll (Congress.gov +
// GovTrack + VoteSmart, batched), resolveAll, and verifyAllClaims.
//
// Deliberately NOT loaded: cache-maintenance.js. Its job is evicting
// browser.storage.session entries that accumulate across a long-lived
// browser session - irrelevant here, since each bot run is a short-lived
// Node process with a fresh in-memory store and no accumulation problem to
// solve. safeSessionSet is mocked directly as a plain set instead.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

let _sandbox = null;

// src/lookup.js's loadDictionary() calls browser.runtime.getURL(...) then
// fetch(url) to read src/data/politicians.json from the extension bundle.
// This mock resolves the same relative path straight off disk instead -
// getUrlMock returns a plain absolute filesystem path (not a file:// URL),
// and fetchMock below recognizes that shape and reads it directly.
function makeBrowserMock(sessionStore) {
  return {
    runtime: {
      getURL: (relativePath) => path.join(ROOT, relativePath),
    },
    storage: {
      session: {
        async get(key) {
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
        },
        async remove(key) {
          sessionStore.delete(key);
        },
      },
    },
  };
}

// api.js/votesmart.js call real fetch() against http(s) proxy URLs;
// lookup.js calls fetch() against the plain filesystem path browser.runtime
// .getURL() (mocked above) returns. Route by shape rather than loading two
// different fetch globals for two different files.
function makeFetchMock() {
  return async function fetchMock(input, opts) {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return fetch(url, opts); // real global fetch (Node 18+)
    }
    const data = fs.readFileSync(url, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(data) };
  };
}

function makeLoggerMock() {
  const forward = (level) => (context, message) => console[level](`[bot:${context}] ${message}`);
  return { info: forward("log"), warn: forward("warn"), error: forward("error") };
}

/**
 * @param {string} botToken - the Liar's Ledger Bearer token the bot scans
 *   through (LL_BOT_TOKEN) - must be a Pro-tier token for /api/verify-claim.
 * @param {string} apiBase - e.g. https://api.liarsledger.com
 */
export function getExtensionSandbox(botToken, apiBase) {
  if (_sandbox) return _sandbox;

  const sessionStore = new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: makeFetchMock(),
    browser: makeBrowserMock(sessionStore),
    logger: makeLoggerMock(),
    CONFIG: { PROXY_URL: apiBase },
    authHeaders: async () => ({ Authorization: `Bearer ${botToken}` }),
    safeSessionSet: async (key, value) => sessionStore.set(key, value),
  };

  for (const relativePath of ["src/topic-match.js", "src/keywords.js", "src/llm.js", "src/api.js", "src/votesmart.js", "src/lookup.js", "src/verify.js"]) {
    const filePath = path.join(ROOT, relativePath);
    const code = fs.readFileSync(filePath, "utf8");
    vm.runInNewContext(code, sandbox, { filename: filePath });
  }

  _sandbox = sandbox;
  return sandbox;
}
