'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// leaderboard.js — ranking + top-10 cutoff test, 12 sample customers (7 AB ID, 5 DW)
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');

// ── In-memory Firestore mock (same shape as test-reward-calculator.js) ────────

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

// ── Inject mocks + load module fresh ───────────────────────────────────────────

const ROOT = pathMod.resolve(__dirname, '..');

function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

function freshLeaderboard(mockDb) {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: mockDb, admin: {} });
  delete require.cache[require.resolve('./leaderboard')];
  delete require.cache[require.resolve('./reward-calculator')];
  delete require.cache[require.resolve('./ledger-writer')];
  delete require.cache[require.resolve('./customer-schema')];
  return require('./leaderboard');
}

const { fiscalPeriodKey } = (() => {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: { collection: () => ({}) }, admin: {} });
  delete require.cache[require.resolve('./customer-schema')];
  return require('./customer-schema');
})();

// ── Seed helpers ────────────────────────────────────────────────────────────────

function seedAbCustomer(store, mobile, name, pvEntries) {
  const idVal = `AB_${mobile}`;
  store.set(`customers/${mobile}`, { profile: { name, linked_ids: [{ id: idVal, type: 'ab_id' }], tier: 'Saathi' } });
  const storageKey = fiscalPeriodKey(new Date('2026-07-05'), false);
  pvEntries.forEach((pv, i) => {
    store.set(`customers/${mobile}/ids/${idVal}/periods/${storageKey}/purchases/h${i}`, { date: '2026-07-05', amount: '0', pv });
  });
}

function seedDwCustomer(store, mobile, name, quarterAmounts) {
  const idVal = `60${mobile}`;
  store.set(`customers/${mobile}`, { profile: { name, linked_ids: [{ id: idVal, type: 'display_wall' }], tier: 'Saathi' } });
  quarterAmounts.forEach((entry, i) => {
    const storageKey = fiscalPeriodKey(new Date(entry.date), true);
    store.set(`customers/${mobile}/ids/${idVal}/periods/${storageKey}/purchases/h${i}`, { date: entry.date, amount: String(entry.amount), pv: null });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Build 12 customers: 7 AB ID (varying cumulative PV) + 5 DW (varying Q3 2026 total)
// "Today" is pinned to 2026-07-15 → current DW quarter is 2026-Q3 (Jul-Sep).
// ══════════════════════════════════════════════════════════════════════════════

async function run() {
  const { store, mockDb } = makeStore();
  const lb = freshLeaderboard(mockDb);
  lb._setNow(() => new Date('2026-07-15'));

  // 7 AB ID customers — cumulative PV across all time (not period-filtered)
  seedAbCustomer(store, '7000000001', 'AB Customer 1', [50, 30]);        // total PV 80
  seedAbCustomer(store, '7000000002', 'AB Customer 2', [500]);           // total PV 500 — highest
  seedAbCustomer(store, '7000000003', 'AB Customer 3', [10, 10, 10]);    // total PV 30
  seedAbCustomer(store, '7000000004', 'AB Customer 4', [200]);           // total PV 200
  seedAbCustomer(store, '7000000005', 'AB Customer 5', [0]);             // total PV 0 — excluded
  seedAbCustomer(store, '7000000006', 'AB Customer 6', [150, 150]);      // total PV 300
  seedAbCustomer(store, '7000000007', 'AB Customer 7', [400]);           // total PV 400

  // 5 DW customers — current-quarter (2026-Q3) purchase amount only;
  // older-quarter purchases must NOT count toward the ranking.
  seedDwCustomer(store, '6000000001', 'DW Customer 1', [
    { date: '2026-07-10', amount: 9000 },
    { date: '2026-04-10', amount: 99999 }, // prior quarter — must be excluded
  ]); // Q3 total: 9000
  seedDwCustomer(store, '6000000002', 'DW Customer 2', [
    { date: '2026-08-01', amount: 15000 },
  ]); // Q3 total: 15000 — highest
  seedDwCustomer(store, '6000000003', 'DW Customer 3', [
    { date: '2026-09-30', amount: 3000 },
  ]); // Q3 total: 3000
  seedDwCustomer(store, '6000000004', 'DW Customer 4', [
    { date: '2026-04-15', amount: 50000 }, // prior quarter only
  ]); // Q3 total: 0 — excluded
  seedDwCustomer(store, '6000000005', 'DW Customer 5', [
    { date: '2026-07-20', amount: 5000 },
    { date: '2026-08-20', amount: 5000 },
  ]); // Q3 total: 10000

  const { abLeaderboard, dwLeaderboard } = await lb.getLeaderboards();

  let pass = 0, fail = 0;
  function check(label, cond, detail) {
    if (cond) { console.log(`  ✓  ${label}`); pass++; }
    else      { console.log(`  ✗  ${label}  —  ${detail}`); fail++; }
  }

  console.log('AB ID leaderboard (by cumulative PV):');
  abLeaderboard.forEach(e => console.log(`    ${e.name}: ${e.totalPv}`));
  console.log('DW leaderboard (by Q3 2026 purchase amount):');
  dwLeaderboard.forEach(e => console.log(`    ${e.name}: ${e.total}`));

  check('AB leaderboard ranks #1 = Customer 2 (PV 500)', abLeaderboard[0]?.mobile === '7000000002', JSON.stringify(abLeaderboard[0]));
  check('AB leaderboard order is fully descending', abLeaderboard.every((e, i) => i === 0 || abLeaderboard[i - 1].totalPv >= e.totalPv), JSON.stringify(abLeaderboard.map(e => e.totalPv)));
  check('AB leaderboard excludes zero-PV customer', !abLeaderboard.some(e => e.mobile === '7000000005'), JSON.stringify(abLeaderboard));
  check('AB leaderboard length is 6 (7 seeded, 1 zero-PV excluded)', abLeaderboard.length === 6, String(abLeaderboard.length));

  check('DW leaderboard ranks #1 = Customer 2 (Q3 15000)', dwLeaderboard[0]?.mobile === '6000000002', JSON.stringify(dwLeaderboard[0]));
  check('DW leaderboard order is fully descending', dwLeaderboard.every((e, i) => i === 0 || dwLeaderboard[i - 1].total >= e.total), JSON.stringify(dwLeaderboard.map(e => e.total)));
  check('DW leaderboard excludes prior-quarter-only customer', !dwLeaderboard.some(e => e.mobile === '6000000004'), JSON.stringify(dwLeaderboard));
  check('DW Customer 1 total excludes prior-quarter purchase (9000, not 108999)', dwLeaderboard.find(e => e.mobile === '6000000001')?.total === 9000, JSON.stringify(dwLeaderboard.find(e => e.mobile === '6000000001')));
  check('DW leaderboard length is 4 (5 seeded, 1 zero-this-quarter excluded)', dwLeaderboard.length === 4, String(dwLeaderboard.length));

  // ── Top-10 cutoff test: seed 15 more AB customers, confirm only top 10 returned ──
  for (let i = 1; i <= 15; i++) {
    seedAbCustomer(store, `8000000${String(i).padStart(3, '0')}`, `Bulk ${i}`, [i]); // PV 1..15
  }
  const { abLeaderboard: abFull } = await lb.getLeaderboards();
  check('Top-10 cutoff enforced (22 eligible AB customers → exactly 10 returned)', abFull.length === 10, String(abFull.length));
  check('Top-10 cutoff keeps the highest values (#1 still PV 500)', abFull[0]?.totalPv === 500, JSON.stringify(abFull[0]));
  // Full sorted set: 500,400,300,200,80,30,15,14,13,12,11... → 10th place is PV 12 (Bulk 12)
  check('Top-10 cutoff #10 is the 10th-highest value (PV 12)', abFull[9]?.totalPv === 12, JSON.stringify(abFull[9]));

  console.log(`\n${fail === 0 ? 'ALL TESTS PASSED ✓' : `${fail} TEST(S) FAILED ✗`}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('SCRIPT ERROR:', e.message, e.stack); process.exit(1); });
