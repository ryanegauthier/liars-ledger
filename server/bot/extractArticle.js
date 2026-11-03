// Fetches a linked article's HTML and extracts the main body text, so the
// bot can feed real article content into the same claim-extraction pipeline
// the browser extension uses. Uses Readability (the library behind Firefox's
// Reader View) rather than hand-rolled regex tag-stripping - this feeds
// public claim verification and an eventual public reply, so getting the
// actual article body (not nav/ads/related-stories chrome) matters more here
// than it does for a quick internal script.
//
// Known limitation: this is a plain fetch() of server-rendered HTML. Sites
// that render article body text client-side via JavaScript (many modern
// SPAs) will not have that text in the raw response, and extraction will
// fail or return near-empty content for those sites. content.js's in-browser
// extraction doesn't have this problem because it runs after the page
// renders. Not solved here - flagged as a known gap for this bot.

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const MAX_ARTICLE_CHARS = 12000; // matches the cap documented in docs/dual-model-verification.md
const FETCH_TIMEOUT_MS = 15000;

export async function extractArticleText(url) {
  const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`article fetch HTTP ${res.status}`);
  }
  const html = await res.text();

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();

  if (!parsed || !parsed.textContent || !parsed.textContent.trim()) {
    throw new Error("Readability found no article content (possibly a JS-rendered page)");
  }

  const text = parsed.textContent.replace(/\s+/g, " ").trim();
  return {
    title: parsed.title || null,
    text: text.slice(0, MAX_ARTICLE_CHARS),
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some sites block the default fetch UA outright; identify as a
        // normal browser rather than pretending to be a specific one.
        "User-Agent": "Mozilla/5.0 (compatible; LiarsLedgerBot/1.0; +https://liarsledger.com)",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
