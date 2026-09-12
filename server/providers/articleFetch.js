// server/providers/articleFetch.js
// Server-side article fetch + extraction for the public, anonymous
// POST /api/scan/extract route (liarsledger.com/scan). A hardened variant
// of server/bot/extractArticle.js's approach, needed because this route
// takes a URL from ANY anonymous visitor rather than a curated Twitter
// mention: SSRF guard (DNS-resolve + private/reserved-range block,
// re-validated on every redirect hop), a streamed response-size cap, and a
// shorter timeout budget appropriate for a synchronous page load.
//
// server/bot/extractArticle.js has the same underlying fetch+Readability
// approach but no SSRF guard or size cap - acceptable there today since
// its URLs come from curated Twitter mentions, not a public form. Not
// consolidated into one shared function here to keep this change scoped;
// worth revisiting since tweet-linked URLs are attacker-influenced too -
// see CHANGELOG.

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import dns from "node:dns";
import net from "node:net";

const FETCH_TIMEOUT_MS   = 10000;
const MAX_REDIRECTS      = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_ARTICLE_CHARS  = 12000; // matches server/bot/extractArticle.js's cap

const USER_AGENT = "Mozilla/5.0 (compatible; LiarsLedgerBot/1.0; +https://liarsledger.com)";

// Error codes match the classifyError() style already used in
// background.js/popup.js so the frontend can reuse the same [ERR-*]
// display convention.
export class ArticleFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Fetch a URL and extract its main article text, with SSRF protections
 * suitable for a fully public "paste any URL" endpoint.
 * @returns {Promise<{title: string|null, text: string}>}
 */
export async function extractArticleTextPublic(inputUrl) {
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    throw new ArticleFetchError("ERR-INVALID-URL", "That doesn't look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ArticleFetchError("ERR-INVALID-URL", "Only http and https URLs are supported.");
  }

  const html = await fetchWithGuard(url, MAX_REDIRECTS);

  const dom = new JSDOM(html, { url: url.toString() });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();

  if (!parsed || !parsed.textContent || !parsed.textContent.trim()) {
    throw new ArticleFetchError("ERR-NO-CONTENT", "Couldn't find article content on that page.");
  }

  const text = parsed.textContent.replace(/\s+/g, " ").trim();
  return {
    title: parsed.title || null,
    text: text.slice(0, MAX_ARTICLE_CHARS),
  };
}

// Fetches one hop, validating the host before connecting. Redirects are
// followed manually (redirect: "manual") rather than automatically, and
// each hop's destination host is re-validated by recursing back through
// this same function - trusting fetch's automatic redirect-follow would
// only ever check the ORIGINAL host, letting a URL that starts out public
// redirect straight to an internal address (the classic SSRF bypass).
async function fetchWithGuard(url, redirectsRemaining) {
  await assertHostIsPublic(url.hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new ArticleFetchError("ERR-TIMEOUT", "That page took too long to respond.");
    }
    throw new ArticleFetchError("ERR-NET", "Couldn't fetch that URL.");
  } finally {
    clearTimeout(timer);
  }

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get("location");
    if (!location) {
      throw new ArticleFetchError("ERR-NET", "Redirect with no location header.");
    }
    if (redirectsRemaining <= 0) {
      throw new ArticleFetchError("ERR-NET", "Too many redirects.");
    }
    const nextUrl = new URL(location, url); // resolves relative redirects too
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new ArticleFetchError("ERR-BLOCKED", "Redirected to an unsupported URL scheme.");
    }
    return fetchWithGuard(nextUrl, redirectsRemaining - 1);
  }

  if (!res.ok) {
    throw new ArticleFetchError("ERR-NET", `That page returned an error (HTTP ${res.status}).`);
  }

  return readBodyWithLimit(res);
}

// Streams the body so an oversized response is aborted mid-transfer
// instead of being buffered in full first - Content-Length is checked as
// a fast path but isn't trustworthy on its own (a server can omit it or
// lie), so the running byte count is the real enforcement.
async function readBodyWithLimit(res) {
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new ArticleFetchError("ERR-TOO-LARGE", "That page is too large to scan.");
  }

  if (!res.body) {
    return res.text();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ArticleFetchError("ERR-TOO-LARGE", "That page is too large to scan.");
    }
    html += decoder.decode(value, { stream: true });
  }
  html += decoder.decode();
  return html;
}

// Rejects hostnames that resolve to loopback, private, or link-local/
// reserved addresses - the core SSRF defense for a public "fetch any URL"
// surface. Called on every redirect hop (see fetchWithGuard above), not
// just the original URL.
async function assertHostIsPublic(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new ArticleFetchError("ERR-BLOCKED", "That address isn't allowed.");
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ArticleFetchError("ERR-NET", "Couldn't resolve that hostname.");
  }
  if (!addresses.length) {
    throw new ArticleFetchError("ERR-NET", "Couldn't resolve that hostname.");
  }
  // Every resolved address must be public - a hostname with even one
  // private/internal A or AAAA record is rejected outright rather than
  // picking-and-hoping, since we don't control which address Node's
  // fetch actually connects to.
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new ArticleFetchError("ERR-BLOCKED", "That address isn't allowed.");
    }
  }
}

function isPrivateOrReservedIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return true; // not a valid IP at all - block rather than risk it
}

function isPrivateV4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true;                             // 10.0.0.0/8
  if (a === 127) return true;                             // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;                 // 169.254.0.0/16 (link-local, incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                  // 192.168.0.0/16
  if (a === 0) return true;                                 // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64.0.0/10 (CGNAT)
  return false;
}

function isPrivateV6(address) {
  const a = address.toLowerCase();
  if (a === "::1" || a === "::") return true;                // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;              // fe80::/10 link-local
  if (a.startsWith("fc") || a.startsWith("fd")) return true;  // fc00::/7 unique local
  if (a.startsWith("::ffff:")) return isPrivateV4(a.slice(7)); // IPv4-mapped
  return false;
}
