'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// Telegram listener — integration test suite (4 scenarios).
//
//  A. Compound reply "Party Code AB12345 Mobile 9876543210" → D9 sub-collections
//  B. Plain mobile-only reply "9876543210" (backward-compat path) → profile
//  C. Malformed mobile in compound reply → rejection message, no profile created
//  D. 10-digit Reference ID in compound reply → flagged, no profile created
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');

// ── In-memory Firestore mock ───────────────────────────────────────────────────

let store = new Map();

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
      const id = `auto_${Math.random().toString(36).slice(2)}`;
      store.set(`${colPath}/${id}`, data);
      return { id };
    },
    get: async () => {
      const prefix = colPath + '/';
      const docs   = [];
      for (const [k, v] of store) {
        if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
        docs.push({ id: k.split('/').pop(), data: () => v });
      }
      return { docs, empty: docs.length === 0 };
    },
    where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
  };
}

const mockAdmin = {
  firestore: { FieldValue: { serverTimestamp: () => new Date().toISOString() } },
};
const mockDb = { collection: makeCollectionRef };

// ── https mock ────────────────────────────────────────────────────────────────

let geminiCallCount   = 0;
let telegramMessages  = [];

const https = require('https');
https.request = (opts, callback) => {
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.write = () => {};
  req.end   = () => {
    process.nextTick(() => {
      // Telegram — capture sent messages (Gemini no longer goes through https — see
      // the @google/genai mock below, which is the SDK telegram-listener.js now uses).
      const rawBody = req._body ?? '';
      try { telegramMessages.push(JSON.parse(rawBody)); } catch {}
      const body = JSON.stringify({ ok: true });
      res.emit('data', body);
      res.emit('end');
    });
    if (callback) callback(res);
  };
  req.write = (b) => { req._body = (req._body ?? '') + b; };
  return req;
};

// ── Inject mocks ───────────────────────────────────────────────────────────────

const ROOT = pathMod.resolve(__dirname, '..');

function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: mockDb, admin: mockAdmin });
injectMock(pathMod.join(ROOT, 'vault-read.js'), {
  getCredential: async (category) => {
    if (category === 'gemini_api') return { api_key: 'test-gemini-key' };
    return { bot_token: 'test_token', admin_chat_id: '123456' };
  },
});

// telegram-listener.js calls Gemini via the @google/genai Vertex SDK, not raw https —
// mock that SDK directly so this test never makes a real network/API call.
injectMock(require.resolve('@google/genai'), {
  GoogleGenAI: class {
    constructor() {}
    get models() {
      return {
        generateContent: async () => {
          geminiCallCount++;
          return { text: JSON.stringify({ gender: 'F', name_cleaned: 'Priya Sharma' }) };
        },
      };
    }
  },
});

// ── Load module under test ─────────────────────────────────────────────────────

delete require.cache[require.resolve('./telegram-listener')];
const { _processUpdate, _extractPartyCodeFromAlert, _parseMobile, _parseCompoundReply } =
  require('./telegram-listener');

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
function checkContains(label, str, substring) {
  const pass = typeof str === 'string' && str.includes(substring);
  console.log(`  ${pass ? '✓' : '✗'}  ${label}: "${String(str ?? '').slice(0, 60)}"`);
  return pass;
}

// ── Alert text used across scenarios ──────────────────────────────────────────

const ALERT_TEXT =
  '⚠️ Unknown RCM Party Code — nightly scrape (28-06-2026)\n\n' +
  'Party Code: AB12345\n' +
  'Party Name: Priya Sharma\n' +
  'Bill No: B99001\n' +
  'Bill Value: ₹3500\n\n' +
  'Please reply with the customer\'s mobile number, or confirm if this is a temporary/guest ID to skip.';

// ── Scenario A: Compound reply "Party Code AB12345 Mobile 9876543210" ─────────

async function scenarioA() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Scenario A — Compound voice-to-text reply → D9 sub-collections');
  console.log('══════════════════════════════════════════════════════════════\n');

  store.clear(); geminiCallCount = 0; telegramMessages = [];
  store.set('pending_party_codes/AB12345', {
    party_code: 'AB12345', party_name: 'Priya Sharma',
    bill_no: 'B99001', bill_value: '3500', status: 'pending',
  });

  const update = {
    update_id: 100001,
    message: {
      message_id: 501,
      from: { id: 9999, first_name: 'Adnan' },
      chat: { id: 9999, type: 'private' },
      text: 'Party Code AB12345 Mobile 9876543210',
      reply_to_message: { message_id: 400, text: ALERT_TEXT },
    },
  };

  // Unit test the parser itself
  const parsed = _parseCompoundReply(update.message.text);

  await _processUpdate(update);

  const custDoc  = store.get('customers/9876543210');
  const profile  = custDoc?.profile;
  const idDoc    = store.get('customers/9876543210/ids/AB12345');
  const advice   = store.get('customers/9876543210/behavior_advice/AB12345');
  const pending  = store.get('pending_party_codes/AB12345');
  const lastMsg  = telegramMessages[telegramMessages.length - 1]?.text ?? '';

  let pass = true;
  pass &= check('_parseCompoundReply partyCode', parsed?.partyCode, 'AB12345');
  pass &= check('_parseCompoundReply rawMobile', parsed?.rawMobile, '9876543210');
  pass &= checkTruthy('customers/9876543210 created', custDoc);
  pass &= check('profile.name', profile?.name, 'Priya Sharma');
  pass &= check('profile.gender', profile?.gender, 'F');
  pass &= check('profile.tier', profile?.tier, 'Bronze');
  pass &= check('profile.language', profile?.language, 'hi');
  pass &= check('profile.status', profile?.status, 'active');
  pass &= check('profile.linked_ids[0].id', profile?.linked_ids?.[0]?.id, 'AB12345');
  pass &= check('profile.linked_ids[0].type', profile?.linked_ids?.[0]?.type, 'ab_id');
  pass &= check('profile.linked_id_values[0]', profile?.linked_id_values?.[0], 'AB12345');
  pass &= checkTruthy('ids/AB12345 created', idDoc);
  pass &= check('idDoc.current_balance', idDoc?.current_balance, 0);
  pass &= check('idDoc.debt', idDoc?.debt, 0);
  pass &= checkTruthy('behavior_advice/AB12345 created', advice);
  pass &= check('pending status → resolved', pending?.status, 'resolved');
  pass &= check('pending mobile linked', pending?.mobile, '9876543210');
  pass &= checkContains('confirmation includes Firestore path', lastMsg, 'customers/9876543210');
  pass &= check('Gemini called once', geminiCallCount, 1);

  console.log(`\n  ${pass ? 'ALL CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  return !!pass;
}

// ── Scenario B: Plain mobile-only reply (backward compatibility) ───────────────

async function scenarioB() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Scenario B — Plain mobile reply (backward compat) → profile');
  console.log('══════════════════════════════════════════════════════════════\n');

  store.clear(); geminiCallCount = 0; telegramMessages = [];
  store.set('pending_party_codes/AB12345', {
    party_code: 'AB12345', party_name: 'Priya Sharma', status: 'pending',
  });

  const update = {
    update_id: 100002,
    message: {
      message_id: 502,
      from: { id: 9999, first_name: 'Adnan' },
      chat: { id: 9999, type: 'private' },
      text: '9876543210',
      reply_to_message: { message_id: 400, text: ALERT_TEXT },
    },
  };

  await _processUpdate(update);

  const profile = store.get('customers/9876543210')?.profile;
  const pending = store.get('pending_party_codes/AB12345');

  let pass = true;
  pass &= checkTruthy('profile created', profile);
  pass &= check('profile.tier', profile?.tier, 'Bronze');
  pass &= check('profile.language', profile?.language, 'hi');
  pass &= check('pending status → resolved', pending?.status, 'resolved');
  pass &= checkTruthy('id doc created', store.get('customers/9876543210/ids/AB12345'));

  console.log(`\n  ${pass ? 'ALL CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  return !!pass;
}

// ── Scenario C: Malformed mobile → rejection, no profile created ───────────────

async function scenarioC() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Scenario C — Malformed mobile → rejection + re-prompt');
  console.log('══════════════════════════════════════════════════════════════\n');

  store.clear(); geminiCallCount = 0; telegramMessages = [];
  store.set('pending_party_codes/AB12345', {
    party_code: 'AB12345', party_name: 'Priya Sharma', status: 'pending',
  });

  const update = {
    update_id: 100003,
    message: {
      message_id: 503,
      from: { id: 9999, first_name: 'Adnan' },
      chat: { id: 9999, type: 'private' },
      text: 'Party Code AB12345 Mobile 12345',   // malformed: 5-digit number
      reply_to_message: { message_id: 400, text: ALERT_TEXT },
    },
  };

  await _processUpdate(update);

  const custDoc = store.get('customers/9876543210');
  const sentText = telegramMessages[telegramMessages.length - 1]?.text ?? '';

  let pass = true;
  pass &= check('No profile created', custDoc, undefined);
  pass &= check('No Gemini call made', geminiCallCount, 0);
  pass &= checkContains('Rejection message sent', sentText, 'mobile');
  pass &= checkContains('Re-prompt included', sentText, 'Party Code');

  console.log(`\n  ${pass ? 'ALL CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  return !!pass;
}

// ── Scenario D: 10-digit Reference ID → flagged, no profile created ────────────

async function scenarioD() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Scenario D — 10-digit Reference ID → flagged for confirmation');
  console.log('══════════════════════════════════════════════════════════════\n');

  store.clear(); geminiCallCount = 0; telegramMessages = [];

  // Alert for a 10-digit ref ID
  const refAlertText =
    '⚠️ Unknown RCM Party Code — nightly scrape (28-06-2026)\n\n' +
    'Party Code: 1234567890\n' +
    'Party Name: Rajesh Kumar\n' +
    'Bill No: B99002\n' +
    'Bill Value: ₹5000\n\n' +
    'Please reply with the customer\'s mobile number.';

  store.set('pending_party_codes/1234567890', {
    party_code: '1234567890', party_name: 'Rajesh Kumar', status: 'pending',
  });

  const update = {
    update_id: 100004,
    message: {
      message_id: 504,
      from: { id: 9999, first_name: 'Adnan' },
      chat: { id: 9999, type: 'private' },
      text: 'Party Code 1234567890 Mobile 9876543211',
      reply_to_message: { message_id: 401, text: refAlertText },
    },
  };

  await _processUpdate(update);

  const custDoc    = store.get('customers/9876543211');
  const pendingDoc = store.get('pending_party_codes/1234567890');
  const sentText   = telegramMessages[telegramMessages.length - 1]?.text ?? '';

  let pass = true;
  pass &= check('No profile created', custDoc, undefined);
  pass &= check('No Gemini call made', geminiCallCount, 0);
  pass &= check('pending status → awaiting_confirmation', pendingDoc?.status, 'awaiting_confirmation');
  pass &= checkContains('Warning message sent', sentText, 'Reference ID');
  pass &= checkContains('Confirmation prompt included', sentText, 'YES');

  console.log(`\n  ${pass ? 'ALL CHECKS PASSED ✓' : 'SOME CHECKS FAILED ✗'}`);
  return !!pass;
}

// ── Run all scenarios ──────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  telegram-listener.js — Full test suite (Scenarios A–D)');
  console.log('══════════════════════════════════════════════════════════════');

  // Unit assertions on parser functions
  console.log('\n  ── Unit parser checks ───────────────────────────────────────');
  let unitPass = true;
  unitPass &= check('_extractPartyCodeFromAlert', _extractPartyCodeFromAlert('Party Code: X123\n'), 'X123');
  unitPass &= check('_parseMobile +91 prefix',    _parseMobile('+919876543210'), '9876543210');
  unitPass &= check('_parseMobile plain 10-digit', _parseMobile('9876543210'), '9876543210');
  unitPass &= check('_parseMobile malformed → null', _parseMobile('12345'), null);
  unitPass &= check('_parseCompoundReply code', _parseCompoundReply('Party Code AB12345 Mobile 9876543210')?.partyCode, 'AB12345');
  unitPass &= check('_parseCompoundReply mobile', _parseCompoundReply('Party Code AB12345 Mobile 9876543210')?.rawMobile, '9876543210');
  unitPass &= check('_parseCompoundReply case-insensitive', _parseCompoundReply('party code abc123 mobile 9876543210')?.partyCode, 'abc123');
  unitPass &= check('_parseCompoundReply null on plain text', _parseCompoundReply('9876543210'), null);

  const aPass = await scenarioA();
  const bPass = await scenarioB();
  const cPass = await scenarioC();
  const dPass = await scenarioD();

  const allPass = unitPass && aPass && bPass && cPass && dPass;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  FINAL RESULT:', allPass ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗');
  console.log('══════════════════════════════════════════════════════════════\n');

  if (!allPass) process.exit(1);
}

runTests().catch(err => {
  console.error('[test] FATAL:', err.message, err.stack);
  process.exit(1);
});
