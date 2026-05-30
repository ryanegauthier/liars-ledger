// Liars Ledger - src/logger.js
// In-memory logger accessible from both background worker and popup.
// Stores logs in chrome.storage.session so they persist across
// popup open/close but clear when the browser closes.

const MAX_ENTRIES = 200;
const STORAGE_KEY = "ll_debug_log";

// Uses global 'browser' declared in background.js

// --- Write a log entry ---
async function log(level, context, message) {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const entry = `[${timestamp}] ${context}: ${message}`;

  console.log(`[Liars Ledger] ${entry}`);

  try {
    const stored = await storageGet(STORAGE_KEY) || [];
    stored.push(entry);

    // Keep only last MAX_ENTRIES
    if (stored.length > MAX_ENTRIES) {
      stored.splice(0, stored.length - MAX_ENTRIES);
    }

    await storageSet(STORAGE_KEY, stored);
  } catch (e) {
    // fail silently — logging should never break the app
  }
}

// --- Clear the log ---
async function clearLog() {
  try {
    await storageSet(STORAGE_KEY, []);
  } catch (e) {}
}

// --- Read all log entries ---
async function getLog() {
  try {
    return await storageGet(STORAGE_KEY) || [];
  } catch (e) {
    return [];
  }
}

// --- Storage helpers ---
function storageGet(key) {
  return new Promise((resolve) => {
    browser.storage.session.get(key, (result) => {
      resolve(result[key] || null);
    });
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    browser.storage.session.set({ [key]: value }, resolve);
  });
}

// --- Convenience methods ---
const logger = {
  info:  (context, msg) => log("INFO",  context, msg),
  warn:  (context, msg) => log("WARN",  context, msg),
  error: (context, msg) => log("ERROR", context, msg),
  clear: clearLog,
  getAll: getLog,
};
