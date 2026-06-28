'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// In-memory Firestore mock — must be injected into require.cache before any
// project module that touches firebase-config is loaded.
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');

const store = new Map();  // absolute Firestore path → doc data

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
      // No id arg → auto-generated (used by entriesRef.doc() in ledger-writer).
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
            if (k.slice(prefix.length).includes('/')) continue;  // skip sub-docs
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
      const prefix = colPath + '/';
      const docs = [];
      for (const [k, v] of store) {
        if (!k.startsWith(prefix)) continue;
        if (k.slice(prefix.length).includes('/')) continue;
        docs.push({ id: k.split('/').pop(), data: () => v });
      }
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

// ── Inject mocks before any project module loads ───────────────────────────────
function injectMock(relFromRoot, exports) {
  const resolved = pathMod.resolve(__dirname, '..', relFromRoot);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

injectMock('firebase-config.js', { db: mockDb, admin: mockAdmin });
injectMock('vault-read.js', {
  getCredential: async () => ({ bot_token: 'test_token', admin_chat_id: '123456' }),
});

// ── Load the module under test (all deps now see the mock) ────────────────────
const { ingestTransactions } = require('./data-ingestion');

// ════════════════════════════════════════════════════════════════════════════════
// Customer fixture data — pre-populated in the store before the test runs.
// ════════════════════════════════════════════════════════════════════════════════

// Case 1: AB ID — will be under tier threshold (1 000 < 5 000)
store.set('customers/9999000001', {
  profile: { linked_ids: ['AB001'], tier_threshold: 5000, consecutive_months: 0 },
});

// Case 2: AB ID — crosses tier threshold (6 000 > 5 000) and has loyalty streak (6 mo)
store.set('customers/9999000002', {
  profile: { linked_ids: ['AB002'], tier_threshold: 5000, consecutive_months: 6 },
});

// Case 3: Display Wall ID (starts with '60') — Layer 2/3 must be skipped
store.set('customers/9999000003', {
  profile: { linked_ids: ['6012345'], tier_threshold: 5000, consecutive_months: 4 },
});

// ════════════════════════════════════════════════════════════════════════════════
// Test transactions
// ════════════════════════════════════════════════════════════════════════════════

const transactions = [
  // Case 1 — AB ID under target: Layer 1 only (base 1%, no L2/L3)
  {
    bill_no:    'B001',
    date:       '27-06-2026',
    party_code: 'AB001',
    party_name: 'Test Customer 1',
    bill_value: '1000',
    id_type:    'ab_id',
    items:      [],
  },
  // Case 2 — AB ID hitting target: Layer 1 + Layer 2 (target) + Layer 3 (loyalty)
  {
    bill_no:    'B002',
    date:       '27-06-2026',
    party_code: 'AB002',
    party_name: 'Test Customer 2',
    bill_value: '6000',
    id_type:    'ab_id',
    items:      [],
  },
  // Case 3 — Display Wall ID: Layer 1 only; Layer 2/3 must be suppressed (C7)
  {
    bill_no:    'B003',
    date:       '27-06-2026',
    party_code: '6012345',
    party_name: 'Display Wall Customer',
    bill_value: '2000',
    id_type:    'display_wall',
    items:      [],
  },
  // Case 4 — Duplicate: B001 again — must be skipped with no credits applied
  {
    bill_no:    'B001',
    date:       '27-06-2026',
    party_code: 'AB001',
    party_name: 'Test Customer 1',
    bill_value: '1000',
    id_type:    'ab_id',
    items:      [],
  },
];

// ════════════════════════════════════════════════════════════════════════════════
// Run & report
// ════════════════════════════════════════════════════════════════════════════════

function getLedgerBalance(mobile, id_used) {
  const d = store.get(`customers/${mobile}/st_rupees_ledger/${id_used}`);
  return d?.current_balance ?? 0;
}

function getPurchaseSummaryCount(mobile) {
  const prefix = `customers/${mobile}/purchase_summary/`;
  let n = 0;
  for (const k of store.keys()) {
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) n++;
  }
  return n;
}

async function runTest() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  data-ingestion.js — 4-case integration test');
  console.log('══════════════════════════════════════════════════════════════\n');

  await ingestTransactions(transactions);

  // ── Expected values ──────────────────────────────────────────────────────────
  // Case 1: B001, AB001, ₹1000
  //   L1 = floor(1000 * 0.01) = 10
  //   L2 = skipped (1000 < 5000)
  //   L3 = skipped (0 < 3 months)
  //   expected balance = 10
  //
  // Case 2: B002, AB002, ₹6000
  //   L1 = floor(6000 * 0.01) = 60
  //   L2 = floor((6000 - 5000) * 0.005) = floor(5) = 5
  //   L3 = floor(6/3) * 2 = 4
  //   expected balance = 69
  //
  // Case 3: B003, 6012345, ₹2000
  //   L1 = floor(2000 * 0.01) = 20
  //   L2/L3 = skipped (Display Wall, C7)
  //   expected balance = 20
  //
  // Case 4: B001 duplicate → skipped, no extra credits applied

  const b1 = getLedgerBalance('9999000001', 'AB001');
  const b2 = getLedgerBalance('9999000002', 'AB002');
  const b3 = getLedgerBalance('9999000003', '6012345');
  const b1dup = getLedgerBalance('9999000001', 'AB001'); // same as b1 — dup must not add

  const ps1 = getPurchaseSummaryCount('9999000001');
  const ps2 = getPurchaseSummaryCount('9999000002');
  const ps3 = getPurchaseSummaryCount('9999000003');

  const b001processed = store.has('processed_bills/B001');
  const b002processed = store.has('processed_bills/B002');
  const b003processed = store.has('processed_bills/B003');

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════');

  function check(label, actual, expected) {
    const pass = actual === expected;
    console.log(`  ${pass ? '✓' : '✗'}  ${label}: ${actual} ${pass ? '' : `(expected ${expected})`}`);
    return pass;
  }

  let allPass = true;
  allPass &= check('Case 1 — AB ID under target   | balance (AB001)', b1, 10);
  allPass &= check('Case 1 — purchase_summary rows', ps1, 1);
  allPass &= check('Case 2 — AB ID hitting target  | balance (AB002)', b2, 69);
  allPass &= check('Case 2 — purchase_summary rows', ps2, 1);
  allPass &= check('Case 3 — Display Wall          | balance (6012345)', b3, 20);
  allPass &= check('Case 3 — purchase_summary rows', ps3, 1);
  allPass &= check('Case 4 — Duplicate B001        | balance unchanged', b1dup, 10);
  allPass &= check('Idempotency records: B001', b001processed, true);
  allPass &= check('Idempotency records: B002', b002processed, true);
  allPass &= check('Idempotency records: B003', b003processed, true);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(allPass ? '  ALL CASES PASSED ✓' : '  SOME CASES FAILED ✗');
  console.log('══════════════════════════════════════════════════════════════\n');
}

runTest().catch(err => {
  console.error('[test] FATAL:', err.message, err.stack);
  process.exit(1);
});
