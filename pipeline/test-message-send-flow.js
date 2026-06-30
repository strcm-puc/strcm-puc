'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// Message + send flow integration test.
//
// Flow: dummy briefing → writeMessage → Gemini selects template + writes Hindi
//       message → send_queue entry → sendPendingMessages → mock Meta API call
//       → message_history entry → send_queue status = 'sent'
//
// All external APIs mocked:
//   graph.facebook.com (templates + messages)
//   @google/genai Vertex SDK (Gemini)
//   api.telegram.org (Telegram)
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');

// ── In-memory Firestore mock ───────────────────────────────────────────────────

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
      get: async () => {
        const prefix  = colPath + '/';
        const matches = [];
        for (const [k, v] of store) {
          if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
          if (op === '==' && v?.[field] === value)
            matches.push({ id: k.split('/').pop(), data: () => v });
        }
        return { empty: matches.length === 0, docs: matches };
      },
    }),
    get: async () => {
      const prefix = colPath + '/';
      const docs   = [];
      for (const [k, v] of store) {
        if (!k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue;
        docs.push({ id: k.split('/').pop(), data: () => v });
      }
      return { docs, empty: docs.length === 0 };
    },
  };
}

const mockAdmin = {
  firestore: { FieldValue: { serverTimestamp: () => new Date().toISOString() } },
};
const mockDb = { collection: makeCollectionRef };

// ── API call counters ──────────────────────────────────────────────────────────

let geminiCallCount  = 0;
let metaSendCount    = 0;
let metaFetchCount   = 0;

// ── Mock template list ────────────────────────────────────────────────────────

const MOCK_TEMPLATES = [
  {
    name:     'st_welcome_hindi',
    status:   'APPROVED',
    language: 'hi',
    components: [
      { type: 'BODY', text: 'जय RCM! {{1}}, आपका ST account में स्वागत है। आपकी यात्रा {{2}} से शुरू होती है।' },
    ],
  },
  {
    name:     'st_purchase_thanks_hindi',
    status:   'APPROVED',
    language: 'hi',
    components: [
      { type: 'BODY', text: 'जय RCM! {{1}}, आपकी खरीदारी के लिए शुक्रिया। आपके ST खाते में {{2}} जमा हुए।' },
    ],
  },
];

// ── https mock ────────────────────────────────────────────────────────────────

const https = require('https');
https.request = (opts, callback) => {
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.write = () => {};
  req.end   = () => {
    process.nextTick(() => {
      let body;
      const host = opts?.hostname ?? '';
      const path = opts?.path ?? '';

      if (host === 'graph.facebook.com' && path.includes('message_templates')) {
        metaFetchCount++;
        body = JSON.stringify({ data: MOCK_TEMPLATES });

      } else if (host === 'graph.facebook.com' && path.includes('/messages')) {
        metaSendCount++;
        body = JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: '919876543210', wa_id: '919876543210' }],
          messages: [{ id: 'wamid.test_mock_id_001' }],
        });

      } else {
        // Telegram and others
        body = JSON.stringify({ ok: true });
      }

      res.emit('data', body);
      res.emit('end');
    });
    if (callback) callback(res);
  };
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
    if (category === 'gemini_api')    return { api_key: 'test-gemini-key' };
    if (category === 'whatsapp_api')  return {
      phone_number_id:    '1178426052021435',
      waba_id_production: '3468717666623916',
      access_token:       'test-wa-token',
    };
    return { bot_token: 'test_token', admin_chat_id: '123456' };
  },
});

// message-writer.js calls Gemini via the @google/genai Vertex SDK, not raw https —
// mock that SDK directly so this test never makes a real network/API call.
injectMock(require.resolve('@google/genai'), {
  GoogleGenAI: class {
    constructor() {}
    get models() {
      return {
        generateContent: async () => {
          geminiCallCount++;
          const mockGeminiResponse = {
            template_name:     'st_purchase_thanks_hindi',
            template_language: 'hi',
            body_variables:    ['प्रिया', 'Rs 45'],
            header_variables:  [],
            message_preview:   'जय RCM!\nप्रिया जी, आपकी खरीदारी के लिए शुक्रिया। आपके ST खाते में Rs 45 जमा हुए।',
            opener:            'आपकी खरीदारी के लिए',
          };
          return { text: JSON.stringify(mockGeminiResponse) };
        },
      };
    }
  },
});

// ── Seed customer ──────────────────────────────────────────────────────────────

const MOBILE = '9876543210';
store.set(`customers/${MOBILE}`, {
  profile: {
    name:               'प्रिया',
    gender:             'F',
    linked_ids:         [{ id: 'AB9001', type: 'ab_id' }],
    linked_id_values:   ['AB9001'],
    tier:               'Saathi',
    consecutive_months: 3,
    unsubscribed:       false,
  },
});

// ── Load modules under test ────────────────────────────────────────────────────

// Clear require cache for all modules under test
[
  './message-writer',
  './sender',
  './template-cache',
].forEach(m => {
  try { delete require.cache[require.resolve(m)]; } catch {}
});

const { writeMessage }         = require('./message-writer');
const { sendPendingMessages }  = require('./sender');

// ── Dummy briefing from decideDailyMessage ────────────────────────────────────

const briefing = {
  mobile:            MOBILE,
  customer_name:     'प्रिया',
  gender:            'F',
  what_happened:     'Rs 4500 की खरीदारी आज',
  tone_needed:       'encouraging',
  show_rupee_amount: true,
  st_account_link:   false,
  do_not_mention:    [],
  progressPct:       45,
  daysLeft:          15,
  isNearEnd:         false,
};

// ── Run test ───────────────────────────────────────────────────────────────────

async function runTest() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  writeMessage + sendPendingMessages — integration test');
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── Step 1: writeMessage ─────────────────────────────────────────────────
  console.log('  Step 1: writeMessage(briefing)');
  const writeResult = await writeMessage(briefing);

  // ── Step 2: sendPendingMessages ───────────────────────────────────────────
  console.log('  Step 2: sendPendingMessages()');
  const sendResult = await sendPendingMessages();

  // ── Inspect Firestore state ───────────────────────────────────────────────
  // Find the send_queue entry
  const queueEntry = store.get(`send_queue/${writeResult.queueId}`);

  // Find the message_history entry for this customer
  const histPrefix = `customers/${MOBILE}/message_history/`;
  let historyEntry = null;
  for (const [k, v] of store) {
    if (k.startsWith(histPrefix) && !k.slice(histPrefix.length).includes('/')) {
      historyEntry = v; break;
    }
  }

  // Customer profile magic_token
  const customerProfile = store.get(`customers/${MOBILE}`)?.profile;

  function check(label, actual, expected) {
    const pass = actual === expected;
    console.log(`  ${pass ? '✓' : '✗'}  ${label}: ${JSON.stringify(actual)} ${pass ? '' : `(expected ${JSON.stringify(expected)})`}`);
    return pass;
  }
  function checkTruthy(label, val) {
    const pass = !!val;
    console.log(`  ${pass ? '✓' : '✗'}  ${label}: ${JSON.stringify(val)}`);
    return pass;
  }
  function checkContains(label, str, substr) {
    const pass = typeof str === 'string' && str.includes(substr);
    console.log(`  ${pass ? '✓' : '✗'}  ${label}: ${pass ? 'yes' : `"${str}" does not contain "${substr}"`}`);
    return pass;
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════');

  let allPass = true;

  // writeMessage results
  allPass &= checkTruthy('writeMessage returned queueId',              writeResult.queueId);
  allPass &= checkTruthy('writeMessage returned magicToken',           writeResult.magicToken);
  allPass &= checkContains('magicToken starts with strcm.vercel.app',  writeResult.magicToken, 'strcm.vercel.app/d/');
  allPass &= check('writeMessage.skipped is false',                    writeResult.skipped, false);

  // send_queue entry
  allPass &= checkTruthy('send_queue entry exists',                    queueEntry);
  allPass &= check('send_queue.status after send',                     queueEntry?.status, 'sent');
  allPass &= checkTruthy('send_queue.wamid set after send',            queueEntry?.wamid);
  allPass &= check('send_queue.mobile',                                queueEntry?.mobile, MOBILE);
  allPass &= checkTruthy('send_queue.template_name set',               queueEntry?.template_name);
  allPass &= checkTruthy('send_queue.message_preview set',             queueEntry?.message_preview);
  allPass &= checkContains('message_preview starts with जय RCM',      queueEntry?.message_preview ?? '', 'जय RCM');

  // message_history entry
  allPass &= checkTruthy('message_history entry created',              historyEntry);
  allPass &= check('message_history.status',                           historyEntry?.status, 'sent');
  allPass &= checkTruthy('message_history.wamid',                      historyEntry?.wamid);

  // customer profile
  allPass &= checkContains('profile.magic_token stored on customer',   customerProfile?.magic_token ?? '', 'strcm.vercel.app/d/');

  // API call counts
  allPass &= check('Gemini calls (message writing)',                   geminiCallCount, 1);
  allPass &= check('Meta template fetch calls',                        metaFetchCount, 1);
  allPass &= check('Meta message send calls',                          metaSendCount, 1);

  // sendPendingMessages summary
  allPass &= check('sendPendingMessages sent count',                   sendResult.sent, 1);
  allPass &= check('sendPendingMessages failed count',                 sendResult.failed, 0);

  console.log('\n  ── Message preview ──────────────────────────────────────────');
  console.log(`  Template: ${queueEntry?.template_name}`);
  console.log(`  Preview:  ${queueEntry?.message_preview}`);
  console.log(`  Token:    ${writeResult.magicToken}`);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(allPass ? '  ALL CHECKS PASSED ✓' : '  SOME CHECKS FAILED ✗');
  console.log('══════════════════════════════════════════════════════════════\n');

  if (!allPass) process.exit(1);
}

runTest().catch(err => {
  console.error('[test] FATAL:', err.message, err.stack);
  process.exit(1);
});
