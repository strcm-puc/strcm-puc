'use strict';

const https = require('https');
const { db, admin } = require('../firebase-config');
const { getCredential } = require('../vault-read');

let _waCreds;
let _tgCreds;

async function _getWaCreds() {
  if (_waCreds !== undefined) return _waCreds;
  try   { _waCreds = await getCredential('whatsapp_api'); }
  catch (e) { console.warn('[sender] WhatsApp creds unavailable:', e.message); _waCreds = null; }
  return _waCreds;
}

async function _getTgCreds() {
  if (_tgCreds !== undefined) return _tgCreds;
  try   { _tgCreds = await getCredential('telegram_bot'); }
  catch (e) { console.warn('[sender] Telegram creds unavailable:', e.message); _tgCreds = null; }
  return _tgCreds;
}

// ── Telegram alert ─────────────────────────────────────────────────────────────

async function _sendTelegramAlert(text) {
  const tg = await _getTgCreds();
  if (!tg) return;
  const token  = String(tg.bot_token).trim();
  const chatId = String(tg.admin_chat_id).trim();
  const body   = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
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
    req.on('error', e => { console.warn('[sender] Telegram alert failed:', e.message); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Meta WhatsApp Cloud API ────────────────────────────────────────────────────

function _buildTemplateComponents(bodyVars, headerVars) {
  const components = [];
  if (Array.isArray(headerVars) && headerVars.length > 0) {
    components.push({
      type:       'header',
      parameters: headerVars.map(v => ({ type: 'text', text: String(v) })),
    });
  }
  if (Array.isArray(bodyVars) && bodyVars.length > 0) {
    components.push({
      type:       'body',
      parameters: bodyVars.map(v => ({ type: 'text', text: String(v) })),
    });
  }
  return components;
}

async function _sendWhatsAppTemplate(mobile, templateName, templateLanguage, bodyVars, headerVars) {
  const wa = await _getWaCreds();
  if (!wa) throw new Error('WhatsApp credentials not available');

  const phoneNumberId = String(wa.phone_number_id).trim();
  const accessToken   = String(wa.access_token).trim();
  const components    = _buildTemplateComponents(bodyVars, headerVars);

  const payload = {
    messaging_product: 'whatsapp',
    to:   `91${mobile}`,
    type: 'template',
    template: {
      name:     templateName,
      language: { code: templateLanguage ?? 'hi' },
      ...(components.length > 0 ? { components } : {}),
    },
  };
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path:     `/v21.0/${phoneNumberId}/messages`,
      method:   'POST',
      headers:  {
        Authorization:    `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(`Meta API: ${parsed.error.message} (code ${parsed.error.code})`));
          resolve(parsed);
        } catch (e) { reject(new Error(`Meta response parse failed: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── STOP / unsubscribe handler (D8) ───────────────────────────────────────────
// Called when a customer replies STOP — via webhook or manual admin action.

async function handleStopReply(mobile) {
  const custSnap = await db.collection('customers').doc(mobile).get();
  const profile  = custSnap.data()?.profile ?? {};
  const name     = profile.name ?? mobile;

  await db.collection('customers').doc(mobile).set({
    profile: {
      unsubscribed:    true,
      unsubscribed_at: admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  await _sendTelegramAlert(
    `🛑 <b>STOP received</b>\nCustomer: ${name}\nMobile: <code>${mobile}</code>\n` +
    `Marked unsubscribed — no further messages will be sent.`
  );

  console.log(`[sender] STOP processed: ${mobile} (${name}) — unsubscribed`);
}

// ── Main: process the send queue ──────────────────────────────────────────────
// Reads all send_queue docs with status='pending', sends each via Meta Cloud API,
// writes to customers/{mobile}/message_history, updates send_queue status.

async function sendPendingMessages({ dryRun = false } = {}) {
  if (dryRun) console.log('[sender] *** DRY-RUN MODE — Meta send endpoint will NOT be called ***');

  const queueSnap = await db.collection('send_queue')
    .where('status', '==', 'pending')
    .get();

  if (queueSnap.empty) {
    console.log('[sender] No pending messages in queue');
    return { sent: 0, failed: 0, skipped: 0 };
  }

  console.log(`[sender] Processing ${queueSnap.docs.length} pending message(s)`);

  let sent = 0, failed = 0, skipped = 0;

  for (const doc of queueSnap.docs) {
    const queueId = doc.id;
    const item    = doc.data();
    const mobile  = item.mobile;

    // Re-check unsubscribed status at send time
    const custSnap = await db.collection('customers').doc(mobile).get();
    if (custSnap.data()?.profile?.unsubscribed === true) {
      await db.collection('send_queue').doc(queueId).set(
        { status: 'unsubscribed', updated_at: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      console.log(`[sender] Skipped (unsubscribed): mobile=${mobile}`);
      skipped++;
      continue;
    }

    try {
      const ts = admin.firestore.FieldValue.serverTimestamp();

      if (dryRun) {
        const components = _buildTemplateComponents(item.body_variables ?? [], item.header_variables ?? []);
        const wa = await _getWaCreds();
        const dryPayload = {
          messaging_product: 'whatsapp',
          to:   `91${mobile}`,
          type: 'template',
          template: {
            name:     item.template_name,
            language: { code: item.template_language ?? 'hi' },
            ...(components.length > 0 ? { components } : {}),
          },
          _meta: {
            phone_number_id: wa ? String(wa.phone_number_id).trim() : '(not loaded)',
            endpoint: `/v21.0/{phone_number_id}/messages`,
          },
        };

        console.log(`\n[sender] DRY-RUN — would POST to graph.facebook.com:`);
        console.log(JSON.stringify(dryPayload, null, 2));
        console.log(`[sender] DRY-RUN — message_preview: "${item.message_preview ?? ''}"`);
        console.log(`[sender] DRY-RUN — magic_token: ${item.magic_token ?? 'none'}\n`);

        await db.collection('send_queue').doc(queueId).set(
          { status: 'dry_run', dry_run_at: ts, updated_at: ts },
          { merge: true }
        );
        await db.collection('customers').doc(mobile).collection('message_history').add({
          mobile,
          queue_id:        queueId,
          template_name:   item.template_name,
          message_preview: item.message_preview ?? '',
          opener:          item.opener          ?? '',
          magic_token:     item.magic_token     ?? null,
          status:          'dry_run',
          dry_run_at:      ts,
        });
        sent++;

      } else {
        const apiResponse = await _sendWhatsAppTemplate(
          mobile,
          item.template_name,
          item.template_language ?? 'hi',
          item.body_variables    ?? [],
          item.header_variables  ?? [],
        );

        const wamid = apiResponse.messages?.[0]?.id ?? null;

        await db.collection('send_queue').doc(queueId).set(
          { status: 'sent', sent_at: ts, wamid, updated_at: ts },
          { merge: true }
        );
        await db.collection('customers').doc(mobile).collection('message_history').add({
          mobile,
          queue_id:        queueId,
          template_name:   item.template_name,
          message_preview: item.message_preview ?? '',
          opener:          item.opener          ?? '',
          magic_token:     item.magic_token     ?? null,
          status:          'sent',
          sent_at:         ts,
          wamid,
        });

        console.log(`[sender] Sent: mobile=${mobile} | template=${item.template_name} | wamid=${wamid}`);
        sent++;
      }

    } catch (err) {
      const failedAt = admin.firestore.FieldValue.serverTimestamp();

      await db.collection('send_queue').doc(queueId).set(
        { status: 'failed', error: err.message, updated_at: failedAt },
        { merge: true }
      );

      await db.collection('customers').doc(mobile)
        .collection('message_history')
        .add({
          mobile,
          queue_id:      queueId,
          template_name: item.template_name ?? '',
          status:        'failed',
          error:         err.message,
          sent_at:       failedAt,
        });

      await _sendTelegramAlert(
        `❌ <b>WhatsApp send failed</b>\nMobile: <code>${mobile}</code>\n` +
        `Template: ${item.template_name}\nError: ${err.message}`
      ).catch(() => {});

      console.error(`[sender] FAILED: mobile=${mobile} | ${err.message}`);
      failed++;
    }
  }

  console.log(`[sender] Done — sent=${sent}  failed=${failed}  skipped=${skipped}`);
  return { sent, failed, skipped };
}

if (require.main === module) {
  sendPendingMessages()
    .then(r => { console.log('[sender] Completed:', r); process.exit(0); })
    .catch(e => { console.error('[sender] FATAL:', e.message); process.exit(1); });
}

module.exports = { sendPendingMessages, handleStopReply };
