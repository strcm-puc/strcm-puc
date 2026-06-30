'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// reward-calculator.js — full test suite for the bracket-based reward formula.
// Storage layout: customers/{mobile}/ids/{id}/periods/{fiscalKey} — fiscalKey is
// a pure relabeling of the same calendar period (see customer-schema.js), so the
// expected values below are completely unchanged from before the restructure.
//
// AB ID tests (monthly):
//   A: Missed bracket (spending < 90% of avg) → 0 bonus, cons_months reset to 0
//   B: Maintenance bracket (90–104%) → +0.5%
//   C: Growth bracket (≥105%) → +1.5%
//   D: 3-month loyalty top-up fires at month 3 of streak (+0.5% of combined 3-mo total)
//   E: 3% absolute ceiling — bonus capped when L1+bonus > 3%
//   F: 80% anti-sandbagging floor applied when building rolling average
//   G: Cold-start month 1 → no bonus regardless of spend
//   H: Cold-start month 2 → target = M1 actual + Rs200; hit → Maintenance
//   I: Cold-start month 3 → target = M2 actual + Rs200; miss → 1% only
//
// Display Wall tests (quarterly):
//   J: DW Missed (spending < 110%) → 0 bonus
//   K: DW Growth target hit, product NOT confirmed → 2.5% total (+1.5%)
//   L: DW Growth target hit, product confirmed → 3% total (+2%)
//   M: DW 70% anti-sandbagging floor (lower than AB ID 80%)
//   N: DW dormant freeze — zero-spend quarter excluded from average
//   O: DW new-account onboarding (< 3 real quarters) → 108% stretch target set
//
// Message budget:
//   P: Budget exhausted → zero Claude calls, no briefing
//
// Total Claude calls across all tests: exactly 1 (Test Q's decideDailyMessage
// call — only test that exercises that path at all; setPeriodTarget and
// checkPeriodEndBonus never call Claude under the new formula).
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');

// ── In-memory Firestore mock — a generic path-keyed store, structure-agnostic ──

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
              if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {};
              obj = obj[parts[i]];
            }
            obj[parts[parts.length - 1]] = value;
          } else { updated[key] = value; }
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
              } else if (op === '==') {
                const fv = field.split('.').reduce((o, key) => o?.[key], v);
                if (fv === value) {
                  matches.push({ id: k.split('/').pop(), data: () => v });
                  if (matches.length >= n) break;
                }
              }
            }
            return { empty: matches.length === 0, docs: matches };
          },
        }),
        get: async () => {
          const prefix  = colPath + '/';
          const matches = [];
          for (const [k, v] of store) {
            if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
            if (op === '==') {
              const fv = field.split('.').reduce((o, key) => o?.[key], v);
              if (fv === value) matches.push({ id: k.split('/').pop(), data: () => v });
            }
          }
          return { empty: matches.length === 0, docs: matches };
        },
      }),
      get: async () => {
        // Real Firestore allows "phantom" parent docs — a doc is addressable purely
        // by having a subcollection beneath it, even with no data set on it directly.
        // Dedupe on the immediate child segment so deeply-nested-only docs still show up.
        const prefix = colPath + '/';
        const seen   = new Map(); // immediate child id -> full doc path
        for (const k of store.keys()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          const id   = rest.split('/')[0];
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
        store.set(ref._path, opts?.merge
          ? { ...(store.get(ref._path) ?? {}), ...data }
          : data);
      }
      return result;
    },
  };

  return { store, mockDb, mockAdmin };
}

// ── Claude call counter + response queue ───────────────────────────────────────

let claudeCallCount = 0;
const claudeResponseQueue = [];

function enqueueClaude(jsonObj) {
  claudeResponseQueue.push(JSON.stringify(jsonObj));
}

// ── https mock (intercepts all outbound calls) ────────────────────────────────

const https = require('https');
https.request = (opts, callback) => {
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.write = () => {};
  req.end   = () => {
    process.nextTick(() => {
      let body;
      if (opts?.hostname === 'api.anthropic.com') {
        claudeCallCount++;
        const text = claudeResponseQueue.shift() ?? '{"error":"no mock response queued"}';
        body = JSON.stringify({ content: [{ text }] });
      } else {
        body = JSON.stringify({ ok: true }); // Telegram / other
      }
      res.emit('data', body);
      res.emit('end');
    });
    if (callback) callback(res);
  };
  return req;
};

// ── Inject mocks + load module ────────────────────────────────────────────────

const ROOT = pathMod.resolve(__dirname, '..');

function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

injectMock(pathMod.join(ROOT, 'vault-read.js'), {
  getCredential: async (category) => {
    if (category === 'anthropic_api') return { api_key: 'test-key' };
    return { bot_token: 'test_token', admin_chat_id: '123456' };
  },
});

// checkPeriodEndBonus's Gemini aggregation pass (period-aggregator.js) calls Gemini
// via the @google/genai Vertex SDK, not raw https — mock that SDK directly so these
// tests never make a real network/API call.
let geminiAggCallCount = 0;
injectMock(require.resolve('@google/genai'), {
  GoogleGenAI: class {
    constructor() {}
    get models() {
      return {
        generateContent: async () => {
          geminiAggCallCount++;
          return { text: JSON.stringify({ summary: 'Test period summary.' }) };
        },
      };
    }
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshRC(store, mockDb, mockAdmin) {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: mockDb, admin: mockAdmin });
  delete require.cache[require.resolve('./reward-calculator')];
  delete require.cache[require.resolve('./ledger-writer')];
  delete require.cache[require.resolve('./customer-schema')];
  delete require.cache[require.resolve('./period-aggregator')];
  return require('./reward-calculator');
}

const { fiscalPeriodKey } = (() => {
  // customer-schema.js only needs a working `db.collection` at require time to not
  // throw — give it a harmless stub for this one-time key-format helper import.
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: { collection: () => ({}) }, admin: {} });
  delete require.cache[require.resolve('./customer-schema')];
  return require('./customer-schema');
})();

// Seed AB ID customer with purchase history expressed as { 'YYYY-MM': amount } map.
function seedAbHistory(store, mobile, historyMap, opts = {}) {
  const rawIds = opts.linkedIds ?? ['AB_TEST'];
  store.set(`customers/${mobile}`, {
    profile: {
      linked_ids:         rawIds.map(id => ({ id, type: 'ab_id' })),
      name:               opts.name       ?? 'Test Customer',
      gender:             opts.gender     ?? 'unknown',
      tier:               opts.tier       ?? 'Saathi',
      consecutive_months: opts.consecutive ?? 0,
    },
  });
  const primaryId = rawIds[0];
  let i = 0;
  for (const [period, amount] of Object.entries(historyMap)) {
    const dateStr    = period + '-15';
    const storageKey = fiscalPeriodKey(new Date(dateStr), false);
    store.set(`customers/${mobile}/ids/${primaryId}/periods/${storageKey}/purchases/h${i++}`, {
      date:   dateStr,
      amount: String(amount),
    });
  }
}

// Seed DW customer with purchase history expressed as { 'YYYY-Qn': amount } map.
function seedDwHistory(store, mobile, historyMap, opts = {}) {
  // Map quarter keys to representative dates so fetchPurchaseHistory groups them correctly
  const qToDate = { 'Q1': '-02-15', 'Q2': '-05-15', 'Q3': '-08-15', 'Q4': '-11-15' };
  const rawIds = opts.linkedIds ?? ['6099001'];
  store.set(`customers/${mobile}`, {
    profile: {
      linked_ids:         rawIds.map(id => ({ id, type: 'display_wall' })),
      name:               opts.name       ?? 'DW Customer',
      gender:             opts.gender     ?? 'unknown',
      tier:               opts.tier       ?? 'Saathi',
      consecutive_months: 0,
    },
  });
  const primaryId = rawIds[0];
  let i = 0;
  for (const [period, amount] of Object.entries(historyMap)) {
    const [yr, q]    = period.split('-');
    const dateStr    = yr + qToDate[q];
    const storageKey = fiscalPeriodKey(new Date(dateStr), true);
    store.set(`customers/${mobile}/ids/${primaryId}/periods/${storageKey}/purchases/h${i++}`, {
      date:   dateStr,
      amount: String(amount),
    });
  }
}

// Writes a target doc at the new nested path: customers/{mobile}/ids/{id}/periods/{storageKey}.target
function writeTarget(store, mobile, idUsed, storageKey, fields) {
  const path = `customers/${mobile}/ids/${idUsed}/periods/${storageKey}`;
  store.set(path, { ...(store.get(path) ?? {}), target: fields });
}

// Reads back the merged target+bonus object (checkPeriodEndBonus writes bracket/bonus_rs
// etc. into the SAME target field, merging with whatever setPeriodTarget already wrote).
function readPeriod(store, mobile, idUsed, storageKey) {
  return store.get(`customers/${mobile}/ids/${idUsed}/periods/${storageKey}`);
}
function readBonus(store, mobile, idUsed, storageKey) {
  return readPeriod(store, mobile, idUsed, storageKey)?.target;
}
function readLedgerBalance(store, mobile, idUsed) {
  return store.get(`customers/${mobile}/ids/${idUsed}`)?.current_balance;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST A — AB ID Missed bracket: spending < 90% of rolling average
// Setup: avg of last 3 months = 10000. Today's (June 30) actual = Rs 8000 < 9000 (90%).
// Expected: bracket=missed, bonus=0, loyalty=0, consecutive_months reset to 0.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestA() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000001';
  seedAbHistory(store, mobile, {
    '2026-03': 10000,
    '2026-04': 10000,
    '2026-05': 10000,
    '2026-06': 8000,   // < 90% of 10000 → Missed
  }, { consecutive: 5 });

  // Rolling avg = 10000. missedThreshold = 9000. 8000 < 9000 → Missed.
  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    10500,
    rolling_average:  10000,
    cold_start:       false,
    cold_start_month: null,
    missed_threshold: 9000,
    growth_threshold: 10500,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus   = readBonus(store, mobile, 'AB_TEST', 'FY2627-06');
  const profile = store.get(`customers/${mobile}`);
  const consAfter = profile?.profile?.consecutive_months ?? -1;

  return {
    name:        'A — AB ID Missed (8000 < 9000)',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    consAfter,
    pass: callsThisTest === 0 && bonus?.bracket === 'missed' && bonus?.bonus_rs === 0 && consAfter === 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST B — AB ID Maintenance bracket: 90% ≤ spending < 105%
// avg = 10000. missedThreshold = 9000. growthThreshold = 10500.
// Actual = Rs 9500 → Maintenance. bonus = floor(9500 * 0.005) = 47.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestB() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000002';
  seedAbHistory(store, mobile, {
    '2026-03': 10000,
    '2026-04': 10000,
    '2026-05': 10000,
    '2026-06': 9500,
  }, { consecutive: 1 });  // newConsecutive=2 → no loyalty top-up this month

  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    10500,
    rolling_average:  10000,
    cold_start:       false,
    cold_start_month: null,
    missed_threshold: 9000,
    growth_threshold: 10500,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus   = readBonus(store, mobile, 'AB_TEST', 'FY2627-06');
  const profile = store.get(`customers/${mobile}`);

  const expectedBonus = Math.floor(9500 * 0.005); // 47
  const consAfter     = profile?.profile?.consecutive_months ?? -1;

  return {
    name:        'B — AB ID Maintenance (9500 in [9000,10500))',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    expectedBonus,
    consAfter,
    pass: callsThisTest === 0 &&
          bonus?.bracket === 'maintenance' &&
          bonus?.bonus_rs === expectedBonus &&
          consAfter === 2,  // was 1, now 2 (not divisible by 3, no loyalty top-up)
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST C — AB ID Growth bracket: spending ≥ 105%
// avg = 10000. growthThreshold = 10500. Actual = Rs 12000 → Growth.
// bonus = floor(12000 * 0.015) = 180.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestC() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000003';
  seedAbHistory(store, mobile, {
    '2026-03': 10000,
    '2026-04': 10000,
    '2026-05': 10000,
    '2026-06': 12000,
  }, { consecutive: 1 });

  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    10500,
    rolling_average:  10000,
    cold_start:       false,
    cold_start_month: null,
    missed_threshold: 9000,
    growth_threshold: 10500,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus       = readBonus(store, mobile, 'AB_TEST', 'FY2627-06');
  const expectedBonus = Math.floor(12000 * 0.015);  // 180
  const ledgerBal    = readLedgerBalance(store, mobile, 'AB_TEST');

  return {
    name:        'C — AB ID Growth (12000 ≥ 10500)',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    expectedBonus,
    ledgerBal,
    pass: callsThisTest === 0 &&
          bonus?.bracket === 'growth' &&
          bonus?.bonus_rs === expectedBonus &&
          ledgerBal === expectedBonus,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST D — 3-month loyalty top-up fires at consecutive month 3
// Customer has consecutive_months=2. This month (Growth) makes it 3.
// 3 % 3 === 0 → loyalty top-up = 0.5% of (this month 12000 + prev 2 months 10000+10000).
// combined3 = 32000. loyaltyTopup = floor(32000 * 0.005) = 160.
// Total credited = 180 (Growth) + 160 (loyalty) = 340.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestD() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000004';
  seedAbHistory(store, mobile, {
    '2026-04': 10000,
    '2026-05': 10000,
    '2026-06': 12000,
  }, { consecutive: 2 });   // was 2, this month brings it to 3

  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    10500,
    rolling_average:  10000,
    cold_start:       false,
    cold_start_month: null,
    missed_threshold: 9000,
    growth_threshold: 10500,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus          = readBonus(store, mobile, 'AB_TEST', 'FY2627-06');
  const ledgerBal       = readLedgerBalance(store, mobile, 'AB_TEST');
  const profile        = store.get(`customers/${mobile}`);

  // Pre-cap values
  const preBonus      = Math.floor(12000 * 0.015);           // 180
  const combined3     = 12000 + 10000 + 10000;               // 32000
  const preLoyalty    = Math.floor(combined3 * 0.005);        // 160
  const preTotal      = preBonus + preLoyalty;                // 340
  // 3% ceiling: L1=120, abs3pct=360. 120+340=460 > 360 → cap.
  const l1D           = Math.floor(12000 * 0.01);             // 120
  const abs3D         = Math.floor(12000 * 0.03);             // 360
  const allowedD      = abs3D - l1D;                          // 240
  const expectedBonusRs  = Math.floor(preBonus   * allowedD / preTotal); // 127
  const expectedLoyalty  = Math.floor(preLoyalty * allowedD / preTotal); // 112
  const expectedTotal    = expectedBonusRs + expectedLoyalty;             // 239
  const consAfter        = profile?.profile?.consecutive_months ?? -1;

  return {
    name:           'D — loyalty top-up fires at 3-month streak (ceiling applies)',
    claudeCalls:    callsThisTest,
    bracket:        bonus?.bracket,
    bonusRs:        bonus?.bonus_rs,
    loyaltyTopupRs: bonus?.loyalty_topup_rs,
    ledgerBal,
    expectedBonusRs,
    expectedLoyalty,
    expectedTotal,
    consAfter,
    pass: callsThisTest === 0 &&
          bonus?.bracket === 'growth' &&
          bonus?.capped  === true &&
          bonus?.bonus_rs === expectedBonusRs &&
          bonus?.loyalty_topup_rs === expectedLoyalty &&
          ledgerBal === expectedTotal &&
          consAfter === 3,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST E — 3% absolute ceiling: L1(est) + Growth bonus must not exceed 3%
// genuine_sales = 5300, prev2 months = 45000 each, rolling avg established at 5000.
// L1(53) + growth(79) + loyalty(476) = 608 > floor(5300*0.03)=159 → capped.
// allowed=159-53=106. bonus_capped=floor(79*106/555)=15. loyalty_capped=floor(476*106/555)=90.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestE() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000005b';
  store.set(`customers/${mobile}`, {
    profile: {
      linked_ids:         [{ id: 'AB_E', type: 'ab_id' }],
      name:               'Cap Test',
      gender:             'unknown',
      tier:               'Saathi',
      consecutive_months: 5,   // will become 6 → loyalty fires
    },
  });
  // This month: genuine_sales = 5300 (above growthThreshold 5250)
  store.set(`customers/${mobile}/ids/AB_E/periods/FY2627-06/purchases/cur`, { date: '2026-06-10', amount: '5300' });
  // Previous 2 months: 45000 each (so combined3 = 5300+45000+45000=95300)
  store.set(`customers/${mobile}/ids/AB_E/periods/FY2627-04/purchases/p1`, { date: '2026-04-10', amount: '45000' });
  store.set(`customers/${mobile}/ids/AB_E/periods/FY2627-05/purchases/p2`, { date: '2026-05-10', amount: '45000' });
  // And 3 months before that to establish rolling average = 5000
  store.set(`customers/${mobile}/ids/AB_E/periods/FY2627-03/purchases/r1`, { date: '2026-03-10', amount: '5000' });
  store.set(`customers/${mobile}/ids/AB_E/periods/FY2627-02/purchases/r2`, { date: '2026-02-10', amount: '5000' });
  store.set(`customers/${mobile}/ids/AB_E/periods/FY2627-01/purchases/r3`, { date: '2026-01-10', amount: '5000' });

  writeTarget(store, mobile, 'AB_E', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    5250,
    rolling_average:  5000,
    cold_start:       false,
    cold_start_month: null,
    missed_threshold: 4500,
    growth_threshold: 5250,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus  = readBonus(store, mobile, 'AB_E', 'FY2627-06');
  const ledgerBal = readLedgerBalance(store, mobile, 'AB_E');

  // genuine_sales=5300, growth_threshold=5250 → Growth bracket.
  // Pre-cap: bonus=floor(5300*0.015)=79, combined3=5300+45000+45000=95300,
  //          loyalty=floor(95300*0.005)=476, total=555.
  // L1=floor(5300*0.01)=53. abs3pct=floor(5300*0.03)=159. 53+555=608>159 → cap.
  // allowed=159-53=106. bonus_capped=floor(79*106/555)=15, loyalty_capped=floor(476*106/555)=90.
  const genuineE      = 5300;
  const preBonusE     = Math.floor(genuineE * 0.015);              // 79
  const combined3E    = genuineE + 45000 + 45000;                   // 95300
  const preLoyaltyE   = Math.floor(combined3E * 0.005);             // 476
  const preTotalE     = preBonusE + preLoyaltyE;                    // 555
  const l1E           = Math.floor(genuineE * 0.01);                // 53
  const abs3E         = Math.floor(genuineE * 0.03);                // 159
  const allowedE      = abs3E - l1E;                                 // 106
  const expectedBonus   = Math.floor(preBonusE   * allowedE / preTotalE); // 15
  const expectedLoyalty = Math.floor(preLoyaltyE * allowedE / preTotalE); // 90
  const expectedTotal   = expectedBonus + expectedLoyalty;                  // 105

  return {
    name:         'E — 3% absolute ceiling caps bonus+loyalty',
    claudeCalls:  callsThisTest,
    capped:       bonus?.capped,
    bonusRs:      bonus?.bonus_rs,
    loyaltyRs:    bonus?.loyalty_topup_rs,
    ledgerBal,
    expectedBonus,
    expectedLoyalty,
    expectedTotal,
    pass: callsThisTest === 0 &&
          bonus?.capped === true &&
          bonus?.bonus_rs === expectedBonus &&
          bonus?.loyalty_topup_rs === expectedLoyalty &&
          ledgerBal === expectedTotal,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST F — 80% anti-sandbagging floor for AB ID rolling average
// Periods: Apr=10000, May=2000 (sandbag), Jun (current, not in history yet).
// rawAvg of last 3 periods: Mar=10000, Apr=10000, May=2000 → rawAvg=7333.
// 80% floor: May floor = max(2000, round(7333*0.8)) = max(2000,5867) = 5867.
// floored avg = (10000+10000+5867)/3 = round(8622) = 8622.
// Expected: July's target doc has rolling_average=8622, NOT 7333.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestF() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-07-02'));  // Day 2 of July → setPeriodTarget fires

  const mobile = '7001000006';
  seedAbHistory(store, mobile, {
    '2026-04': 10000,
    '2026-05': 10000,
    '2026-06': 2000,   // deliberately low (sandbagging)
  }, { consecutive: 0 });
  // No July target yet (that's what we're testing)

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-07-02'));
  const callsThisTest = claudeCallCount - callsBefore;

  const target = readBonus(store, mobile, 'AB_TEST', 'FY2627-07');

  // raw3 = [10000, 10000, 2000], rawAvg = 7333.33
  const rawAvg   = (10000 + 10000 + 2000) / 3;
  const floor80  = Math.round(rawAvg * 0.80);           // 5867
  const floored3 = [10000, 10000, Math.max(2000, floor80)];  // [10000,10000,5867]
  const expected = Math.round(floored3.reduce((a, b) => a + b, 0) / 3); // 8622

  return {
    name:            'F — 80% anti-sandbagging floor raises depressed month',
    claudeCalls:     callsThisTest,
    rollingAvg:      target?.rolling_average,
    expectedAvg:     expected,
    rawAvgWouldBe:   Math.round(rawAvg),
    pass: callsThisTest === 0 &&
          target?.rolling_average === expected &&
          target?.rolling_average !== Math.round(rawAvg),  // floor DID change the value
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST G — Cold-start month 1: no prior history → target=0, bonus=0 always
// ══════════════════════════════════════════════════════════════════════════════
async function runTestG() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000007';
  // No purchase history at all → cold-start month 1
  store.set(`customers/${mobile}`, {
    profile: { linked_ids: [{ id: 'AB_G', type: 'ab_id' }], name: 'New', gender: 'unknown', tier: 'Saathi', consecutive_months: 0 },
  });
  // June purchases (high spend — bonus should still be 0)
  store.set(`customers/${mobile}/ids/AB_G/periods/FY2627-06/purchases/p1`, { date: '2026-06-10', amount: '50000' });

  writeTarget(store, mobile, 'AB_G', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    0,
    rolling_average:  0,
    cold_start:       true,
    cold_start_month: 1,
    missed_threshold: 0,
    growth_threshold: 0,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus = readBonus(store, mobile, 'AB_G', 'FY2627-06');

  return {
    name:        'G — Cold-start M1: bonus=0 regardless of spend',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    pass: callsThisTest === 0 && bonus?.bracket === 'missed' && bonus?.bonus_rs === 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST H — Cold-start month 2: target = M1 actual + 200; hit → Maintenance
// M1 actual = 3000. Target = 3200. This month = 4000 ≥ 3200 → Maintenance.
// bonus = floor(4000 * 0.005) = 20.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestH() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000008';
  seedAbHistory(store, mobile, {
    '2026-05': 3000,  // 1 real period → cold-start month 2
    '2026-06': 4000,
  }, { consecutive: 0 });

  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    3200,   // 3000 + 200
    rolling_average:  0,
    cold_start:       true,
    cold_start_month: 2,
    missed_threshold: 0,
    growth_threshold: 0,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus         = readBonus(store, mobile, 'AB_TEST', 'FY2627-06');
  const expectedBonus = Math.floor(4000 * 0.005); // 20

  return {
    name:        'H — Cold-start M2: hit target → Maintenance +0.5%',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    expectedBonus,
    pass: callsThisTest === 0 && bonus?.bracket === 'maintenance' && bonus?.bonus_rs === expectedBonus,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST I — Cold-start month 3: target = M2 actual + 200; miss → 1% only
// M2 actual = 3000. Target = 3200. This month = 2500 < 3200 → Missed, bonus=0.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestI() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000009';
  seedAbHistory(store, mobile, {
    '2026-04': 3000,  // M1
    '2026-05': 3000,  // M2
    '2026-06': 2500,  // M3 actual — misses 3200 target
  }, { consecutive: 0 });

  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:       '2026-06',
    target_amount:    3200,   // M2 actual (3000) + 200
    rolling_average:  0,
    cold_start:       true,
    cold_start_month: 3,
    missed_threshold: 0,
    growth_threshold: 0,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus = readBonus(store, mobile, 'AB_TEST', 'FY2627-06');

  return {
    name:        'I — Cold-start M3: miss target → 1% only, bonus=0',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    pass: callsThisTest === 0 && bonus?.bracket === 'missed' && bonus?.bonus_rs === 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST J — DW Missed: spending < 110% of rolling average
// 3 quarters avg = 10000. growthThreshold = 11000. Actual = 9000 < 11000 → Missed.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestJ() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000010';
  seedDwHistory(store, mobile, {
    '2025-Q2': 10000,
    '2025-Q3': 10000,
    '2025-Q4': 10000,
    '2026-Q2': 9000,   // actual this quarter
  });

  writeTarget(store, mobile, '6099001', 'FY2627-Q1', {
    period_key:        '2026-Q2',
    target_amount:     11000,
    rolling_average:   10000,
    new_account:       false,
    growth_threshold:  11000,
    product_completed: false,
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus = readBonus(store, mobile, '6099001', 'FY2627-Q1');

  return {
    name:        'J — DW Missed (9000 < 11000)',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    pass: callsThisTest === 0 && bonus?.bracket === 'missed' && bonus?.bonus_rs === 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST K — DW Growth, product NOT confirmed → 2.5% total (+1.5%)
// avg=10000. growthThreshold=11000. Actual=12000. product_completed=false.
// bonus = floor(12000 * 0.015) = 180.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestK() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000011';
  seedDwHistory(store, mobile, {
    '2025-Q2': 10000,
    '2025-Q3': 10000,
    '2025-Q4': 10000,
    '2026-Q2': 12000,
  });

  writeTarget(store, mobile, '6099001', 'FY2627-Q1', {
    period_key:        '2026-Q2',
    target_amount:     11000,
    rolling_average:   10000,
    new_account:       false,
    growth_threshold:  11000,
    product_completed: false,   // NOT confirmed
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus         = readBonus(store, mobile, '6099001', 'FY2627-Q1');
  const expectedBonus = Math.floor(12000 * 0.015); // 180

  return {
    name:        'K — DW Growth, no product (2.5% total, +1.5%)',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    expectedBonus,
    pass: callsThisTest === 0 && bonus?.bracket === 'growth' && bonus?.bonus_rs === expectedBonus,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST L — DW Growth + product confirmed → 3% total (+2%)
// avg=10000. growthThreshold=11000. Actual=12000. product_completed=true.
// bonus = floor(12000 * 0.02) = 240.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestL() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-30'));

  const mobile = '7001000012';
  seedDwHistory(store, mobile, {
    '2025-Q2': 10000,
    '2025-Q3': 10000,
    '2025-Q4': 10000,
    '2026-Q2': 12000,
  });

  writeTarget(store, mobile, '6099001', 'FY2627-Q1', {
    period_key:        '2026-Q2',
    target_amount:     11000,
    rolling_average:   10000,
    new_account:       false,
    growth_threshold:  11000,
    product_completed: true,   // confirmed
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-06-30'));
  const callsThisTest = claudeCallCount - callsBefore;

  const bonus         = readBonus(store, mobile, '6099001', 'FY2627-Q1');
  const expectedBonus = Math.floor(12000 * 0.02); // 240

  return {
    name:        'L — DW Growth + product confirmed (3% total, +2%)',
    claudeCalls: callsThisTest,
    bracket:     bonus?.bracket,
    bonusRs:     bonus?.bonus_rs,
    expectedBonus,
    pass: callsThisTest === 0 &&
          bonus?.bracket === 'growth_with_product' &&
          bonus?.bonus_rs === expectedBonus,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST M — DW 70% anti-sandbagging floor (lower than AB 80%)
// Quarters: Q3=10000, Q4=10000, Q1=2000. rawAvg=7333.
// 70% floor: max(2000, round(7333*0.7)) = max(2000,5133) = 5133.
// floored avg = (10000+10000+5133)/3 = round(8378) = 8378.
// growthThreshold = round(8378*1.10) = 9216.
// Test: verify rolling_average=8378 after setPeriodTarget.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestM() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-04-02'));  // Day 2 of Q2 → setPeriodTarget fires

  const mobile = '7001000013';
  seedDwHistory(store, mobile, {
    '2025-Q3': 10000,
    '2025-Q4': 10000,
    '2026-Q1': 2000,   // deliberately low
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-04-02'));
  const callsThisTest = claudeCallCount - callsBefore;

  const target = readBonus(store, mobile, '6099001', 'FY2627-Q1');

  const rawAvg   = (10000 + 10000 + 2000) / 3;
  const floor70  = Math.round(rawAvg * 0.70);
  const floored3 = [10000, 10000, Math.max(2000, floor70)];
  const expected = Math.round(floored3.reduce((a, b) => a + b, 0) / 3);

  // Also verify that 80% floor would give a different (higher) value, confirming 70% was used
  const floor80    = Math.round(rawAvg * 0.80);
  const floored80  = [10000, 10000, Math.max(2000, floor80)];
  const expected80 = Math.round(floored80.reduce((a, b) => a + b, 0) / 3);

  return {
    name:            'M — DW 70% sandbag floor (not 80%)',
    claudeCalls:     callsThisTest,
    rollingAvg:      target?.rolling_average,
    expectedWith70:  expected,
    expectedWith80:  expected80,
    pass: callsThisTest === 0 &&
          target?.rolling_average === expected &&
          target?.rolling_average !== expected80,  // 70% gives different result than 80%
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST N — DW dormant freeze: zero-spend quarter excluded from average
// Quarters with spend: Q2=10000, Q3=10000. Q4 spend=0 (dormant).
// Average must be computed from Q2+Q3 only (2 quarters), NOT including Q4.
// Expected new_account=true (< 3 real quarters), target = round(10000*1.08) = 10800.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestN() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-04-02'));  // Day 2 of Q2 2026 → setPeriodTarget fires

  const mobile = '7001000014';
  // Q4 2025 had Rs0 spend — should be excluded from average (dormant freeze)
  seedDwHistory(store, mobile, {
    '2025-Q2': 10000,
    '2025-Q3': 10000,
    // Q4 intentionally omitted (no purchase entries for it)
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-04-02'));
  const callsThisTest = claudeCallCount - callsBefore;

  const target = readBonus(store, mobile, '6099001', 'FY2627-Q1');
  const baselineAvg      = (10000 + 10000) / 2;       // 10000
  const expectedTarget   = Math.round(baselineAvg * 1.08); // 10800

  return {
    name:            'N — DW dormant freeze: zero quarter excluded, 2 real periods remain',
    claudeCalls:     callsThisTest,
    newAccount:      target?.new_account,
    quartersOnRecord: target?.quarters_on_record,
    targetAmount:    target?.target_amount,
    expectedTarget,
    pass: callsThisTest === 0 &&
          target?.new_account === true &&
          target?.quarters_on_record === 2 &&
          target?.target_amount === expectedTarget,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST O — DW new-account onboarding: < 3 real quarters → 108% stretch target
// 1 real quarter on record: Q1=8000. baseline=8000. target=round(8000*1.08)=8640.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestO() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-04-02'));  // Q2 starts

  const mobile = '7001000015';
  seedDwHistory(store, mobile, {
    '2026-Q1': 8000,  // only 1 real quarter → new account
  });

  const callsBefore = claudeCallCount;
  await rc.runNightlyRewardChecks(new Map(), new Date('2026-04-02'));
  const callsThisTest = claudeCallCount - callsBefore;

  const target          = readBonus(store, mobile, '6099001', 'FY2627-Q1');
  const expectedTarget  = Math.round(8000 * 1.08); // 8640

  return {
    name:            'O — DW new-account onboarding (1 quarter): 108% stretch',
    claudeCalls:     callsThisTest,
    newAccount:      target?.new_account,
    quartersOnRecord: target?.quarters_on_record,
    targetAmount:    target?.target_amount,
    expectedTarget,
    pass: callsThisTest === 0 &&
          target?.new_account === true &&
          target?.quarters_on_record === 1 &&
          target?.target_amount === expectedTarget,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST P — Message budget exhausted → zero Claude calls, no briefing
// Saathi = max 12/month. Budget pre-seeded at 12/12.
// ══════════════════════════════════════════════════════════════════════════════
async function runTestP() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-15'));

  const mobile = '7001000016';
  seedAbHistory(store, mobile, {
    '2026-03': 10000,
    '2026-04': 10000,
    '2026-05': 10000,
  }, { consecutive: 4 });

  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:    '2026-06',
    target_amount: 10500,
    rolling_average:  10000,
    cold_start:    false,
    cold_start_month: null,
    missed_threshold: 9000,
    growth_threshold: 10500,
  });
  const periodPath = `customers/${mobile}/ids/AB_TEST/periods/FY2627-06`;
  store.set(periodPath, {
    ...(store.get(periodPath) ?? {}),
    message_budget: { period_key: '2026-06', sent: 12, max_allowed: 12, tier: 'Saathi' },
  });

  const callsBefore = claudeCallCount;
  const result = await rc.runNightlyRewardChecks(new Map([[mobile, 5000]]), new Date('2026-06-15'));
  const callsThisTest = claudeCallCount - callsBefore;

  const briefings  = result?.briefings ?? [];
  const noBriefing = briefings.every(b => b.mobile !== mobile);

  return {
    name:        'P — Budget exhausted (12/12): zero Claude calls',
    claudeCalls: callsThisTest,
    noBriefing,
    pass: callsThisTest === 0 && noBriefing,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST Q — decideDailyMessage: the ONE test that exercises a real Claude call
// (confirms the Claude path still works after all the formula changes)
// ══════════════════════════════════════════════════════════════════════════════
async function runTestQ() {
  const { store, mockDb, mockAdmin } = makeStore();
  const rc = freshRC(store, mockDb, mockAdmin);
  rc._setNow(() => new Date('2026-06-15'));

  const mobile = '7001000017';
  seedAbHistory(store, mobile, {
    '2026-03': 10000,
    '2026-04': 10000,
    '2026-05': 10000,
  }, { consecutive: 2 });

  writeTarget(store, mobile, 'AB_TEST', 'FY2627-06', {
    period_key:    '2026-06',
    target_amount: 10500,
    rolling_average:  10000,
    cold_start:    false,
    cold_start_month: null,
    missed_threshold: 9000,
    growth_threshold: 10500,
  });

  enqueueClaude({
    send_message:      true,
    customer_name:     'Test',
    gender:            'unknown',
    what_happened:     'Purchased today',
    tone_needed:       'encouraging',
    show_rupee_amount: false,
    do_not_mention:    [],
    st_account_link:   false,
  });

  const callsBefore = claudeCallCount;
  const result = await rc.runNightlyRewardChecks(new Map([[mobile, 4500]]), new Date('2026-06-15'));
  const callsThisTest = claudeCallCount - callsBefore;

  const hasBriefing = (result?.briefings ?? []).some(b => b.mobile === mobile);

  return {
    name:        'Q — decideDailyMessage: 1 Claude call, briefing produced',
    claudeCalls: callsThisTest,
    hasBriefing,
    pass: callsThisTest === 1 && hasBriefing,
  };
}

// ── Run all tests and report ───────────────────────────────────────────────────

async function run() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  reward-calculator.js — 17-scenario bracket formula test suite');
  console.log('══════════════════════════════════════════════════════════════════\n');

  const tests = [
    { label: 'AB ID:       ', fn: runTestA },
    { label: 'AB ID:       ', fn: runTestB },
    { label: 'AB ID:       ', fn: runTestC },
    { label: 'AB ID:       ', fn: runTestD },
    { label: 'AB ID:       ', fn: runTestE },
    { label: 'AB ID:       ', fn: runTestF },
    { label: 'AB ID:       ', fn: runTestG },
    { label: 'AB ID:       ', fn: runTestH },
    { label: 'AB ID:       ', fn: runTestI },
    { label: 'Display Wall:', fn: runTestJ },
    { label: 'Display Wall:', fn: runTestK },
    { label: 'Display Wall:', fn: runTestL },
    { label: 'Display Wall:', fn: runTestM },
    { label: 'Display Wall:', fn: runTestN },
    { label: 'Display Wall:', fn: runTestO },
    { label: 'Budget:      ', fn: runTestP },
    { label: 'Messaging:   ', fn: runTestQ },
  ];

  const results = [];
  for (const { fn } of tests) results.push(await fn());

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════════');

  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    console.log(`  ${icon}  ${r.name}`);
    if (r.bracket     !== undefined) console.log(`       bracket: ${r.bracket}`);
    if (r.bonusRs     !== undefined) console.log(`       bonus_rs: ${r.bonusRs}  (expected ${r.expectedBonus ?? '—'})`);
    if (r.loyaltyRs   !== undefined) console.log(`       loyalty_topup_rs: ${r.loyaltyRs}  (expected ${r.expectedLoyalty})`);
    if (r.ledgerBal   !== undefined) console.log(`       ledger balance: ${r.ledgerBal}  (expected ${r.expectedTotal ?? r.expectedBonus ?? '—'})`);
    if (r.capped      !== undefined) console.log(`       capped: ${r.capped}`);
    if (r.rollingAvg  !== undefined) console.log(`       rolling_average: ${r.rollingAvg}  (expected ${r.expectedAvg ?? r.expectedWith70})`);
    if (r.consAfter   !== undefined) console.log(`       consecutive_months_after: ${r.consAfter}`);
    if (r.targetAmount !== undefined && r.expectedTarget !== undefined)
      console.log(`       target_amount: ${r.targetAmount}  (expected ${r.expectedTarget})`);
    if (r.newAccount  !== undefined) console.log(`       new_account: ${r.newAccount}`);
    if (r.noBriefing  !== undefined) console.log(`       no briefing produced: ${r.noBriefing}`);
    if (r.hasBriefing !== undefined) console.log(`       briefing produced: ${r.hasBriefing}`);
    console.log(`       Claude calls this test: ${r.claudeCalls}`);
    if (!r.pass) allPass = false;
  }

  const totalCalls = claudeCallCount;
  const callsOk    = totalCalls === 1;  // Only Test Q calls Claude
  console.log(`\n  ${callsOk ? '✓' : '✗'}  Total Claude calls across all 17 tests: ${totalCalls} (expected exactly 1)`);
  console.log(`  ${geminiAggCallCount > 0 ? '✓' : '✗'}  Gemini aggregation calls (mocked, period-aggregator.js): ${geminiAggCallCount}`);

  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log(allPass && callsOk ? '  ALL TESTS PASSED ✓' : '  SOME TESTS FAILED ✗');
  console.log('══════════════════════════════════════════════════════════════════\n');

  if (!allPass || !callsOk) process.exit(1);
}

run().catch(err => {
  console.error('[test] FATAL:', err.message, err.stack);
  process.exit(1);
});
