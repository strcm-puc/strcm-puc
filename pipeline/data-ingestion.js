'use strict';

const https = require('https');
const { db, admin } = require('../firebase-config');
const { getCredential } = require('../vault-read');
const { calculateBaseReward } = require('./base-reward-calculator');
const { applyTargetBonus, applyLoyaltyBonus } = require('./reward-calculator');

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
// Reuses the same Firestore query proven in scraper.js's isKnownPartyCode —
// the doc ID in /customers is the mobile number.

async function resolveMobile(partyCode) {
  const snap = await db.collection('customers')
    .where('profile.linked_ids', 'array-contains', partyCode)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Converts "dd-mm-yyyy" or "yyyy-mm-dd" → "yyyy-mm" for monthly grouping.
function dateToYearMonth(dateStr) {
  if (!dateStr) return null;
  const p = String(dateStr).split('-');
  if (p.length !== 3) return null;
  return p[0].length === 4 ? `${p[0]}-${p[1]}` : `${p[2]}-${p[1]}`;
}

// Sums purchase_summary entries already written for a given yearMonth.
// Excludes the current bill (called before writing the current entry).
async function getPrevMonthlyTotal(mobile, yearMonth) {
  const snap = await db.collection('customers').doc(mobile)
    .collection('purchase_summary').get();
  let total = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (dateToYearMonth(d.date) === yearMonth) total += parseFloat(d.amount) || 0;
  }
  return total;
}

// ── Per-transaction pipeline ───────────────────────────────────────────────────

async function processTransaction(tx) {
  const bill_number = tx.bill_no;
  const id_used     = tx.party_code;
  const amount      = parseFloat(tx.bill_value) || 0;
  const date        = tx.date ?? null;
  const time        = tx.time ?? null;  // not emitted by current scraper; reserved

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

  // Step 3 — ID type: mirrors scraper.js's id_type logic.
  const isDisplayWall = id_used.startsWith('60');

  // Step 4 — Layer 1: always runs, unconditionally.
  // calculateBaseReward routes the write through ledger-writer.js's applyCredit.
  const { baseAmount } = await calculateBaseReward(mobile, id_used, bill_number, amount);
  console.log(`[ingestion] Bill ${bill_number} | Layer 1 base = ${baseAmount}`);

  // Step 5 — Layer 2/3: AB IDs only. Display Wall gets base only (Section C7, locked).
  // applyTargetBonus and applyLoyaltyBonus route writes through ledger-writer.js.
  let targetResult  = { applied: false, amount: 0 };
  let loyaltyResult = { applied: false, amount: 0 };

  if (!isDisplayWall) {
    const customerSnap = await db.collection('customers').doc(mobile).get();
    const profile      = customerSnap.exists ? (customerSnap.data().profile ?? {}) : {};

    const tierThreshold     = profile.tier_threshold     ?? Infinity;
    const consecutiveMonths = profile.consecutive_months ?? 0;

    const yearMonth    = dateToYearMonth(date);
    const prevTotal    = yearMonth ? await getPrevMonthlyTotal(mobile, yearMonth) : 0;
    const monthlyTotal = prevTotal + amount;

    targetResult  = await applyTargetBonus(mobile, id_used, bill_number, monthlyTotal, tierThreshold);
    loyaltyResult = await applyLoyaltyBonus(mobile, id_used, bill_number, consecutiveMonths);

    console.log(`[ingestion] Bill ${bill_number} | Layer 2 target  = ${targetResult.amount}  (applied: ${targetResult.applied})`);
    console.log(`[ingestion] Bill ${bill_number} | Layer 3 loyalty = ${loyaltyResult.amount} (applied: ${loyaltyResult.applied})`);
  } else {
    console.log(`[ingestion] Bill ${bill_number} | Display Wall ID — Layer 2/3 skipped (C7)`);
  }

  // Step 7 — purchase_summary: one entry per bill.
  // products and pv are null — not available from current scraper output; may be backfilled later.
  await db.collection('customers').doc(mobile)
    .collection('purchase_summary')
    .add({ date, bill_no: bill_number, products: null, amount, pv: null, id_used });

  // Step 8 — Mark processed: written only after all steps above succeeded.
  await db.collection('processed_bills').doc(String(bill_number)).set({
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
    mobile,
    id_used,
    amount,
    date,
  });

  console.log(`[ingestion] Bill ${bill_number} complete ✓`);
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function ingestTransactions(transactionsArray) {
  console.log(`[ingestion] Batch start: ${transactionsArray.length} transaction(s)`);
  for (const tx of transactionsArray) {
    try {
      await processTransaction(tx);
    } catch (err) {
      const bill_number = tx.bill_no ?? '(unknown)';
      console.error(`[ingestion] ERROR: Bill ${bill_number} failed mid-pipeline: ${err.message}`);
      await sendTelegramAlert(
        `❌ ST-APEX: Bill ${bill_number} failed mid-pipeline: ${err.message}`
      ).catch(() => {});
    }
  }
  console.log('[ingestion] Batch complete');
}

module.exports = { ingestTransactions };
