'use strict';

const https = require('https');
const { db, admin } = require('../firebase-config');
const { getCredential } = require('../vault-read');

let _tgCreds;
let _geminiKey;
let _lastUpdateId = 0;

// ── Credential caches ──────────────────────────────────────────────────────────

async function _getTgCreds() {
  if (_tgCreds !== undefined) return _tgCreds;
  try   { _tgCreds = await getCredential('telegram_bot'); }
  catch (e) { console.warn('[listener] Telegram creds unavailable:', e.message); _tgCreds = null; }
  return _tgCreds;
}

async function _getGeminiKey() {
  if (_geminiKey !== undefined) return _geminiKey;
  try {
    const c = await getCredential('gemini_api');
    _geminiKey = String(c.api_key).trim();
  } catch (e) {
    console.warn('[listener] Gemini creds unavailable:', e.message);
    _geminiKey = null;
  }
  return _geminiKey;
}

// ── Gemini API ─────────────────────────────────────────────────────────────────

async function _callGemini(prompt) {
  const key = await _getGeminiKey();
  if (!key) throw new Error('Gemini credentials not available');
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message ?? 'Gemini API error'));
          const text  = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
          const match = text.match(/\{[\s\S]*\}/);
          resolve(JSON.parse(match?.[0] ?? '{}'));
        } catch (e) { reject(new Error(`Gemini parse failed: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Telegram API ───────────────────────────────────────────────────────────────

async function _sendTelegramMessage(chatId, text) {
  const tg = await _getTgCreds();
  if (!tg) return;
  const token = String(tg.bot_token).trim();
  const body  = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', e => { console.warn('[listener] Telegram send failed:', e.message); resolve(null); });
    req.write(body); req.end();
  });
}

async function _getUpdates() {
  const tg = await _getTgCreds();
  if (!tg) return [];
  const token  = String(tg.bot_token).trim();
  const params = `offset=${_lastUpdateId + 1}&timeout=25&limit=20`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/getUpdates?${params}`,
      method:   'GET',
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed.ok || !Array.isArray(parsed.result)) {
            console.warn('[listener] getUpdates unexpected response:', raw.slice(0, 200));
            return resolve([]);
          }
          resolve(parsed.result);
        } catch (e) { console.warn('[listener] getUpdates parse error:', e.message); resolve([]); }
      });
    });
    req.on('error', e => { console.warn('[listener] getUpdates failed:', e.message); resolve([]); });
    req.end();
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _extractPartyCodeFromAlert(alertText) {
  const match = (alertText ?? '').match(/Party Code:\s*([A-Za-z0-9_-]+)/);
  return match?.[1]?.trim() ?? null;
}

function _parseMobile(text) {
  const cleaned = (text ?? '').trim().replace(/[\s\-(). ]/g, '');
  const m = cleaned.match(/^(?:\+91|91)?([6-9]\d{9})$/);
  return m ? m[1] : null;
}

// Parse voice-to-text compound reply: "Party Code <code> Mobile <number>"
// Case-insensitive; flexible spacing and punctuation between tokens.
function _parseCompoundReply(text) {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(
    /party\s*code[:\s]+([A-Za-z0-9]+)\s+(?:mobile|mob|number|no)[:\s]+([\d\s\-+().]+)/i
  );
  if (!m) return null;
  return { partyCode: m[1].trim(), rawMobile: m[2].trim() };
}

// ── Customer profile creation via Gemini ───────────────────────────────────────

async function _createProfile(mobile, partyCode, partyName) {
  let gender    = 'unknown';
  let nameFinal = partyName;

  try {
    const result = await _callGemini(
      `Given the Indian name "${partyName}", return a JSON object with:\n` +
      `{"gender": "M" or "F" or "unknown", "name_cleaned": "<name without honorifics like Mr/Mrs/Shri/Smt/Ji>"}`
    );
    if (result.gender)       gender    = result.gender;
    if (result.name_cleaned) nameFinal = result.name_cleaned;
  } catch (e) {
    console.warn(`[listener] Gemini inference failed for "${partyName}": ${e.message}`);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const profile = {
    name:               nameFinal,
    gender,
    linked_ids:         [partyCode],
    tier:               'Bronze',
    language:           'hi',
    is_active:          true,
    join_date:          now,
    consecutive_months: 0,
    tier_threshold:     null,
    created_at:         now,
    created_by:         'telegram-listener',
  };

  const custRef = db.collection('customers').doc(mobile);

  // Main profile doc
  await custRef.set({ profile }, { merge: true });

  // D9 sub-collections — created at onboarding so the rest of the pipeline
  // can safely read/update them without existence checks.
  await Promise.all([
    custRef.collection('st_rupees_ledger').doc(partyCode).set({
      current_balance:   0,
      lifetime_earned:   0,
      lifetime_redeemed: 0,
    }),
    custRef.collection('behavior_advice').doc(partyCode).set({
      party_code:  partyCode,
      created_at:  now,
    }),
    custRef.collection('targets').doc('current').set({
      current: null,
      history: [],
    }),
  ]);

  const fsPath = `customers/${mobile}`;
  console.log(`[listener] Profile created: ${fsPath} | code=${partyCode} | name=${nameFinal} | gender=${gender}`);
  return { ...profile, _fsPath: fsPath };
}

// ── Process a single Telegram update ──────────────────────────────────────────

async function _processUpdate(update) {
  const msg = update.message ?? update.edited_message;
  if (!msg?.text) return;

  // Only act on replies to bot alert messages
  const replyTo = msg.reply_to_message;
  if (!replyTo) return;

  const partyCode = _extractPartyCodeFromAlert(replyTo.text ?? '');
  if (!partyCode) {
    console.warn('[listener] Reply received but no party code in original message:', (replyTo.text ?? '').slice(0, 80));
    return;
  }

  const chatId    = String(msg.chat.id);
  const replyText = (msg.text ?? '').trim();

  // ── skip command ───────────────────────────────────────────────────────────
  if (replyText.toLowerCase() === 'skip' || replyText.toLowerCase() === 's') {
    await db.collection('pending_party_codes').doc(partyCode).set({
      status:      'skipped',
      resolved_at: admin.firestore.FieldValue.serverTimestamp(),
      note:        'Marked as temporary/guest by admin',
    }, { merge: true });
    await _sendTelegramMessage(chatId,
      `✅ Party Code <code>${partyCode}</code> marked as temporary/guest — no profile created.`
    );
    console.log(`[listener] ${partyCode} → skipped`);
    return;
  }

  // ── compound parse: "Party Code X Mobile Y" (voice-to-text format) ────────
  let effectivePartyCode = partyCode;
  let rawMobileText      = replyText;

  const compound = _parseCompoundReply(replyText);
  if (compound) {
    effectivePartyCode = compound.partyCode;
    rawMobileText      = compound.rawMobile;
    if (compound.partyCode !== partyCode) {
      console.warn(
        `[listener] Compound reply party code ${compound.partyCode} differs from alert ` +
        `party code ${partyCode} — using compound value.`
      );
    }
  }

  // ── Reference ID check: 10-digit codes are temporary and need confirmation ─
  const digits = effectivePartyCode.replace(/\D/g, '');
  if (digits.length === 10 && !effectivePartyCode.startsWith('60')) {
    await db.collection('pending_party_codes').doc(effectivePartyCode).set({
      status:           'awaiting_confirmation',
      mobile_candidate: rawMobileText,
      flagged_at:       admin.firestore.FieldValue.serverTimestamp(),
      note:             '10-digit Reference ID — flagged for admin confirmation',
    }, { merge: true });
    await _sendTelegramMessage(chatId,
      `⚠️ <b>Reference ID detected</b>\n` +
      `<code>${effectivePartyCode}</code> is a 10-digit Reference ID (temporary).\n\n` +
      `To proceed:\n` +
      `• Reply <b>YES</b> to confirm creating a profile with this Reference ID\n` +
      `• Or provide the permanent 8-digit AB ID number`
    );
    console.warn(`[listener] ${effectivePartyCode} → 10-digit Reference ID flagged for confirmation`);
    return;
  }

  // ── mobile validation ──────────────────────────────────────────────────────
  const mobile = _parseMobile(rawMobileText);
  if (!mobile) {
    await _sendTelegramMessage(chatId,
      `❓ Could not parse a valid mobile number from "<code>${rawMobileText.slice(0, 40)}</code>".\n\n` +
      `Send a 10-digit Indian mobile number (starts with 6–9), or:\n` +
      `• Full format: <b>Party Code ${effectivePartyCode} Mobile &lt;number&gt;</b>\n` +
      `• Or reply <b>skip</b> to ignore this party code.`
    );
    return;
  }

  // Verify still pending in Firestore
  const pendingSnap = await db.collection('pending_party_codes').doc(effectivePartyCode).get();
  const pendingStatus = pendingSnap.exists ? pendingSnap.data().status : null;
  if (!pendingSnap.exists || pendingStatus !== 'pending') {
    await _sendTelegramMessage(chatId,
      `ℹ️ Party Code <code>${effectivePartyCode}</code> is no longer pending (status: ${pendingStatus ?? 'not found'}).`
    );
    return;
  }

  const partyName = pendingSnap.data().party_name ?? effectivePartyCode;

  // Create profile + D9 sub-collections
  const profile = await _createProfile(mobile, effectivePartyCode, partyName);
  const fsPath  = profile._fsPath ?? `customers/${mobile}`;

  // Mark resolved
  await db.collection('pending_party_codes').doc(effectivePartyCode).set({
    status:      'resolved',
    mobile,
    resolved_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await _sendTelegramMessage(chatId,
    `✅ <b>Customer profile created</b>\n` +
    `Mobile: <code>${mobile}</code>\n` +
    `Party Code: <code>${effectivePartyCode}</code>\n` +
    `Name: ${profile.name} | Gender: ${profile.gender} | Tier: ${profile.tier}\n` +
    `Firestore: <code>${fsPath}</code>`
  );
  console.log(`[listener] ${effectivePartyCode} → resolved → customer ${mobile}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function startListener() {
  console.log('[listener] Telegram listener starting — polling every 30s');
  while (true) {
    try {
      const updates = await _getUpdates();
      for (const update of updates) {
        if (update.update_id > _lastUpdateId) _lastUpdateId = update.update_id;
        await _processUpdate(update).catch(e =>
          console.warn('[listener] processUpdate error:', e.message)
        );
      }
    } catch (e) {
      console.warn('[listener] poll cycle failed:', e.message);
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

if (require.main === module) {
  startListener().catch(e => {
    console.error('[listener] FATAL:', e.message);
    process.exit(1);
  });
}

module.exports = { startListener, _extractPartyCodeFromAlert, _parseMobile, _parseCompoundReply, _createProfile, _processUpdate };
