'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// product-ledger.js — 6-scenario test suite
//
// 1. Non-matching product name  → no change to quantity_purchased
// 2. Partial match              → increments, product_completed stays false
// 3. Exact remaining quantity   → increments to required, flips product_completed true
// 4. Already completed          → still increments, product_completed stays true
// 5. AB ID customer             → full no-op (not a DW customer)
// 6. Duplicate bill re-ingestion→ no double-increment (handled by processed_bills guard
//                                 tested here via a full ingestTransactions round-trip)
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');

// ── Shared in-memory Firestore mock factory ───────────────────────────────────

function makeStore() {
  const store = new Map();

  function makeDocRef(docPath) {
    return {
      _path: docPath,
      get: async () => {
        const d = store.get(docPath);
        return { exists: d !== undefined, data: () => d ?? null, id: docPath.split('/').pop() };
      },
      set: async (data, opts) => {
        store.set(docPath, opts?.merge
          ? { ...(store.get(docPath) ?? {}), ...data }
          : data);
      },
      update: async (data) => {
        const existing = store.get(docPath) ?? {};
        const updated  = { ...existing };
        for (const [key, value] of Object.entries(data)) {
          if (key.includes('.')) {
            const parts = key.split('.');
            let obj = updated;
            for (let i = 0; i < parts.length - 1; i++) {
              if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) {
                obj[parts[i]] = {};
              }
              obj = obj[parts[i]];
            }
            obj[parts[parts.length - 1]] = value;
          } else {
            updated[key] = value;
          }
        }
        store.set(docPath, updated);
      },
      collection: (sub) => makeCollectionRef(`${docPath}/${sub}`),
    };
  }

  function makeCollectionRef(colPath) {
    return {
      _path: colPath,
      doc: (id) => makeDocRef(`${colPath}/${id ?? `auto_${Math.random().toString(36).slice(2)}`}`),
      add: async (data) => {
        const id = `add_${Math.random().toString(36).slice(2)}`;
        store.set(`${colPath}/${id}`, data);
        return { id };
      },
      where: (field, op, value) => ({
        limit: (n) => ({
          get: async () => {
            const prefix  = colPath + '/';
            const matches = [];
            for (const [k, v] of store) {
              if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
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
    firestore: {
      FieldValue: {
        serverTimestamp: () => new Date().toISOString(),
        increment: (n) => ({ _increment: n }),  // not used by product-ledger
      },
    },
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
        store.set(ref._path, opts?.merge
          ? { ...(store.get(ref._path) ?? {}), ...data }
          : data);
      }
      return result;
    },
  };

  return { store, mockDb, mockAdmin };
}

// ── Mock injection ─────────────────────────────────────────────────────────────

const ROOT = pathMod.resolve(__dirname, '..');

function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

// https mock — silences any Telegram calls that might leak through
const https = require('https');
https.request = (opts, callback) => {
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.write = () => {};
  req.end   = () => { process.nextTick(() => { res.emit('data', '{"ok":true}'); res.emit('end'); }); if (callback) callback(res); };
  return req;
};

injectMock(pathMod.join(ROOT, 'vault-read.js'), {
  getCredential: async () => ({ bot_token: 'test', admin_chat_id: '0' }),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const PERIOD_KEY = '2026-Q2';   // calendar label (June 2026, runs on a Q2 day)

function freshPL(store, mockDb, mockAdmin) {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: mockDb, admin: mockAdmin });
  delete require.cache[require.resolve('./product-ledger')];
  delete require.cache[require.resolve('./customer-schema')];
  const pl = require('./product-ledger');
  // Lock time to June 29, 2026 (Q2)
  pl._setNow(() => new Date('2026-06-29'));
  return pl;
}

const { fiscalPeriodKey } = (() => {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: { collection: () => ({}) }, admin: {} });
  delete require.cache[require.resolve('./customer-schema')];
  return require('./customer-schema');
})();
const STORAGE_KEY = fiscalPeriodKey(new Date('2026-06-29'), true); // FY2627-Q1

function targetPath(mobile, id) {
  return `customers/${mobile}/ids/${id}/periods/${STORAGE_KEY}`;
}

function seedDwCustomer(store, mobile, dwId, targetOverrides = {}) {
  store.set(`customers/${mobile}`, {
    profile: { linked_ids: [{ id: dwId, type: 'display_wall' }], linked_id_values: [dwId], name: 'DW Test', tier: 'Saathi' },
  });
  store.set(targetPath(mobile, dwId), {
    target: {
      period_key:        PERIOD_KEY,
      growth_threshold:  100000,
      product_completed: false,
      recommended_product: {
        product_name:       'Nitri Charged Man',
        quantity_required:  20,
        quantity_purchased: 5,
      },
      ...targetOverrides,
    },
  });
}

function seedAbCustomer(store, mobile, abId) {
  store.set(`customers/${mobile}`, {
    profile: { linked_ids: [{ id: abId, type: 'ab_id' }], linked_id_values: [abId], name: 'AB Test', tier: 'Saathi' },
  });
  store.set(targetPath(mobile, abId), {
    target: {
      period_key:        PERIOD_KEY,
      recommended_product: {
        product_name:       'Nitri Charged Man',
        quantity_required:  20,
        quantity_purchased: 5,
      },
    },
  });
}

const MATCHING_ITEMS  = [{ 'Item Name': 'Nitri Charged Man', 'Qty': '3' }];
const NONMATCH_ITEMS  = [{ 'Item Name': 'Aloe Vera Juice',   'Qty': '10' }];

// ══════════════════════════════════════════════════════════════════════════════
// TEST 1 — Non-matching product name → no change
// ══════════════════════════════════════════════════════════════════════════════
async function runTest1() {
  const { store, mockDb, mockAdmin } = makeStore();
  const pl = freshPL(store, mockDb, mockAdmin);
  const mobile = '7010000001';
  const dwId   = '60100001';
  seedDwCustomer(store, mobile, dwId);

  await pl.updateProductLedger(mobile, dwId, NONMATCH_ITEMS);

  const doc  = store.get(targetPath(mobile, dwId))?.target;
  const qty  = doc?.recommended_product?.quantity_purchased;
  const flag = doc?.product_completed;

  return {
    name: '1 — Non-matching item → no change',
    qty,
    flag,
    pass: qty === 5 && flag === false,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 2 — Partial match: increments quantity, product_completed stays false
// Current purchased=5, requirement=20, match=3 → new=8, completed=false.
// ══════════════════════════════════════════════════════════════════════════════
async function runTest2() {
  const { store, mockDb, mockAdmin } = makeStore();
  const pl = freshPL(store, mockDb, mockAdmin);
  const mobile = '7010000002';
  const dwId   = '60100002';
  seedDwCustomer(store, mobile, dwId);

  await pl.updateProductLedger(mobile, dwId, MATCHING_ITEMS);  // +3

  const doc  = store.get(targetPath(mobile, dwId))?.target;
  const qty  = doc?.recommended_product?.quantity_purchased;
  const flag = doc?.product_completed;

  return {
    name: '2 — Partial match (+3 → 8/20): stays false',
    qty,
    flag,
    pass: qty === 8 && flag === false,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 3 — Exact remaining quantity: flips product_completed to true
// Current purchased=15, requirement=20, match=5 → new=20, completed=true.
// ══════════════════════════════════════════════════════════════════════════════
async function runTest3() {
  const { store, mockDb, mockAdmin } = makeStore();
  const pl = freshPL(store, mockDb, mockAdmin);
  const mobile = '7010000003';
  const dwId   = '60100003';
  seedDwCustomer(store, mobile, dwId, {
    recommended_product: {
      product_name:       'Nitri Charged Man',
      quantity_required:  20,
      quantity_purchased: 15,
    },
  });

  await pl.updateProductLedger(mobile, dwId, [{ 'Item Name': 'Nitri Charged Man', 'Qty': '5' }]);

  const doc  = store.get(targetPath(mobile, dwId))?.target;
  const qty  = doc?.recommended_product?.quantity_purchased;
  const flag = doc?.product_completed;

  return {
    name: '3 — Exact remaining (15+5=20/20): flips true',
    qty,
    flag,
    pass: qty === 20 && flag === true,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 4 — Already completed: still increments, does NOT flip back to false
// Current purchased=20, product_completed=true, match=5 → new=25, still true.
// ══════════════════════════════════════════════════════════════════════════════
async function runTest4() {
  const { store, mockDb, mockAdmin } = makeStore();
  const pl = freshPL(store, mockDb, mockAdmin);
  const mobile = '7010000004';
  const dwId   = '60100004';
  seedDwCustomer(store, mobile, dwId, {
    product_completed: true,
    recommended_product: {
      product_name:       'Nitri Charged Man',
      quantity_required:  20,
      quantity_purchased: 20,
    },
  });

  await pl.updateProductLedger(mobile, dwId, [{ 'Item Name': 'Nitri Charged Man', 'Qty': '5' }]);

  const doc  = store.get(targetPath(mobile, dwId))?.target;
  const qty  = doc?.recommended_product?.quantity_purchased;
  const flag = doc?.product_completed;

  return {
    name: '4 — Already completed (20+5=25): stays true, does not reset',
    qty,
    flag,
    pass: qty === 25 && flag === true,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 5 — AB ID customer with matching product name → full no-op
// AB IDs do not start with '60', so isDW=false → return immediately.
// ══════════════════════════════════════════════════════════════════════════════
async function runTest5() {
  const { store, mockDb, mockAdmin } = makeStore();
  const pl = freshPL(store, mockDb, mockAdmin);
  const mobile = '7010000005';
  const abId   = '12345678';
  seedAbCustomer(store, mobile, abId);  // AB ID — not DW

  await pl.updateProductLedger(mobile, abId, MATCHING_ITEMS);

  const doc  = store.get(targetPath(mobile, abId))?.target;
  const qty  = doc?.recommended_product?.quantity_purchased;

  return {
    name: '5 — AB ID customer: full no-op despite matching item',
    qty,
    pass: qty === 5,  // unchanged — update() was never called
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 6 — Duplicate bill via ingestTransactions: no double-increment
// First ingest: bill 9001 processes → quantity_purchased increments by 3 → 8.
// Second ingest of same bill: processed_bills guard fires → updateProductLedger
// is never called → quantity_purchased stays 8 (not 11).
// ══════════════════════════════════════════════════════════════════════════════
async function runTest6() {
  const { store, mockDb, mockAdmin } = makeStore();

  // Inject mocks BEFORE loading any module that touches firebase-config
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: mockDb, admin: mockAdmin });
  delete require.cache[require.resolve('./product-ledger')];
  delete require.cache[require.resolve('./ledger-writer')];
  delete require.cache[require.resolve('./base-reward-calculator')];
  delete require.cache[require.resolve('./data-ingestion')];
  delete require.cache[require.resolve('./reward-calculator')];
  delete require.cache[require.resolve('./customer-schema')];
  const pl = require('./product-ledger');
  pl._setNow(() => new Date('2026-06-29'));

  const { ingestTransactions } = require('./data-ingestion');

  const mobile = '7010000006';
  const dwId   = '60100006';

  // Seed customer (linked ID makes it resolvable)
  store.set(`customers/${mobile}`, {
    profile: { linked_ids: [{ id: dwId, type: 'display_wall' }], linked_id_values: [dwId], name: 'DW Dup Test', tier: 'Saathi' },
  });
  store.set(targetPath(mobile, dwId), {
    target: {
      period_key:        PERIOD_KEY,
      growth_threshold:  100000,
      product_completed: false,
      recommended_product: {
        product_name:       'Nitri Charged Man',
        quantity_required:  20,
        quantity_purchased: 5,
      },
    },
  });

  // party code → mobile via array-contains lookup is handled by resolveMobile
  // which queries customers where profile.linked_id_values array-contains the party code.
  // The store uses the mockDb.collection.where path which is already set up above.

  const tx = {
    bill_no:    '9001',
    date:       '2026-06-29',
    party_code: dwId,
    party_name: 'DW Dup Test',
    bill_value: '5000',
    id_type:    'display_wall',
    items:      [{ 'Item Name': 'Nitri Charged Man', 'Qty': '3' }],
  };

  // First ingest
  await ingestTransactions([tx]);
  const afterFirst = store.get(targetPath(mobile, dwId))?.target;
  const qtyAfterFirst = afterFirst?.recommended_product?.quantity_purchased;

  // Second ingest of same bill
  await ingestTransactions([tx]);
  const afterSecond = store.get(targetPath(mobile, dwId))?.target;
  const qtyAfterSecond = afterSecond?.recommended_product?.quantity_purchased;

  return {
    name: '6 — Duplicate bill: processed_bills guard prevents double-increment',
    qtyAfterFirst,
    qtyAfterSecond,
    pass: qtyAfterFirst === 8 && qtyAfterSecond === 8,
  };
}

// ── Run all tests ──────────────────────────────────────────────────────────────

async function run() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  product-ledger.js — 6-scenario test suite');
  console.log('══════════════════════════════════════════════════════════════════\n');

  const tests = [runTest1, runTest2, runTest3, runTest4, runTest5, runTest6];
  const results = [];
  for (const fn of tests) results.push(await fn());

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════════');

  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    console.log(`  ${icon}  ${r.name}`);
    if (r.qty          !== undefined) console.log(`       quantity_purchased: ${r.qty}`);
    if (r.qtyAfterFirst  !== undefined) console.log(`       qty after 1st ingest: ${r.qtyAfterFirst}`);
    if (r.qtyAfterSecond !== undefined) console.log(`       qty after 2nd ingest: ${r.qtyAfterSecond}`);
    if (r.flag         !== undefined) console.log(`       product_completed: ${r.flag}`);
    if (!r.pass) allPass = false;
  }

  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log(allPass ? '  ALL TESTS PASSED ✓' : '  SOME TESTS FAILED ✗');
  console.log('══════════════════════════════════════════════════════════════════\n');

  if (!allPass) process.exit(1);
}

run().catch(err => {
  console.error('[test] FATAL:', err.message, err.stack);
  process.exit(1);
});
