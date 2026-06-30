'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// customer-progress.js — lifetime-vs-current-period split, computed not stored.
//
// A: Customer with prior-period (May/June) history + nothing yet in the new
//    period (July) → lifetime totals reflect all history, current-period is 0.
// B: Same customer makes a purchase in the new period → current-period now
//    reflects only that new entry; lifetime total grows to include it too.
// C: Tier is untouched by any of this.
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');

// ── In-memory Firestore mock ───────────────────────────────────────────────────

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
        store.set(docPath, opts?.merge ? { ...(store.get(docPath) ?? {}), ...data } : data);
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

  const mockDb = { collection: makeCollectionRef };
  return { store, mockDb };
}

const ROOT = pathMod.resolve(__dirname, '..');

function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

function freshModule(mockDb) {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: mockDb, admin: {} });
  delete require.cache[require.resolve('./customer-progress')];
  delete require.cache[require.resolve('./reward-calculator')];
  delete require.cache[require.resolve('./ledger-writer')];
  delete require.cache[require.resolve('./customer-schema')];
  return require('./customer-progress');
}

const { fiscalPeriodKey } = (() => {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: { collection: () => ({}) }, admin: {} });
  delete require.cache[require.resolve('./customer-schema')];
  return require('./customer-schema');
})();

function entryPath(mobile, id, dateStr, entryId) {
  const storageKey = fiscalPeriodKey(new Date(dateStr), false);
  return `customers/${mobile}/ids/${id}/periods/${storageKey}/st_rupees_ledger/ledger/entries/${entryId}`;
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓  ${label}`); pass++; }
  else      { console.log(`  ✗  ${label}  —  ${detail}`); fail++; }
}

async function run() {
  const { store, mockDb } = makeStore();
  const cp = freshModule(mockDb);

  const mobile = '7001234567';
  // AB ID customer with two prior-period (May, June) credit entries — Rs 100 + Rs 150 earned,
  // and one debit (redemption) of Rs 40 in June. current_balance reflects net of all of it.
  store.set(`customers/${mobile}`, {
    profile: { name: 'Prior History Customer', linked_ids: [{ id: 'AB_PRIOR', type: 'ab_id' }], tier: 'Gold' },
  });
  store.set(`customers/${mobile}/ids/AB_PRIOR`, { current_balance: 210, debt: 0 });
  store.set(entryPath(mobile, 'AB_PRIOR', '2026-05-10', 'e1'), {
    type: 'credit', reason: 'base (guaranteed)', amount: 100, bill_number: 'B1',
    timestamp: '2026-05-10T10:00:00.000Z',
  });
  store.set(entryPath(mobile, 'AB_PRIOR', '2026-06-29', 'e2'), {
    type: 'credit', reason: 'growth bonus (period end)', amount: 150, bill_number: 'BONUS-2026-06',
    timestamp: '2026-06-29T10:00:00.000Z',
  });
  store.set(entryPath(mobile, 'AB_PRIOR', '2026-06-15', 'e3'), {
    type: 'debit', reason: 'counter redemption', amount: 40, bill_number: null,
    timestamp: '2026-06-15T12:00:00.000Z',
  });

  // ── TEST A: "today" = July 5 — a brand-new period with zero entries in it yet ──
  cp._setNow(() => new Date('2026-07-05'));
  const before = await cp.getCustomerProgress(mobile);

  console.log('TEST A — new period, no purchases yet:');
  console.log('  ', JSON.stringify(before));
  check('A: lifetime earned = 250 (100+150, all-time)', before.lifetime.earned === 250, String(before.lifetime.earned));
  check('A: lifetime redeemed = 40 (all-time)', before.lifetime.redeemed === 40, String(before.lifetime.redeemed));
  check('A: lifetime balance = 210 (from ledger doc, untouched)', before.lifetime.balance === 210, String(before.lifetime.balance));
  check('A: current-period earned = 0 (July has no entries yet)', before.currentPeriod.earned === 0, String(before.currentPeriod.earned));
  check('A: current-period spent = 0', before.currentPeriod.spent === 0, String(before.currentPeriod.spent));
  check('A: periodKey = 2026-07', before.periodKey === '2026-07', before.periodKey);
  check('A: tier = Gold', before.tier === 'Gold', before.tier);

  // ── TEST B: a real July purchase posts a new credit entry ──
  store.set(entryPath(mobile, 'AB_PRIOR', '2026-07-05', 'e4'), {
    type: 'credit', reason: 'base (guaranteed)', amount: 35, bill_number: 'B2',
    timestamp: '2026-07-05T09:00:00.000Z',
  });
  store.set(`customers/${mobile}/ids/AB_PRIOR`, { current_balance: 245, debt: 0 });

  const after = await cp.getCustomerProgress(mobile);
  console.log('TEST B — after a July purchase:');
  console.log('  ', JSON.stringify(after));
  check('B: lifetime earned now 285 (250 + new 35) — prior history intact, not reset', after.lifetime.earned === 285, String(after.lifetime.earned));
  check('B: lifetime redeemed still 40 (unaffected)', after.lifetime.redeemed === 40, String(after.lifetime.redeemed));
  check('B: current-period earned = 35 (only the new entry)', after.currentPeriod.earned === 35, String(after.currentPeriod.earned));
  check('B: current-period spent still 0', after.currentPeriod.spent === 0, String(after.currentPeriod.spent));
  check('B: tier still Gold — unaffected by period activity', after.tier === 'Gold', after.tier);

  console.log(`\n${fail === 0 ? 'ALL TESTS PASSED ✓' : `${fail} TEST(S) FAILED ✗`}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('SCRIPT ERROR:', e.message, e.stack); process.exit(1); });
