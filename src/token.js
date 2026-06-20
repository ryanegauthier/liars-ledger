// Liar's Ledger - src/token.js
// Manages the anonymous auth token for freemium tier enforcement.
// Loaded via importScripts in background.js (service worker context).
//
// On first install: generates a UUID, registers with the backend,
// stores in chrome.storage.sync (persists across devices if user is signed into Chrome).
//
// All proxy requests include: Authorization: Bearer <token>

const TOKEN_STORAGE_KEY = "ll_auth_token";

/**
 * Generate a UUID v4.
 */
function generateTokenId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get the stored token, or create and register a new one.
 * Returns { tokenId, tier, scansToday, limit }.
 */
async function getOrCreateToken() {
  // Check for existing token
  const stored = await new Promise((resolve) => {
    browser.storage.sync.get(TOKEN_STORAGE_KEY, (data) => {
      resolve(data[TOKEN_STORAGE_KEY] || null);
    });
  });

  if (stored?.tokenId) {
    return stored;
  }

  // Generate new token
  const tokenId = generateTokenId();

  // Register with backend
  const proxyUrl = (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL)
    || "https://api.liarsledger.com";

  try {
    const res = await fetch(`${proxyUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId }),
    });

    if (!res.ok) {
      console.warn("[token] registration failed:", res.status);
      // Store locally anyway - backend might be down; syncTier() will correct limit on next startup
      const fallback = { tokenId, tier: "free", scansToday: 0, limit: 30 };
      await storeToken(fallback);
      return fallback;
    }

    const data = await res.json();
    const tokenData = {
      tokenId,
      tier: data.tier || "free",
      scansToday: data.scansToday || 0,
      limit: data.limit || 5,
    };

    await storeToken(tokenData);
    console.log(`[token] registered: ${tokenId.slice(0, 8)}... tier=${tokenData.tier}`);
    return tokenData;
  } catch (e) {
    console.warn("[token] registration error:", e.message);
    const fallback = { tokenId, tier: "free", scansToday: 0, limit: 30 };
    await storeToken(fallback);
    return fallback;
  }
}

/**
 * Store token data in chrome.storage.sync.
 */
async function storeToken(tokenData) {
  return new Promise((resolve) => {
    browser.storage.sync.set({ [TOKEN_STORAGE_KEY]: tokenData }, resolve);
  });
}

/**
 * Get just the token ID string (for Authorization header).
 * Initializes if needed.
 */
async function getTokenId() {
  const data = await getOrCreateToken();
  return data.tokenId;
}

/**
 * Update stored scan info after a response from the backend.
 */
async function updateScanInfo(scanInfo) {
  const stored = await new Promise((resolve) => {
    browser.storage.sync.get(TOKEN_STORAGE_KEY, (data) => {
      resolve(data[TOKEN_STORAGE_KEY] || {});
    });
  });

  await storeToken({
    ...stored,
    tier: scanInfo.tier || stored.tier,
    scansToday: scanInfo.scansToday ?? stored.scansToday,
    limit: scanInfo.limit ?? stored.limit,
    remaining: scanInfo.remaining ?? stored.remaining,
    // Present only when /api/scan-status reports a failure-driven downgrade
    // (see store.js's square:downgradereason key) — null/undefined the rest
    // of the time, including immediately after a successful resubscribe.
    // Explicitly falling through to null (not stored.downgradeReason) when
    // absent from the response, so a stale value can't linger in storage
    // after the backend has cleared it server-side.
    downgradeReason: scanInfo.downgradeReason ?? null,
  });
}

/**
 * Build Authorization header object for fetch calls.
 */
async function authHeaders() {
  const tokenId = await getTokenId();
  return { "Authorization": `Bearer ${tokenId}` };
}

async function syncTier() {
  const tokenData = await getOrCreateToken();
  const proxyUrl = (typeof CONFIG !== "undefined" && CONFIG.PROXY_URL)
    || "https://api.liarsledger.com";
  try {
    const res = await fetch(`${proxyUrl}/api/scan-status`, {
      headers: { "Authorization": `Bearer ${tokenData.tokenId}` },
    });
    if (res.ok) {
      const status = await res.json();
      if (status.tier !== tokenData.tier) {
        console.log(`[token] tier synced: ${tokenData.tier} → ${status.tier}`);
      }
      await updateScanInfo(status);
    }
  } catch (e) {}
}