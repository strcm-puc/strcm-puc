'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// ST Rupees store-code exclusion — 4-case test suite.
//
//  Case 1: Normal AB ID purchase → Layer 1 credit applied as usual.
//  Case 2: ST Rupees store-code transaction → zero Layer 1, applyCredit not called.
//  Case 3: Mixed period (normal + store-code) → only normal amount in genuineSales.
//  Case 4: Full 18-test reward-calculator regression suite — 0 regressions.
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');
const { execSync }     = require('child_process');

const ROOT       = pathMod.resolve(__dirname, '..');
const STORE_CODE = 'STORE123';

// ── Helpers ────────────────────────────────────────────────────────────────────

function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

function freshBaseReward(applyCredit) {
  injectMock(pathMod.join(ROOT, 'vault-read.js'), {
    getCredential: async (cat) =>
      cat === 'rcm_login' ? { store_code: STORE_CODE } : { api_key: 'test' },
  });
  injectMock(pathMod.join(ROOT, 'pipeline', 'ledger-writer.js'), { applyCredit });
  // launch_date gate defaults to "live since 2020" — this suite predates
  // system-config.js's real Firestore doc, so stub it directly here.
  injectMock(pathMod.join(ROOT, 'pipeline', 'system-config.js'), {
    getLaunchDate: async () => new Date('2020-01-01T00:00:00'),
  });
  delete require.cache[require.resolve('./base-reward-calculator')];
  return require('./base-reward-calculator');
}

function makeFirestoreStore() {
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
      collection: (sub) => makeCollRef(`${docPath}/${sub}`),
    };
  }
  function makeCollRef(colPath) {
    return {
      _path: colPath,
      doc: (id) => makeDocRef(`${colPath}/${id ?? `a_${Math.random().toString(36).slice(2)}`}`),
      add: async (data) => { const id = `a_${Math.random().toString(36).slice(2)}`; store.set(`${colPath}/${id}`, data); return { id }; },
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
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
  const mockAdmin = { firestore: { FieldValue: { serverTimestamp: () => new Date().toISOString() } } };
  const mockDb    = { collection: makeCollRef };
  // launch_date gate defaults to "live since 2020" so this suite (dated 2026)
  // exercises the actual exclusion logic, not the not-yet-launched skip path.
  store.set('system/config', { launch_date: '2020-01-01' });
  return { store, mockDb, mockAdmin };
}

// checkPeriodEndBonus's Gemini aggregation pass calls Gemini via the @google/genai
// Vertex SDK — mock it so this test never makes a real network/API call.
injectMock(require.resolve('@google/genai'), {
  GoogleGenAI: class {
    constructor() {}
    get models() {
      return { generateContent: async () => ({ text: JSON.stringify({ summary: 'Test period summary.' }) }) };
    }
  },
});

function freshRC(mockDb, mockAdmin) {
  injectMock(pathMod.join(ROOT, 'vault-read.js'), {
    getCredential: async (cat) =>
      cat === 'rcm_login' ? { store_code: STORE_CODE }
      : cat === 'anthropic_api' ? { api_key: 'test-key' }
      : { bot_token: 'tok', admin_chat_id: '1' },
  });
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: mockDb, admin: mockAdmin });
  delete require.cache[require.resolve('./reward-calculator')];
  delete require.cache[require.resolve('./ledger-writer')];
  delete require.cache[require.resolve('./customer-schema')];
  delete require.cache[require.resolve('./period-aggregator')];
  delete require.cache[require.resolve('./system-config')];
  return require('./reward-calculator');
}

const { fiscalPeriodKey } = (() => {
  injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: { collection: () => ({}) }, admin: {} });
  delete require.cache[require.resolve('./customer-schema')];
  return require('./customer-schema');
})();

// ── Assertion helpers ──────────────────────────────────────────────────────────

function check(label, actual, expected) {
  const pass = actual === expected;
  console.log(`  ${pass ? '✓' : '✗'}  ${label}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  return pass;
}
function checkTruthy(label, val) {
  const pass = !!val;
  console.log(`  ${pass ? '✓' : '✗'}  ${label}: ${JSON.stringify(val)}`);
  return pass;
}

// ── Case 1: Normal AB ID purchase → Layer 1 applied ───────────────────────────

async function case1() {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Case 1 — Normal AB ID purchase → Layer 1 credit');
  console.log('──────────────────────────────────────────────────────────────\n');

  let applyCallCount = 0;
  let capturedAmount = null;

  const { calculateBaseReward } = freshBaseReward(async (mobile, id, amount, reason, bill) => {
    applyCallCount++;
    capturedAmount = amount;
    return { ok: true };
  });

  const result = await calculateBaseReward('9876543210', 'AB_NORMAL', 'BILL001', 5000);

  let pass = true;
  pass &= check('baseAmount = 50 (1% of 5000)', result.baseAmount, 50);
  pass &= check('applyCredit called once', applyCallCount, 1);
  pass &= check('applyCredit amount = 50', capturedAmount, 50);
  pass &= checkTruthy('ledgerResult returned', result.ledgerResult);

  console.log(`\n  ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  return !!pass;
}

// ── Case 2: Store-code transaction → zero Layer 1 ─────────────────────────────

async function case2() {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Case 2 — ST Rupees store-code → zero Layer 1, no credit');
  console.log('──────────────────────────────────────────────────────────────\n');

  let applyCallCount = 0;

  const { calculateBaseReward } = freshBaseReward(async () => {
    applyCallCount++;
    return { ok: true };
  });

  const result = await calculateBaseReward('9876543210', STORE_CODE, 'BILL002', 5000);

  let pass = true;
  pass &= check('baseAmount = 0 (excluded)', result.baseAmount, 0);
  pass &= check('applyCredit NOT called', applyCallCount, 0);
  pass &= check('ledgerResult = null', result.ledgerResult, null);

  console.log(`\n  ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  return !!pass;
}

// ── Case 3: Mixed period → only normal amount in genuineSales ─────────────────

async function case3() {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Case 3 — Mixed period: normal + store-code → bonus on normal only');
  console.log('──────────────────────────────────────────────────────────────\n');

  // intercept Anthropic so checkPeriodEndBonus (pure arithmetic) doesn't need it
  const https = require('https');
  https.request = (opts, cb) => {
    const res = new EventEmitter(); const req = new EventEmitter();
    req.write = () => {}; req.end = () => {
      process.nextTick(() => { res.emit('data', JSON.stringify({ ok: true })); res.emit('end'); });
      if (cb) cb(res);
    };
    return req;
  };

  const { store, mockDb, mockAdmin } = makeFirestoreStore();

  // Customer with 3 months of history → rolling average
  const MOBILE = '9876543210';
  const AB_ID  = 'AB_NORMAL';
  // Period under test: 2026-06
  const TODAY  = new Date('2026-06-30');

  // STORE_CODE is tagged as a (synthetic) second linked id purely so this test can
  // exercise the exclusion path in fetchPeriodSales — in real data a redemption bill's
  // id_used would never be a genuine linked id of any customer.
  store.set(`customers/${MOBILE}`, {
    profile: {
      linked_ids: [{ id: AB_ID, type: 'ab_id' }, { id: STORE_CODE, type: 'ab_id' }],
      name: 'Test', gender: 'M', tier: 'Saathi', consecutive_months: 2,
    },
  });

  // 3 months of real history (Mar, Apr, May — all 5000)
  store.set(`customers/${MOBILE}/ids/${AB_ID}/periods/${fiscalPeriodKey(new Date('2026-03-15'), false)}/purchases/h0`, { date: '2026-03-15', amount: '5000', id_used: AB_ID });
  store.set(`customers/${MOBILE}/ids/${AB_ID}/periods/${fiscalPeriodKey(new Date('2026-04-15'), false)}/purchases/h1`, { date: '2026-04-15', amount: '5000', id_used: AB_ID });
  store.set(`customers/${MOBILE}/ids/${AB_ID}/periods/${fiscalPeriodKey(new Date('2026-05-15'), false)}/purchases/h2`, { date: '2026-05-15', amount: '5000', id_used: AB_ID });

  // June: one normal purchase (4000) + one store-code transaction (3000)
  const juneKey = fiscalPeriodKey(new Date('2026-06-15'), false); // FY2627-06
  store.set(`customers/${MOBILE}/ids/${AB_ID}/periods/${juneKey}/purchases/h3`, { date: '2026-06-15', amount: '4000', id_used: AB_ID });
  store.set(`customers/${MOBILE}/ids/${STORE_CODE}/periods/${juneKey}/purchases/h4`, { date: '2026-06-20', amount: '3000', id_used: STORE_CODE });

  // Set the June period target — rolling avg 5000, growth threshold 5250 (105%)
  store.set(`customers/${MOBILE}/ids/${AB_ID}/periods/${juneKey}`, {
    target: {
      period_key:        '2026-06',
      target_amount:     5250,
      rolling_average:   5000,
      cold_start:        false,
      cold_start_month:  null,
      missed_threshold:  4500,   // 90%
      growth_threshold:  5250,   // 105%
      period_start:      '2026-06-01',
      period_end:        '2026-06-30',
      reasoning:         'test',
      set_at:            '2026-06-01T00:00:00Z',
    },
  });

  let creditCalls = [];
  injectMock(pathMod.join(ROOT, 'pipeline', 'ledger-writer.js'), {
    applyCredit: async (mobile, id, amount, reason, bill) => {
      creditCalls.push({ amount, reason });
      return { ok: true };
    },
    applyDebit: async () => ({ ok: true }),
  });

  const { checkPeriodEndBonus, _setNow } = freshRC(mockDb, mockAdmin);
  _setNow(() => TODAY);

  const result = await checkPeriodEndBonus(MOBILE, TODAY);

  // Normal purchase only: 4000 (store-code 3000 excluded)
  // 4000 < 4500 (missed threshold 90%) → bracket = missed, bonusRs = 0
  // genuineSales = 4000, not 7000

  let pass = true;
  pass &= check('result not skipped', result.skipped, false);
  pass &= check('bracket = missed (4000 < 4500 threshold)', result.bracket, 'missed');
  pass &= check('genuineSales = 4000 (store-code 3000 excluded)', result.genuineSales, 4000);
  pass &= check('bonus = 0 (missed)', result.bonus?.amount, 0);
  pass &= check('no spurious credit call (bonus=0)', creditCalls.filter(c => c.reason.includes('bonus')).length, 0);

  console.log(`\n  ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  return !!pass;
}

// ── Case 4: Full 18-test regression ───────────────────────────────────────────

function case4() {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Case 4 — Full reward-calculator 18-test regression suite');
  console.log('──────────────────────────────────────────────────────────────\n');

  try {
    execSync('node pipeline/test-reward-calculator.js', {
      cwd:   ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    console.log('  ✓  All 18 regression tests passed');
    return true;
  } catch (e) {
    console.log('  ✗  Regression tests FAILED:');
    console.log((e.stdout || '') + (e.stderr || ''));
    return false;
  }
}

// ── Run all ────────────────────────────────────────────────────────────────────

async function run() {
  const r1 = await case1();
  const r2 = await case2();
  const r3 = await case3();
  const r4 =        case4();

  const total = 4;
  const pass  = [r1, r2, r3, r4].filter(Boolean).length;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  ST Rupees exclusion test result: ${pass}/${total} passing`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (pass < total) process.exit(1);
}

run().catch(e => { console.error('[test] FATAL:', e.message, e.stack); process.exit(1); });
