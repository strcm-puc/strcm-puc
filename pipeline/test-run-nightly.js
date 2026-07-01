'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// Stub harness for run-nightly.js — all external I/O (Firestore, Telegram,
// browser scraper) is replaced with in-memory / no-op equivalents so the full
// pipeline executes without live credentials or a browser launch.
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');

// ── In-memory Firestore (identical to test-data-ingestion.js) ─────────────────

const store = new Map();

function makeDocRef(docPath) {
  return {
    _path: docPath,
    get: async () => {
      const d = store.get(docPath);
      return { exists: d !== undefined, data: () => d ?? null, id: docPath.split('/').pop() };
    },
    set: async (data, opts) => {
      if (opts?.merge) {
        store.set(docPath, { ...(store.get(docPath) ?? {}), ...data });
      } else {
        store.set(docPath, data);
      }
    },
    collection: (sub) => makeCollectionRef(`${docPath}/${sub}`),
  };
}

function makeCollectionRef(colPath) {
  return {
    _path: colPath,
    doc: (id) => {
      const docId = id !== undefined ? id : `auto_${Math.random().toString(36).slice(2)}_${Date.now()}`;
      return makeDocRef(`${colPath}/${docId}`);
    },
    add: async (data) => {
      const id = `add_${Math.random().toString(36).slice(2)}_${Date.now()}`;
      store.set(`${colPath}/${id}`, data);
      return { id };
    },
    where: (field, op, value) => ({
      limit: (n) => ({
        get: async () => {
          const prefix = colPath + '/';
          const matches = [];
          for (const [k, v] of store) {
            if (!k.startsWith(prefix)) continue;
            if (k.slice(prefix.length).includes('/')) continue;
            if (op === 'array-contains') {
              const fv = field.split('.').reduce((o, key) => o?.[key], v);
              if (Array.isArray(fv) && fv.includes(value)) {
                matches.push({ id: k.split('/').pop(), data: () => v });
                if (matches.length >= n) break;
              }
            }
          }
          return { empty: matches.length === 0, docs: matches };
        },
      }),
    }),
    get: async () => {
      // Real Firestore allows "phantom" parent docs — addressable purely by having
      // a subcollection beneath them. Dedupe on the immediate child segment.
      const prefix = colPath + '/';
      const seen   = new Map();
      for (const k of store.keys()) {
        if (!k.startsWith(prefix)) continue;
        const id = k.slice(prefix.length).split('/')[0];
        if (!seen.has(id)) seen.set(id, `${prefix}${id}`);
      }
      const docs = [...seen.entries()].map(([id, docPath]) => ({
        id, data: () => store.get(docPath) ?? {}, ref: makeDocRef(docPath),
      }));
      return { docs };
    },
  };
}

const mockAdmin = {
  firestore: { FieldValue: { serverTimestamp: () => new Date().toISOString() } },
};
const mockDb = {
  collection: makeCollectionRef,
  runTransaction: async (fn) => {
    const writes = [];
    const txn = {
      get: async (ref) => {
        const d = store.get(ref._path);
        return { exists: d !== undefined, data: () => d ?? null, id: ref._path.split('/').pop() };
      },
      set: (ref, data, opts) => { writes.push({ ref, data, opts }); },
    };
    const result = await fn(txn);
    for (const { ref, data, opts } of writes) {
      if (opts?.merge) {
        store.set(ref._path, { ...(store.get(ref._path) ?? {}), ...data });
      } else {
        store.set(ref._path, data);
      }
    }
    return result;
  },
};

// ── Suppress Telegram HTTP calls ───────────────────────────────────────────────
const https = require('https');
https.request = (_opts, callback) => {
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.write = () => {};
  req.end   = () => {
    process.nextTick(() => {
      res.emit('data', JSON.stringify({ ok: true }));
      res.emit('end');
    });
    if (callback) callback(res);
  };
  return req;
};

// ── Inject mocks into require.cache before any project module loads ────────────
function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

const ROOT = pathMod.resolve(__dirname, '..');

injectMock(pathMod.join(ROOT, 'firebase-config.js'),
  { db: mockDb, admin: mockAdmin });

injectMock(pathMod.join(ROOT, 'vault-read.js'),
  { getCredential: async () => ({ bot_token: 'test_token', admin_chat_id: '123456' }) });

// Stub the scraper — run-nightly.js destructures scrapeRcmSales (a legacy name
// that was never exported). We provide it here as a stub that returns one dummy
// AB-ID transaction so ingestTransactions has something to process.
injectMock(pathMod.join(__dirname, 'scraper.js'), {
  scrapeWithRetry: async () => ({
    transactions: [
      {
        bill_no:    'RUN001',
        date:       new Date().toISOString().slice(0, 10),
        party_code: 'AB001',
        party_name: 'Test Customer 1',
        bill_value: '3000',
        id_type:    'ab_id',
        items:      [],
      },
    ],
    pending_new_ids: [],
  }),
  scrapeYesterdaySales: async () => ({ transactions: [], pending_new_ids: [] }),
  markManuallyResolved: () => {},
});

// launch_date gate defaults to "live since 2020" so this integration test
// demonstrates the actual reward flow, not the not-yet-launched skip path.
store.set('system/config', { launch_date: '2020-01-01' });

// ── Seed the store with the customer the stub transaction references ───────────
store.set('customers/9999000001', {
  profile: {
    linked_ids:       [{ id: 'AB001', type: 'ab_id' }],
    linked_id_values: ['AB001'],
    tier_threshold:   5000,
    consecutive_months: 0,
  },
});

// ── Load run-nightly.js (all deps now see mocks) ──────────────────────────────
const { runNightly } = require('./run-nightly');

// ── Execute ───────────────────────────────────────────────────────────────────
runNightly()
  .then(() => {
    // Confirm the purchases entry landed in the store (customers/{m}/ids/{id}/periods/{key}/purchases/*)
    const prefix = 'customers/9999000001/ids/AB001/periods/';
    const entries = [...store.keys()].filter(k => prefix && k.startsWith(prefix) && /\/purchases\/[^/]+$/.test(k));
    console.log(`\n[test-runner] purchase entries written: ${entries.length}`);
    entries.forEach(k => {
      const d = store.get(k);
      console.log(`[test-runner]   → bill_no: ${d.bill_no}, amount: ${d.amount}, id_used: ${d.id_used}`);
    });

    const idDoc = store.get('customers/9999000001/ids/AB001');
    console.log(`[test-runner] Ledger balance (AB001): ${idDoc?.current_balance ?? 0}`);
    console.log('[test-runner] run-nightly.js completed without errors ✓');
  })
  .catch(err => {
    console.error('[test-runner] FATAL:', err.message, err.stack);
    process.exit(1);
  });
