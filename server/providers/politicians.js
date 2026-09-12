// server/providers/politicians.js
// Serves src/data/politicians.json (the extension's ~3,600-entry
// name-resolution dictionary) over HTTP for GET /api/politicians-dictionary.
//
// Needed by scan.html (liarsledger.com/scan): its browser-side copy of
// src/lookup.js resolves politician names via
// browser.runtime.getURL("src/data/politicians.json") inside the real
// extension, which isn't a thing on a plain webpage. scan.js shims
// browser.runtime.getURL to point at this route instead, so the dictionary
// stays automatically in sync with the extension's own bundled copy
// rather than needing a manually-updated static file in the website repo.
//
// Same in-memory caching pattern as server/providers/govtrack.js's
// legislators() - the file is ~825KB and effectively static at runtime,
// so read it from disk once and cache rather than re-reading per request.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DICTIONARY_PATH = path.resolve(__dirname, "../../src/data/politicians.json");

const DICTIONARY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours, matches legislators()
let _dictionary   = null;
let _dictionaryAt = 0;

async function dictionary() {
  const now = Date.now();
  if (_dictionary && now - _dictionaryAt < DICTIONARY_TTL_MS) return _dictionary;

  const raw = await fs.readFile(DICTIONARY_PATH, "utf8");
  _dictionary   = JSON.parse(raw);
  _dictionaryAt = now;
  return _dictionary;
}

export const politicians = { dictionary };
