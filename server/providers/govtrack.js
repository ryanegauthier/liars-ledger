// server/providers/govtrack.js
// GovTrack + congress-legislators proxy provider.
// Neither upstream requires an API key, but routing them server-side keeps the
// extension from contacting third-party hosts directly (no user IP exposure)
// and lets us drop those host_permissions from the manifest.

const GOVTRACK_BASE   = "https://www.govtrack.us/api/v2";
const LEGISLATORS_URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json";

// The legislators dataset is a large (~4MB), rarely-changing static file.
// Cache it in memory so we don't refetch it on every client request.
const LEGISLATORS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _legislators   = null;
let _legislatorsAt = 0;

async function govtrackFetch(path) {
  const res = await fetch(`${GOVTRACK_BASE}${path}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GovTrack ${res.status} on ${path}`);
  return res.json();
}

async function legislators() {
  const now = Date.now();
  if (_legislators && now - _legislatorsAt < LEGISLATORS_TTL_MS) return _legislators;

  const res = await fetch(LEGISLATORS_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`legislators fetch ${res.status}`);
  _legislators   = await res.json();
  _legislatorsAt = now;
  return _legislators;
}

export const govtrack = { fetch: govtrackFetch, legislators };
