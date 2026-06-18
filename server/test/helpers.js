// server/test/helpers.js
// Shared config and utilities for the test suite.
//
// Required environment variables (set these before running tests, e.g. in a
// .env.test file loaded by your test runner, or exported in your shell):
//   API_BASE      - base URL of the server under test, e.g. https://api.liarsledger.com
//   ADMIN_SECRET  - same value as the server's ADMIN_SECRET env var
//   TEST_TOKEN    - a real, already-registered token UUID to use for tests.
//                    Tests will flip this token's tier and reset its scan
//                    count freely — do not use a real user's token.
//
// These tests run against a REAL server (local or deployed) and a REAL
// Redis-backed token. There is no mocking. Tests that call /api/claude/extract
// or /api/mistral/extract incur real, small API costs (~$0.001/call) — those
// live in test/cost/ and do not run by default. See package.json scripts.

export const API_BASE = process.env.API_BASE || "https://api.liarsledger.com";
export const ADMIN_SECRET = process.env.ADMIN_SECRET;
export const TEST_TOKEN = process.env.TEST_TOKEN;

if (!ADMIN_SECRET) {
  throw new Error(
    "ADMIN_SECRET environment variable is required to run tests. " +
    "This must match the server's ADMIN_SECRET so the test suite can flip " +
    "tiers and reset scan counts on the test token."
  );
}

if (!TEST_TOKEN) {
  throw new Error(
    "TEST_TOKEN environment variable is required to run tests. " +
    "This must be a real, already-registered token UUID. The test suite " +
    "will repeatedly change its tier and scan count — never point this at " +
    "a real user's token."
  );
}

/**
 * Make a request to the API under test. Thin wrapper around fetch that
 * returns { status, body } for easy assertion, and never throws on a
 * non-2xx status (tests need to assert on 403s, 429s, etc. directly).
 */
export async function api(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let parsedBody;
  try {
    parsedBody = await res.json();
  } catch {
    parsedBody = null;
  }

  return { status: res.status, body: parsedBody };
}

/**
 * Authorization header for the test token, matching how the extension
 * actually authenticates (Authorization: Bearer <tokenId>).
 */
export function authHeaders(tokenId = TEST_TOKEN) {
  return { Authorization: `Bearer ${tokenId}` };
}

/**
 * Admin header for hitting /admin/* routes.
 */
export function adminHeaders() {
  return { "x-admin-key": ADMIN_SECRET };
}

/**
 * Set the test token's tier via the admin endpoint. Throws if it fails -
 * tests rely on this working correctly as setup, so a silent failure here
 * would produce confusing downstream test failures instead of a clear one.
 */
export async function setTestTokenTier(tier) {
  const { status, body } = await api("/admin/set-tier", {
    method: "POST",
    headers: adminHeaders(),
    body: { tokenId: TEST_TOKEN, tier },
  });
  if (status !== 200 || body?.tier !== tier) {
    throw new Error(
      `Failed to set test token tier to "${tier}": ` +
      `status=${status} body=${JSON.stringify(body)}`
    );
  }
}

/**
 * Reset the test token's scan count for today via the admin endpoint.
 */
export async function resetTestTokenScans() {
  const { status, body } = await api("/admin/reset-scans", {
    method: "POST",
    headers: adminHeaders(),
    body: { tokenId: TEST_TOKEN },
  });
  if (status !== 200) {
    throw new Error(
      `Failed to reset test token scans: status=${status} body=${JSON.stringify(body)}`
    );
  }
}

/**
 * Generate a throwaway random token ID for tests that need a token that
 * has never been registered (e.g. testing /register's "created" path).
 * Not the same format requirement as the extension's UUID generator -
 * just needs to be unique and pass the >=16 char check in /register.
 */
export function freshTokenId() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
