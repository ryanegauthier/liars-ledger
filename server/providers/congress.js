// server/providers/congress.js
// Congress.gov API proxy provider.

const BASE_URL = "https://api.congress.gov/v3";

async function congressFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Congress.gov ${res.status} on ${path}`);
  return res.json();
}

export const congress = { fetch: congressFetch };
