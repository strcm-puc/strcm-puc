'use strict';

// ════════════════════════════════════════════════════════════════════════════════
// telegram-listener.js — /cost command test (2 scenarios)
//
//  A. Owner (admin_chat_id) sends /cost → gets an honest "not tracked yet" reply,
//     no fabricated numbers, no live Sonnet/Gemini call involved.
//  B. Non-owner chat sends /cost → silently ignored, nothing sent.
// ════════════════════════════════════════════════════════════════════════════════

const pathMod = require('path');
const { EventEmitter } = require('events');

const ADMIN_CHAT_ID = '99988877';

let telegramMessages = [];

const https = require('https');
https.request = (opts, callback) => {
  const res = new EventEmitter();
  const req = new EventEmitter();
  req.write = (chunk) => { req._body = (req._body ?? '') + chunk; };
  req.end   = () => {
    process.nextTick(() => {
      if (opts?.hostname !== 'api.telegram.org') throw new Error(`Unexpected outbound call to ${opts?.hostname} — /cost must never call a paid API`);
      try { telegramMessages.push(JSON.parse(req._body ?? '{}')); } catch {}
      res.emit('data', JSON.stringify({ ok: true }));
      res.emit('end');
    });
    if (callback) callback(res);
  };
  return req;
};

const ROOT = pathMod.resolve(__dirname, '..');
function injectMock(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}
injectMock(pathMod.join(ROOT, 'vault-read.js'), {
  getCredential: async (category) => {
    if (category === 'telegram_bot') return { bot_token: 'test_token', admin_chat_id: ADMIN_CHAT_ID };
    throw new Error(`unexpected credential request: ${category}`);
  },
});
injectMock(pathMod.join(ROOT, 'firebase-config.js'), { db: { collection: () => ({}) }, admin: {} });

delete require.cache[require.resolve('./telegram-listener')];
const { _handleCostCommand } = require('./telegram-listener');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓  ${label}`); pass++; }
  else      { console.log(`  ✗  ${label}  —  ${detail}`); fail++; }
}

async function run() {
  // ── TEST A: owner sends /cost ──────────────────────────────────────────────
  telegramMessages = [];
  await _handleCostCommand(ADMIN_CHAT_ID);

  check('A: exactly one Telegram message sent to the owner', telegramMessages.length === 1, String(telegramMessages.length));
  const reply = telegramMessages[0]?.text ?? '';
  check('A: reply states no spend tracking exists', /not available|no spend tracking/i.test(reply), reply.slice(0, 120));
  check('A: reply does NOT contain a fabricated rupee/dollar figure', !/₹\s?\d|Rs\.?\s?\d|\$\s?\d/.test(reply), reply.slice(0, 200));
  check('A: reply names what to instrument (Sonnet)', /Sonnet/.test(reply), reply.slice(0, 200));
  check('A: reply names what to instrument (Gemini)', /Gemini/.test(reply), reply.slice(0, 200));

  // ── TEST B: a non-owner chat sends /cost ───────────────────────────────────
  telegramMessages = [];
  await _handleCostCommand('11122233'); // not the admin_chat_id

  check('B: no message sent for a non-owner chat', telegramMessages.length === 0, String(telegramMessages.length));

  console.log(`\n${fail === 0 ? 'ALL TESTS PASSED ✓' : `${fail} TEST(S) FAILED ✗`}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('SCRIPT ERROR:', e.message, e.stack); process.exit(1); });
