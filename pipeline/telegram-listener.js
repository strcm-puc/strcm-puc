'use strict';

const https = require('https');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { db, admin } = require('../firebase-config');
const { getCredential } = require('../vault-read');
const { idRef, tagLinkedIds, linkedIdValues } = require('./customer-schema');
const { getLaunchDate, setLaunchDate } = require('./system-config');

const GEMINI_MODEL = 'gemini-2.5-flash-lite';

process.env.GOOGLE_APPLICATION_CREDENTIALS ??=
  path.join(__dirname, '..', 'secrets', 'firebase-service-account.json');

let _tgCreds;
let _ai;
let _lastUpdateId = 0;

// ── Credential caches ──────────────────────────────────────────────────────────

async function _getTgCreds() {
  if (_tgCreds !== undefined) return _tgCreds;
  try   { _tgCreds = await getCredential('telegram_bot'); }
  catch (e) { console.warn('[listener] Telegram creds unavailable:', e.message); _tgCreds = null; }
  return _tgCreds;
}

function _getAi() {
  if (!_ai) {
    _ai = new GoogleGenAI({
      vertexai: true,
      project:  'strcm-apex-500420',
      location: 'us-central1',
    });
  }
  return _ai;
}

// ── Gemini API ─────────────────────────────────────────────────────────────────

async function _callGemini(prompt) {
  const response = await _getAi().models.generateContent({
    model:    GEMINI_MODEL,
    contents: prompt,
    config:   { responseMimeType: 'application/json' },
  });
  const text  = response.text ?? '{}';
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match?.[0] ?? '{}');
  } catch (e) { throw new Error(`Gemini parse failed: ${e.message}`); }
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
  const taggedIds = tagLinkedIds([partyCode]);
  const profile = {
    name:                nameFinal,
    gender,
    linked_ids:          taggedIds,
    linked_id_values:    linkedIdValues(taggedIds),
    tier:                'Bronze',
    language:            'hi',
    status:              'active',
    last_purchase_date:   null,
    last_purchase_amount: null,
    join_date:          now,
    consecutive_months: 0,
    tier_threshold:     null,
    created_at:         now,
    created_by:         'telegram-listener',
  };

  const custRef = db.collection('customers').doc(mobile);

  // Main profile doc
  await custRef.set({ profile }, { merge: true });

  // id-level doc (running balance/debt — never period-scoped) + behavior_advice,
  // created at onboarding so the rest of the pipeline can safely read/update
  // them without existence checks.
  await Promise.all([
    idRef(mobile, partyCode).set({
      current_balance: 0,
      debt:             0,
    }),
    custRef.collection('behavior_advice').doc(partyCode).set({
      party_code:  partyCode,
      created_at:  now,
    }),
  ]);

  const fsPath = `customers/${mobile}`;
  console.log(`[listener] Profile created: ${fsPath} | code=${partyCode} | name=${nameFinal} | gender=${gender}`);
  return { ...profile, _fsPath: fsPath };
}

// ── /cost command — owner-only system spend report ────────────────────────────
// No spend tracking is instrumented anywhere in the codebase today (confirmed by
// reading every Sonnet/Gemini/WhatsApp/Firebase call site — none of them log token
// counts, request counts, or cost to anywhere). This reports that honestly instead
// of fabricating numbers, and states exactly what would need to be added.
async function _handleCostCommand(chatId) {
  const tg = await _getTgCreds();
  if (!tg || chatId !== String(tg.admin_chat_id).trim()) return; // owner-only, silent for anyone else

  await _sendTelegramMessage(chatId,
    `💰 <b>ST-APEX Cost Report</b>\n\n` +
    `No spend tracking exists in the system yet — today's spend, this month's spend, and a ` +
    `per-category breakdown are all <b>not available</b>. I'm not going to invent numbers.\n\n` +
    `<b>To make this real, the following needs to be instrumented:</b>\n` +
    `• <b>Sonnet</b> — log <code>usage.input_tokens</code> / <code>usage.output_tokens</code> from ` +
    `every Anthropic response in reward-calculator.js's _callClaude, priced at the Claude Sonnet rate.\n` +
    `• <b>Gemini</b> — log <code>response.usageMetadata</code> token counts from every Vertex AI call ` +
    `in message-writer.js / telegram-listener.js's _callGemini, priced at the Gemini Flash-Lite rate.\n` +
    `• <b>WhatsApp</b> — log Meta's per-conversation pricing category from each send in sender.js ` +
    `(Meta bills per conversation window, not per message).\n` +
    `• <b>Firebase</b> — pulled from the GCP Billing API for Firestore reads/writes/storage, not ` +
    `something this app computes itself.\n` +
    `• <b>Server</b> — the strcm-apex-vm cost, also from GCP Billing, not app code.\n\n` +
    `Once each call site writes a cost-log entry, this command can sum today's and this month's ` +
    `entries by category. Right now there is nothing to sum.`
  );
  console.log('[listener] /cost answered — no spend tracking instrumented yet');
}

// ── /setlaunchdate YYYY-MM-DD — owner-only, sets /system/config.launch_date ───
// Until this is set, reward-calculator.js refuses to count any reward-eligible
// activity at all (see getLaunchDate() gates in setPeriodTarget, decideDailyMessage,
// checkPeriodEndBonus, runNightlyRewardChecks, and the fetchPeriod*/fetchPurchaseHistory
// date filters). There is no default — an unset launch_date means "not live".
async function _handleSetLaunchDateCommand(chatId, text) {
  const tg = await _getTgCreds();
  if (!tg || chatId !== String(tg.admin_chat_id).trim()) return; // owner-only, silent for anyone else

  const match = text.trim().match(/^\/setlaunchdate\s+(\d{4}-\d{2}-\d{2})$/i);
  if (!match) {
    const current = await getLaunchDate();
    await _sendTelegramMessage(chatId,
      `❓ Usage: <code>/setlaunchdate YYYY-MM-DD</code>\n` +
      `Current launch_date: <code>${current ? current.toISOString().slice(0, 10) : 'not set'}</code>`
    );
    return;
  }

  const dateStr = match[1];
  try {
    await setLaunchDate(dateStr);
  } catch (e) {
    await _sendTelegramMessage(chatId, `❌ Invalid date: ${e.message}`);
    return;
  }

  await _sendTelegramMessage(chatId,
    `🚀 <b>Launch date set</b>\n` +
    `launch_date = <code>${dateStr}</code>\n\n` +
    `Reward-eligible activity dated before this will never be counted, even if ingested later.`
  );
  console.log(`[listener] /setlaunchdate ${dateStr} set by owner`);
}

// ── Process a single Telegram update ──────────────────────────────────────────

async function _processUpdate(update) {
  const msg = update.message ?? update.edited_message;
  if (!msg?.text) return;

  const chatId    = String(msg.chat.id);
  const replyText = (msg.text ?? '').trim();

  // ── /cost: owner-only spend report — standalone command, not a reply ──────
  if (replyText.toLowerCase() === '/cost') {
    await _handleCostCommand(chatId);
    return;
  }

  // ── /setlaunchdate: owner-only launch-date config — standalone command ────
  if (/^\/setlaunchdate\b/i.test(replyText)) {
    await _handleSetLaunchDateCommand(chatId, replyText);
    return;
  }

  // Only act on replies to bot alert messages
  const replyTo = msg.reply_to_message;
  if (!replyTo) return;

  const partyCode = _extractPartyCodeFromAlert(replyTo.text ?? '');
  if (!partyCode) {
    console.warn('[listener] Reply received but no party code in original message:', (replyTo.text ?? '').slice(0, 80));
    return;
  }

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

module.exports = { startListener, _extractPartyCodeFromAlert, _parseMobile, _parseCompoundReply, _createProfile, _processUpdate, _handleCostCommand, _handleSetLaunchDateCommand };
