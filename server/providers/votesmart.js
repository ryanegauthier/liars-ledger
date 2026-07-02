// server/providers/votesmart.js
// VoteSmart v2 API proxy provider.
// Handles JWT auth + automatic token refresh.
// CORS blocked from browser - must go through this proxy.

const VS_BASE     = "https://app.votesmart-api.org";
const VS_LOGIN    = `${VS_BASE}/auth/login`;
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

let _token        = null;
let _expiresAt    = 0;
let _tokenPromise = null; // in-flight promise - prevents concurrent refresh stampede

async function getToken() {
  const now = Date.now();
  if (_token && now < _expiresAt - REFRESH_BUFFER_MS) return _token;

  // If a refresh is already in flight, wait for it instead of firing another
  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = (async () => {
    const email    = process.env.VOTESMART_EMAIL;
    const password = process.env.VOTESMART_PASSWORD;
    if (!email || !password) throw new Error("VoteSmart credentials not configured");

    const res = await fetch(VS_LOGIN, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password }),
      signal:  AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`VoteSmart auth failed: HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data  = await res.json();
    const token = data?.access_token;
    if (!token) throw new Error("VoteSmart auth returned no access_token");

    // Decode expiry from JWT payload
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      _expiresAt = (payload.exp || 0) * 1000;
    } catch {
      _expiresAt = Date.now() + 23 * 60 * 60 * 1000; // fallback: 23h
    }

    _token = token;
    console.log(`[VoteSmart] token refreshed, expires ${new Date(_expiresAt).toISOString()}`);
    return _token;
  })().finally(() => {
    _tokenPromise = null; // clear in-flight flag whether resolved or rejected
  });

  return _tokenPromise;
}

const VS_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const VS_MAX_RETRIES = 3;
const VS_RETRY_BASE_MS = 250;
const VS_RETRY_JITTER_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  return VS_RETRY_BASE_MS * attempt + Math.floor(Math.random() * VS_RETRY_JITTER_MS);
}

async function votesmartFetch(path) {
  const token = await getToken();
  let attempt = 0;

  while (true) {
    const res = await fetch(`${VS_BASE}${path}`, {
      headers: { "Authorization": `Bearer ${token}` },
      signal:  AbortSignal.timeout(15000),
    });

    if (res.ok) {
      return res.json();
    }

    const body = await res.text().catch(() => "");
    const err = new Error(`VoteSmart ${res.status} on ${path}: ${body.slice(0, 120)}`);
    err.status = res.status;

    if (VS_RETRYABLE_STATUSES.has(res.status) && attempt < VS_MAX_RETRIES) {
      attempt += 1;
      await sleep(retryDelay(attempt));
      continue;
    }

    throw err;
  }
}

export const votesmart = { fetch: votesmartFetch };
