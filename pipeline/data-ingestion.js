'use strict';

const https = require('https');
const { db, admin } = require('../firebase-config');
const { getCredential } = require('../vault-read');
const { calculateBaseReward }  = require('./base-reward-calculator');
const { updateProductLedger, _pickStr, _pickNum } = require('./product-ledger');
const { parseDate } = require('./reward-calculator');
const { idType, fiscalPeriodKey, purchasesCol, productsCol, customerRef } = require('./customer-schema');

// ── Telegram ───────────────────────────────────────────────────────────────────
// Same implementation as scraper.js — loads creds once, reuses across batch.

let _tgCreds;

async function _getTgCreds() {
  if (_tgCreds !== undefined) return _tgCreds;
  try {
    _tgCreds = await getCredential('telegram_bot');
  } catch (e) {
    console.warn('[ingestion] Could not load Telegram creds:', e.message);
    _tgCreds = null;
  }
  return _tgCreds;
}

async function sendTelegramAlert(text) {
  const tg = await _getTgCreds();
  if (!tg) return;
  const token  = String(tg.bot_token).trim();
  const chatId = String(tg.admin_chat_id).trim();
  const body   = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path:     `/bot${token}/sendMessage`,
        method:   'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end',  () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
      }
    );
    req.on('error', e => { console.warn('[ingestion] Telegram alert failed:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Customer resolution ────────────────────────────────────────────────────────
// linked_ids is now an array of {id, type} objects — array-contains can't match
// into object fields, so lookups go through the parallel linked_id_values field
// (plain strings, kept in sync wherever linked_ids is written).

async function resolveMobile(partyCode) {
  const snap = await db.collection('customers')
    .where('profile.linked_id_values', 'array-contains', partyCode)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

// ── Per-transaction pipeline ───────────────────────────────────────────────────

async function processTransaction(tx) {
  const bill_number = tx.bill_no;
  const id_used     = tx.party_code;
  const amount      = parseFloat(tx.bill_value) || 0;
  const date        = tx.date ?? null;
  const pv          = tx.pv != null && tx.pv !== '' ? (parseFloat(tx.pv) || 0) : null;
  const parsedDate  = parseDate(date) ?? new Date();
  const isDW        = idType(id_used) === 'display_wall';
  const periodKey   = fiscalPeriodKey(parsedDate, isDW);

  // Step 1 — Idempotency: skip if this bill was fully processed on a prior run.
  const processedSnap = await db.collection('processed_bills').doc(String(bill_number)).get();
  if (processedSnap.exists) {
    console.log(`[ingestion] Bill ${bill_number} already processed, skipping`);
    return;
  }

  // Step 2 — Customer resolution: no mobile → no credit, alert admin.
  const mobile = await resolveMobile(id_used);
  if (!mobile) {
    console.warn(`[ingestion] No mobile linked to party code ${id_used} (bill ${bill_number}) — skipping`);
    await sendTelegramAlert(
      `⚠️ ST-APEX: Bill ${bill_number} skipped — no customer mobile linked to party code ` +
      `<code>${id_used}</code>.\nPlease link this ID to a customer profile and reprocess.`
    ).catch(() => {});
    return;
  }

  // Step 4 — Layer 1: always runs, unconditionally.
  // calculateBaseReward routes the write through ledger-writer.js's applyCredit,
  // dated to this bill so the ledger entry lands in the right period folder.
  const { baseAmount } = await calculateBaseReward(mobile, id_used, bill_number, amount, parsedDate);
  console.log(`[ingestion] Bill ${bill_number} | Layer 1 base = ${baseAmount}`);

  // Step 5 — Product ledger (DW ids only; no-op for AB ID).
  // Called after Layer 1 so the bill's existence is confirmed before updating.
  await updateProductLedger(mobile, id_used, tx.items ?? []).catch(e =>
    console.warn(`[ingestion] Product ledger failed for bill ${bill_number}: ${e.message}`)
  );

  // Layer 2/3 bonuses are deferred to checkPeriodEndBonus (period-end only).
  // Nothing extra to do per transaction for L2/L3.

  // Step 7 — purchases log: one doc per bill, keyed by bill_number, under this
  // id's current period folder.
  await purchasesCol(mobile, id_used, periodKey).doc(String(bill_number)).set({
    date, bill_no: bill_number, amount, pv, id_used,
  });

  // Step 7b — products log: itemized breakdown for this bill, same period folder.
  for (const row of (tx.items ?? [])) {
    const productName = _pickStr(row, 'Item Name', 'ItemName', 'Product Name', 'ProductName', 'Description', 'Item', 'Product');
    if (!productName) continue;
    const quantity = _pickNum(row, 'Qty', 'Quantity', 'Qty.', 'Ordered Qty', 'Qty Ordered');
    await productsCol(mobile, id_used, periodKey).add({
      bill_number, date, product_name: productName, quantity,
    });
  }

  // Step 7c — profile denormalized fields, for quick display without a purchases scan.
  await customerRef(mobile).set({
    profile: { last_purchase_date: date, last_purchase_amount: amount },
  }, { merge: true });

  // Step 8 — Mark processed: written only after all steps above succeeded.
  await db.collection('processed_bills').doc(String(bill_number)).set({
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
    mobile,
    id_used,
    amount,
    date,
  });

  console.log(`[ingestion] Bill ${bill_number} complete ✓`);
  return { mobile, amount };
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function ingestTransactions(transactionsArray) {
  console.log(`[ingestion] Batch start: ${transactionsArray.length} transaction(s)`);
  // Accumulates mobile → total-amount-today for tonight's transaction batch.
  // run-nightly.js passes this to runNightlyRewardChecks → decideDailyMessage.
  const processedMobiles = new Map();
  for (const tx of transactionsArray) {
    try {
      const result = await processTransaction(tx);
      if (result?.mobile) {
        const prev = processedMobiles.get(result.mobile) ?? 0;
        processedMobiles.set(result.mobile, prev + (result.amount ?? 0));
      }
    } catch (err) {
      const bill_number = tx.bill_no ?? '(unknown)';
      console.error(`[ingestion] ERROR: Bill ${bill_number} failed mid-pipeline: ${err.message}`);
      await sendTelegramAlert(
        `❌ ST-APEX: Bill ${bill_number} failed mid-pipeline: ${err.message}`
      ).catch(() => {});
    }
  }
  console.log('[ingestion] Batch complete');
  return { processedMobiles };
}

module.exports = { ingestTransactions };
