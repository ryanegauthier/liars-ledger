import test from 'node:test';
import assert from 'node:assert/strict';

let importedSafeSessionSet;
let importedMaybeRunCacheMaintenance;
let importedLogger;

async function loadHelpers() {
  if (!importedSafeSessionSet) {
    await import('../cache-maintenance.js');
    await import('../logger.js');
    importedSafeSessionSet = globalThis.safeSessionSet;
    importedMaybeRunCacheMaintenance = globalThis.maybeRunCacheMaintenance;
    importedLogger = globalThis.logger;
  }

  globalThis.safeSessionSet = importedSafeSessionSet;
  globalThis.maybeRunCacheMaintenance = importedMaybeRunCacheMaintenance;
  globalThis.logger = importedLogger;
}

function resetGlobals() {
  delete globalThis.browser;
  delete globalThis.chrome;
  delete globalThis.logger;
}

function installStorageMock({ sessionState = {}, localState = {}, bytesInUse = 0, quota = 10 * 1024 * 1024 } = {}) {
  resetGlobals();

  const session = {
    QUOTA_BYTES: quota,
    getBytesInUse: async () => bytesInUse,
    get: async (key) => {
      if (key === null) return { ...sessionState };
      return { [key]: sessionState[key] };
    },
    set: async (items) => {
      Object.assign(sessionState, items);
    },
    remove: async (keys) => {
      const toRemove = Array.isArray(keys) ? keys : [keys];
      for (const key of toRemove) {
        delete sessionState[key];
      }
    },
  };

  const local = {
    get: async (key) => ({ [key]: localState[key] }),
    set: async (items) => {
      Object.assign(localState, items);
    },
  };

  const browser = {
    storage: {
      session,
      local,
    },
  };

  globalThis.browser = browser;
  globalThis.chrome = browser;
  return { sessionState, localState, session };
}

test('logger storage writes route through the quota-safe session helper', async () => {
  await loadHelpers();
  const { sessionState } = installStorageMock();
  // installStorageMock() -> resetGlobals() deletes globalThis.logger (but
  // not safeSessionSet/maybeRunCacheMaintenance, which is why only this
  // test needs this) - restore it from loadHelpers()'s cache.
  await loadHelpers();

  let safeSetCalls = 0;
  const realSafeSessionSet = globalThis.safeSessionSet;
  globalThis.safeSessionSet = async (key, value) => {
    safeSetCalls += 1;
    assert.equal(key, 'll_debug_log');
    assert.deepEqual(value, []);
  };

  await globalThis.logger.clear();

  globalThis.safeSessionSet = realSafeSessionSet;
  assert.equal(safeSetCalls, 1);
  assert.deepEqual(sessionState, {});
});

test('safeSessionSet evicts evictable cache entries before writing when usage is high', async () => {
  await loadHelpers();
  const { sessionState } = installStorageMock({
    sessionState: {
      'vs:old': { data: 'old' },
      'api:old': { data: 'old' },
      'vs:id:123': { data: 'preserve' },
      'll_results': { status: 'old' },
    },
    bytesInUse: 6_000_000,
    quota: 10_000_000,
  });

  await globalThis.safeSessionSet('ll_results', { status: 'ok' });

  assert.deepEqual(sessionState.ll_results, { status: 'ok' });
  assert.equal(sessionState['vs:old'], undefined);
  assert.equal(sessionState['api:old'], undefined);
  assert.deepEqual(sessionState['vs:id:123'], { data: 'preserve' });
});

test('maybeRunCacheMaintenance clears cache and resets the scan counter when thresholds are hit', async () => {
  await loadHelpers();
  const { sessionState, localState } = installStorageMock({
    sessionState: {
      'vs:old': { data: 'old' },
      'api:old': { data: 'old' },
      'keep': { data: 'preserve' },
    },
    localState: {
      ll_scan_count_since_maintenance: 10,
    },
  });

  await globalThis.maybeRunCacheMaintenance();

  assert.equal(localState.ll_scan_count_since_maintenance, 0);
  assert.equal(sessionState['vs:old'], undefined);
  assert.equal(sessionState['api:old'], undefined);
  assert.deepEqual(sessionState.keep, { data: 'preserve' });
});

test('safeSessionSet retries once after a quota error and still saves the value', async () => {
  await loadHelpers();
  const { sessionState, session } = installStorageMock({
    sessionState: {
      'vs:old': { data: 'old' },
    },
  });

  let attempts = 0;
  session.set = async (items) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('quota exceeded');
    }
    Object.assign(sessionState, items);
  };

  await globalThis.safeSessionSet('ll_results', { status: 'ok' });

  assert.equal(attempts, 2);
  assert.deepEqual(sessionState.ll_results, { status: 'ok' });
  assert.equal(sessionState['vs:old'], undefined);
});

test('safeSessionSet does not evict preserved VoteSmart ID cache entries', async () => {
  await loadHelpers();
  const { sessionState } = installStorageMock({
    sessionState: {
      'vs:id:123': { data: 'preserve' },
      'vs:old': { data: 'old' },
      'api:old': { data: 'old' },
    },
    bytesInUse: 6_000_000,
    quota: 10_000_000,
  });

  await globalThis.safeSessionSet('ll_results', { status: 'ok' });

  assert.deepEqual(sessionState['vs:id:123'], { data: 'preserve' });
  assert.equal(sessionState['vs:old'], undefined);
  assert.equal(sessionState['api:old'], undefined);
  assert.deepEqual(sessionState.ll_results, { status: 'ok' });
});
