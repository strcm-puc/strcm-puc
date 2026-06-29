'use strict';

const https  = require('https');
const { db, admin } = require('../firebase-config');
const { getCredential }  = require('../vault-read');
const { applyCredit }    = require('./ledger-writer');

// ── Test hook: inject a fixed "today" so unit tests control date-gating ───────
let _nowFn = () => new Date();
function _setNow(fn) { _nowFn = fn; }

// ── Credential caches ─────────────────────────────────────────────────────────

let _anthropicCreds;
async function _getAnthropicCreds() {
  if (_anthropicCreds !== undefined) return _anthropicCreds;
  try   { _anthropicCreds = await getCredential('anthropic_api'); }
  catch (e) { console.warn('[reward] Anthropic creds unavailable:', e.message); _anthropicCreds = null; }
  return _anthropicCreds;
}

let _rcmCreds;
async function _getRcmStoreCode() {
  if (_rcmCreds !== undefined) return _rcmCreds?.store_code ?? null;
  try   { _rcmCreds = await getCredential('rcm_login'); }
  catch (e) { console.warn('[reward] RCM creds unavailable:', e.message); _rcmCreds = null; }
  return _rcmCreds?.store_code ?? null;
}

let _tgCreds;
async function _getTgCreds() {
  if (_tgCreds !== undefined) return _tgCreds;
  try   { _tgCreds = await getCredential('telegram_bot'); }
  catch (e) { console.warn('[reward] Telegram creds unavailable:', e.message); _tgCreds = null; }
  return _tgCreds;
}

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
    req.on('error', e => { console.warn('[reward] Telegram alert failed:', e.message); resolve(null); });
    req.write(body); req.end();
  });
}

// ── Anthropic API (used only by decideDailyMessage) ───────────────────────────

async function _callClaude(userMessage) {
  const creds = await _getAnthropicCreds();
  if (!creds) throw new Error('Anthropic credentials not available');
  const apiKey = String(creds.api_key).trim();
  const body   = JSON.stringify({
    model:      'claude-sonnet-4-6',
    max_tokens: 512,
    messages:   [{ role: 'user', content: userMessage }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message ?? 'Anthropic API error'));
          const text  = (parsed.content?.[0]?.text ?? '').trim();
          const match = text.match(/\{[\s\S]*\}/);
          if (!match) return reject(new Error(`No JSON in Claude response: ${text.slice(0, 120)}`));
          resolve(JSON.parse(match[0]));
        } catch (e) { reject(new Error(`Claude response parse failed: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Date / period helpers ─────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const p = String(str).split('-');
  if (p.length !== 3) return null;
  const d = p[0].length === 4
    ? new Date(`${p[0]}-${p[1]}-${p[2]}`)
    : new Date(`${p[2]}-${p[1]}-${p[0]}`);
  return isNaN(d.getTime()) ? null : d;
}

// A customer is Display Wall when ALL their linked IDs start with '60'.
function isDisplayWallCustomer(profile) {
  const ids = profile?.linked_ids ?? [];
  return ids.length > 0 && ids.every(id => String(id).startsWith('60'));
}

// Returns the first day and last day of the current period as midnight-local Date objects.
function getPeriodBounds(date, isDW) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-indexed
  if (isDW) {
    const q      = Math.floor(m / 3);
    const startM = q * 3;
    const endM   = startM + 2;
    return { start: new Date(y, startM, 1), end: new Date(y, endM + 1, 0) };
  }
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0) };
}

// 1-indexed day within the current period.
function getDayOfPeriod(date, isDW) {
  const { start } = getPeriodBounds(date, isDW);
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((d - s) / 86400000) + 1;
}

// How many days until (and including) the period end? 0 = today is the last day.
function daysUntilPeriodEnd(date, isDW) {
  const { end } = getPeriodBounds(date, isDW);
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((e - d) / 86400000);
}

// Period key strings: '2026-06' (monthly) or '2026-Q2' (quarterly).
function getPeriodKey(date, isDW) {
  const y = date.getFullYear();
  const m = date.getMonth();
  if (isDW) return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function getPrevPeriodKey(date, isDW) {
  if (isDW) {
    const y = date.getFullYear();
    const q = Math.floor(date.getMonth() / 3) + 1;
    return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
  }
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Last calendar day of the previous period, as a Date.
function getPrevPeriodLastDay(date, isDW) {
  const { start } = getPeriodBounds(date, isDW);
  const d = new Date(start);
  d.setDate(d.getDate() - 1);
  return d;
}

// ── Message budget config ─────────────────────────────────────────────────────

const TIER_MESSAGE_BUDGET = {
  'VIP Gold': 6,
  'Gold':     6,
  'Silver':   10,
  'Saathi':   12,
};
const DW_QUARTERLY_BUDGET = 5;

function _getBudgetMax(profile, isDW) {
  if (isDW) return DW_QUARTERLY_BUDGET;
  return TIER_MESSAGE_BUDGET[profile?.tier ?? 'Saathi'] ?? 12;
}

// ── Firestore data helpers ────────────────────────────────────────────────────

// Groups purchase_summary by period, returns last N periods sorted ascending.
async function fetchPurchaseHistory(mobile, isDW, periodsBack = 6) {
  const snap = await db.collection('customers').doc(mobile).collection('purchase_summary').get();
  const grouped = {};
  for (const doc of snap.docs) {
    const d   = doc.data();
    const dt  = parseDate(d.date);
    if (!dt) continue;
    const y = dt.getFullYear();
    const m = dt.getMonth();
    const key = isDW
      ? `${y}-Q${Math.floor(m / 3) + 1}`
      : `${y}-${String(m + 1).padStart(2, '0')}`;
    grouped[key] = (grouped[key] ?? 0) + (parseFloat(d.amount) || 0);
  }
  return Object.entries(grouped)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-periodsBack)
    .map(([period, total]) => ({ period, total }));
}

// Sums purchase_summary amounts within a date range (inclusive).
// excludeIds: optional Set of id_used values whose amounts are excluded (ST Rupees store code).
async function fetchPeriodSales(mobile, periodStart, periodEnd, excludeIds = null) {
  const snap = await db.collection('customers').doc(mobile).collection('purchase_summary').get();
  const s = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
  const e = new Date(periodEnd.getFullYear(),   periodEnd.getMonth(),   periodEnd.getDate());
  let total = 0;
  for (const doc of snap.docs) {
    const d  = doc.data();
    if (excludeIds && excludeIds.has(String(d.id_used ?? ''))) continue;
    const dt = parseDate(d.date);
    if (!dt) continue;
    const day = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    if (day >= s && day <= e) total += parseFloat(d.amount) || 0;
  }
  return total;
}

// Sums 'goods return reversal' ledger entries within a date range across all linked IDs.
async function fetchPeriodReturns(mobile, linkedIds, periodStart, periodEnd) {
  const s = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
  const e = new Date(periodEnd.getFullYear(),   periodEnd.getMonth(),   periodEnd.getDate());
  let totalReturns = 0;
  for (const idUsed of linkedIds) {
    const snap = await db.collection('customers').doc(mobile)
      .collection('st_rupees_ledger').doc(String(idUsed))
      .collection('entries').get();
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.reason !== 'goods return reversal') continue;
      const ts = d.timestamp ? new Date(d.timestamp) : null;
      if (!ts || isNaN(ts.getTime())) continue;
      const day = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());
      if (day >= s && day <= e) totalReturns += parseFloat(d.amount) || 0;
    }
  }
  return totalReturns;
}

// ── Function 1: setPeriodTarget ───────────────────────────────────────────────
// Runs on days 1–5 of a new period. Computes the bracket reference for this period
// using a rolling 3-period average (AB ID) or quarter-based stretch (DW — next step).
async function setPeriodTarget(customerId, salesDate) {
  const today = salesDate ?? _nowFn();

  const snap = await db.collection('customers').doc(customerId).get();
  if (!snap.exists) return { skipped: true, reason: 'customer not found' };

  const profile = snap.data().profile ?? {};
  const isDW    = isDisplayWallCustomer(profile);

  const dayOfPeriod = getDayOfPeriod(today, isDW);
  if (dayOfPeriod > 5) return { skipped: true, reason: `day ${dayOfPeriod} outside window [1-5]` };

  const periodKey = getPeriodKey(today, isDW);
  const { start: periodStart, end: periodEnd } = getPeriodBounds(today, isDW);

  // Idempotent: target already set for this period → skip
  const existingSnap = await db.collection('customers').doc(customerId)
    .collection('period_targets').doc(periodKey).get();
  if (existingSnap.exists) return { skipped: true, reason: 'target already set', periodKey };

  // Previous-period wrap-up: pay missed bonus before opening new period
  const prevKey        = getPrevPeriodKey(today, isDW);
  const prevTargetSnap = await db.collection('customers').doc(customerId)
    .collection('period_targets').doc(prevKey).get();
  const prevBonusSnap  = await db.collection('customers').doc(customerId)
    .collection('period_bonuses').doc(prevKey).get();
  if (prevTargetSnap.exists && !prevBonusSnap.exists) {
    console.log(`[reward] ${customerId} | wrap-up: paying missed bonus for ${prevKey}`);
    await checkPeriodEndBonus(customerId, getPrevPeriodLastDay(today, isDW));
  }

  // ── Display Wall target: 108% new-account onboarding or 110% regular ────────
  if (isDW) {
    const dwHistory     = await fetchPurchaseHistory(customerId, isDW, 6);
    // Dormant freeze: zero-spend quarters are excluded from the average entirely
    const realQuarters  = dwHistory.filter(h => h.total > 0);
    const isNewAccount  = realQuarters.length < 3;

    let dwTargetDoc;

    if (isNewAccount) {
      // New-account onboarding (< 3 full quarters of real history):
      // target = 108% of the average of however many real quarters exist so far.
      // Once 3 full quarters accumulate the regular 110%-of-3Q-average system takes over.
      const baselineAvg  = realQuarters.length > 0
        ? realQuarters.reduce((s, h) => s + h.total, 0) / realQuarters.length
        : 0;
      const targetAmount = Math.round(baselineAvg * 1.08);

      dwTargetDoc = {
        period_key:          periodKey,
        target_amount:       targetAmount,
        rolling_average:     Math.round(baselineAvg),
        new_account:         true,
        quarters_on_record:  realQuarters.length,
        growth_threshold:    targetAmount,
        // product_completed is set externally when the recommended product purchase is confirmed
        product_completed:   false,
        period_start:        periodStart.toISOString().slice(0, 10),
        period_end:          periodEnd.toISOString().slice(0, 10),
        reasoning:           `DW new-account onboarding: ${realQuarters.length} quarter(s) on record; 108% of baseline Rs ${Math.round(baselineAvg)} = Rs ${targetAmount}`,
        set_at:              admin.firestore.FieldValue.serverTimestamp(),
      };
    } else {
      // Full system: last 3 real quarters, 70% anti-sandbagging floor (DW floor ≠ AB 80%)
      const raw3   = realQuarters.slice(-3).map(h => h.total);
      const rawAvg = raw3.reduce((a, b) => a + b, 0) / 3;

      const floored3   = raw3.map(t => Math.max(t, Math.round(rawAvg * 0.70)));
      const rollingAvg = Math.round(floored3.reduce((a, b) => a + b, 0) / 3);
      const growthThreshold = Math.round(rollingAvg * 1.10);

      dwTargetDoc = {
        period_key:          periodKey,
        target_amount:       growthThreshold,
        rolling_average:     rollingAvg,
        new_account:         false,
        quarters_on_record:  realQuarters.length,
        growth_threshold:    growthThreshold,
        product_completed:   false,
        period_start:        periodStart.toISOString().slice(0, 10),
        period_end:          periodEnd.toISOString().slice(0, 10),
        reasoning:           `DW rolling avg Rs ${rollingAvg} (3-quarter, 70% sandbag-floor); target ≥ Rs ${growthThreshold} (110%)`,
        set_at:              admin.firestore.FieldValue.serverTimestamp(),
      };
    }

    await db.collection('customers').doc(customerId)
      .collection('period_targets').doc(periodKey)
      .set(dwTargetDoc);

    console.log(
      `[reward] setPeriodTarget ${customerId} | ${periodKey} | ` +
      `DW ${isNewAccount ? 'new-account onboarding' : `avg=Rs ${dwTargetDoc.rolling_average}`} | ` +
      dwTargetDoc.reasoning
    );
    return { periodKey, targetAmount: dwTargetDoc.target_amount, newAccount: isNewAccount, skipped: false };
  }

  // ── AB ID: rolling-average bracket system ─────────────────────────────────────
  const history     = await fetchPurchaseHistory(customerId, isDW, 6);
  // Periods with real purchases only (exclude phantom zero periods)
  const realPeriods = history.filter(h => h.total > 0);

  // Cold-start: fewer than 3 real periods on record, OR 12+ months since last purchase
  const isInactive12 = realPeriods.length > 0 && (() => {
    const lastPeriod = realPeriods[realPeriods.length - 1].period;  // 'YYYY-MM'
    const cutoff     = new Date(today.getFullYear() - 1, today.getMonth(), 1);
    return new Date(lastPeriod + '-01') < cutoff;
  })();

  const isColdStart    = realPeriods.length < 3 || isInactive12;
  // Which cold-start month we're on: 1, 2, or 3
  const coldStartMonth = isColdStart ? Math.min(realPeriods.length + 1, 3) : null;

  let targetDoc;

  if (isColdStart) {
    let targetAmount  = 0;
    let coldReasoning = '';

    if (coldStartMonth === 1) {
      targetAmount  = 0;
      coldReasoning = 'Cold-start month 1: no target, 1% only';
    } else if (coldStartMonth === 2) {
      const m1Total = realPeriods[0]?.total ?? 0;
      targetAmount  = m1Total + 200;
      coldReasoning = `Cold-start month 2: month-1 actual Rs ${m1Total} + Rs 200`;
    } else {
      // Month 3: target = month 2 actual + 200
      const m2Total = realPeriods[1]?.total ?? 0;
      targetAmount  = m2Total + 200;
      coldReasoning = `Cold-start month 3: month-2 actual Rs ${m2Total} + Rs 200`;
    }

    targetDoc = {
      period_key:       periodKey,
      target_amount:    targetAmount,
      rolling_average:  0,
      cold_start:       true,
      cold_start_month: coldStartMonth,
      missed_threshold: 0,
      growth_threshold: 0,
      period_start:     periodStart.toISOString().slice(0, 10),
      period_end:       periodEnd.toISOString().slice(0, 10),
      reasoning:        coldReasoning,
      set_at:           admin.firestore.FieldValue.serverTimestamp(),
    };
  } else {
    // Full rolling-average system: last 3 real periods, anti-sandbagging floor at 80%
    const raw3   = realPeriods.slice(-3).map(h => h.total);
    const rawAvg = raw3.reduce((a, b) => a + b, 0) / 3;

    // Each period value floored to 80% of rawAvg for averaging purposes.
    // Prevents a deliberate low month from decaying the rolling average unfairly.
    const floored3   = raw3.map(t => Math.max(t, Math.round(rawAvg * 0.80)));
    const rollingAvg = Math.round(floored3.reduce((a, b) => a + b, 0) / 3);

    const missedThreshold = Math.round(rollingAvg * 0.90);
    const growthThreshold = Math.round(rollingAvg * 1.05);

    targetDoc = {
      period_key:       periodKey,
      target_amount:    growthThreshold,   // Growth threshold shown as the stretch goal in messaging
      rolling_average:  rollingAvg,
      cold_start:       false,
      cold_start_month: null,
      missed_threshold: missedThreshold,
      growth_threshold: growthThreshold,
      period_start:     periodStart.toISOString().slice(0, 10),
      period_end:       periodEnd.toISOString().slice(0, 10),
      reasoning:        `Rolling avg Rs ${rollingAvg} (3-period, 80% sandbag-floor applied); missed < Rs ${missedThreshold}, growth ≥ Rs ${growthThreshold}`,
      set_at:           admin.firestore.FieldValue.serverTimestamp(),
    };
  }

  await db.collection('customers').doc(customerId)
    .collection('period_targets').doc(periodKey)
    .set(targetDoc);

  console.log(
    `[reward] setPeriodTarget ${customerId} | ${periodKey} | ` +
    `${isColdStart ? `cold-start M${coldStartMonth}` : `avg=Rs ${targetDoc.rolling_average}`} | ` +
    targetDoc.reasoning
  );
  return { periodKey, targetAmount: targetDoc.target_amount, coldStart: isColdStart, skipped: false };
}

// ── Function 2: decideDailyMessage ────────────────────────────────────────────
// Runs ONLY for customers who had an actual sale tonight (never the full base).
// Returns a briefing object — Gemini writes the actual message text from this.
async function decideDailyMessage(customerId, todaysPurchaseAmount, salesDate) {
  const today = salesDate ?? _nowFn();

  const snap = await db.collection('customers').doc(customerId).get();
  if (!snap.exists) return { skipped: true, reason: 'customer not found' };

  const profile = snap.data().profile ?? {};
  const isDW    = isDisplayWallCustomer(profile);
  const periodKey = getPeriodKey(today, isDW);
  const { start: periodStart, end: periodEnd } = getPeriodBounds(today, isDW);

  const daysLeft  = daysUntilPeriodEnd(today, isDW);
  const isNearEnd = daysLeft <= 4; // last 5 days of period

  // Fetch current period target (fallback to profile.tier_threshold)
  const targetSnap   = await db.collection('customers').doc(customerId)
    .collection('period_targets').doc(periodKey).get();
  const targetAmount = targetSnap.exists
    ? (targetSnap.data().target_amount ?? 0)
    : (profile.tier_threshold ?? 0);

  // MTD and progress — pure arithmetic, never sent to Claude for computation
  const mtdTotal    = await fetchPeriodSales(customerId, periodStart, today);
  const progressPct = targetAmount > 0 ? Math.round((mtdTotal / targetAmount) * 100) : 0;
  const targetLeft  = Math.max(0, targetAmount - mtdTotal);

  // Message budget check — MUST happen BEFORE any Claude call (zero API cost when exhausted)
  const budgetSnap     = await db.collection('customers').doc(customerId)
    .collection('message_budget').doc(periodKey).get();
  const sentThisPeriod = budgetSnap.exists ? (budgetSnap.data().sent ?? 0) : 0;
  const maxAllowed     = _getBudgetMax(profile, isDW);

  if (sentThisPeriod >= maxAllowed) {
    console.log(
      `[reward] decideDailyMessage ${customerId} | ${periodKey} | ` +
      `budget exhausted (${sentThisPeriod}/${maxAllowed} ${isDW ? 'this quarter' : 'this month'}) — zero API cost`
    );
    return { skipped: true, reason: `message budget exhausted (${sentThisPeriod}/${maxAllowed})` };
  }

  const prompt = [
    'You are the ST-APEX messaging advisor. Decide whether a WhatsApp message is warranted today and what it should convey.',
    'Return ONLY a JSON object — no markdown, no text before or after it.',
    '',
    'LAW BOOK SECTION E (messaging rules):',
    '  - NEVER use urgency language: no "hurry", "last chance", "deadline", "limited time", "don\'t miss".',
    `  - ${isNearEnd
        ? 'Customer is in the LAST 5 DAYS of their period — apply heightened attention, focus on target-approach progress, celebratory if near/past target.'
        : 'Mid-period — standard engagement tone, no pressure.'}`,
    `  - Budget remaining: ${maxAllowed - sentThisPeriod} messages left this ${isDW ? 'quarter' : 'month'}. Spend one NOW only if there is genuine signal (real purchase, meaningful progress, celebration). Return send_message:false to conserve budget.`,
    '',
    'CUSTOMER (provided by system — do NOT recompute any numbers):',
    `  Name        : ${profile.name ?? 'Customer'}`,
    `  Gender      : ${profile.gender ?? 'unknown'}`,
    `  Tier        : ${profile.tier ?? 'Saathi'}`,
    `  Period      : ${periodKey}`,
    `  Today\'s purchase   : Rs ${todaysPurchaseAmount}`,
    `  Period target      : Rs ${targetAmount}`,
    `  MTD progress       : ${progressPct}%  (Rs ${mtdTotal} of Rs ${targetAmount})`,
    `  Target remaining   : Rs ${targetLeft}`,
    `  Days left in period: ${daysLeft}`,
    `  Near period-end    : ${isNearEnd}`,
    '',
    'Return: {"send_message":<bool>,"customer_name":"<str>","gender":"<M|F|unknown>","what_happened":"<brief>","tone_needed":"<str>","show_rupee_amount":<bool>,"do_not_mention":["<word>",...],"st_account_link":<bool>}',
  ].join('\n');

  let claudeResult;
  try {
    claudeResult = await _callClaude(prompt);
  } catch (err) {
    console.error(`[reward] decideDailyMessage ${customerId}: Claude failed: ${err.message}`);
    return { skipped: true, reason: `Claude failed: ${err.message}` };
  }

  // Sonnet may conserve the budget if there's no genuine signal
  if (claudeResult.send_message === false) {
    console.log(
      `[reward] decideDailyMessage ${customerId} | ${periodKey} | ` +
      `Sonnet: conserve budget (${sentThisPeriod}/${maxAllowed} used)`
    );
    return { skipped: true, reason: 'Sonnet decided to conserve message budget' };
  }

  // Budget slot consumed — increment counter
  await db.collection('customers').doc(customerId)
    .collection('message_budget').doc(periodKey)
    .set({
      period_key:  periodKey,
      sent:        sentThisPeriod + 1,
      max_allowed: maxAllowed,
      tier:        profile.tier ?? 'Saathi',
      updated_at:  admin.firestore.FieldValue.serverTimestamp(),
    });

  console.log(
    `[reward] decideDailyMessage ${customerId} | ${periodKey} | ` +
    `progress=${progressPct}%  tone=${claudeResult.tone_needed}  near-end=${isNearEnd} | ` +
    `budget: ${sentThisPeriod + 1}/${maxAllowed}`
  );
  return { briefing: claudeResult, progressPct, targetLeft, daysLeft, isNearEnd, skipped: false };
}

// ── Function 3: checkPeriodEndBonus ──────────────────────────────────────────
// Runs on the last 1–2 days of a customer's period. Pure arithmetic — no Claude call.
// For AB ID: Missed/Maintenance/Growth brackets + 3-month loyalty top-up.
// For Display Wall: bracket system implemented in DW step (stub writes zeros for now).
async function checkPeriodEndBonus(customerId, salesDate) {
  const today = salesDate ?? _nowFn();

  const snap = await db.collection('customers').doc(customerId).get();
  if (!snap.exists) return { skipped: true, reason: 'customer not found' };

  const profile   = snap.data().profile ?? {};
  const isDW      = isDisplayWallCustomer(profile);
  const periodKey = getPeriodKey(today, isDW);
  const { start: periodStart, end: periodEnd } = getPeriodBounds(today, isDW);

  // Idempotent: skip if bonus already recorded for this period
  const bonusSnap = await db.collection('customers').doc(customerId)
    .collection('period_bonuses').doc(periodKey).get();
  if (bonusSnap.exists) {
    console.log(`[reward] checkPeriodEndBonus ${customerId} | ${periodKey} | already paid, skipping`);
    return { skipped: true, reason: 'bonus already paid', periodKey };
  }

  // ── Display Wall bracket system ───────────────────────────────────────────────
  // Under 110% (or 108% onboarding) → 1% only.
  // ≥ threshold, product not confirmed → 2.5% total.
  // ≥ threshold, product confirmed     → 3% total (absolute ceiling).
  // No loyalty top-up for DW. No consecutive_months tracking for DW.
  if (isDW) {
    const dwTargetSnap = await db.collection('customers').doc(customerId)
      .collection('period_targets').doc(periodKey).get();
    if (!dwTargetSnap.exists) {
      console.log(`[reward] checkPeriodEndBonus ${customerId} | ${periodKey} | DW: no target set, skipping`);
      return { skipped: true, reason: 'no period target set', periodKey };
    }

    const dwTarget       = dwTargetSnap.data();
    const dwGrowthThresh = dwTarget.growth_threshold ?? 0;
    const productDone    = dwTarget.product_completed ?? false;
    const isNewAccount   = dwTarget.new_account ?? false;

    const dwLinkedIds    = profile.linked_ids ?? [];
    const dwStoreCode    = await _getRcmStoreCode();
    const dwExcludeIds   = dwStoreCode ? new Set([String(dwStoreCode)]) : null;
    const dwRawSales     = await fetchPeriodSales(customerId, periodStart, periodEnd, dwExcludeIds);
    const dwReturns      = await fetchPeriodReturns(customerId, dwLinkedIds, periodStart, periodEnd);
    const dwGenuineSales = Math.max(0, dwRawSales - dwReturns);

    let dwBracket   = 'missed';
    let dwBonusRs   = 0;
    let dwReasoning = '';

    if (dwGenuineSales < dwGrowthThresh) {
      dwBracket   = 'missed';
      dwBonusRs   = 0;
      dwReasoning = `DW Missed: Rs ${dwGenuineSales} < Rs ${dwGrowthThresh} (${isNewAccount ? '108% onboarding' : '110%'} threshold), 1% only`;
    } else if (productDone) {
      dwBracket   = 'growth_with_product';
      dwBonusRs   = Math.floor(dwGenuineSales * 0.02);   // +2% → 3% total with L1
      dwReasoning = `DW Growth+Product: Rs ${dwGenuineSales} ≥ Rs ${dwGrowthThresh}, recommended product confirmed, +2%`;
    } else {
      dwBracket   = 'growth';
      dwBonusRs   = Math.floor(dwGenuineSales * 0.015);  // +1.5% → 2.5% total with L1
      dwReasoning = `DW Growth: Rs ${dwGenuineSales} ≥ Rs ${dwGrowthThresh}, product not confirmed, +1.5%`;
    }

    // 3% absolute ceiling (shared with AB ID: L1 est + bonus ≤ 3%)
    const dwL1Est  = Math.floor(dwGenuineSales * 0.01);
    const dwAbs3   = Math.floor(dwGenuineSales * 0.03);
    let   dwCapped = false;
    if (dwL1Est + dwBonusRs > dwAbs3) {
      dwBonusRs = Math.max(0, dwAbs3 - dwL1Est);
      dwCapped  = true;
      console.warn(`[reward] C5/C6 CEILING: ${customerId} | ${periodKey} | DW bonus capped to Rs ${dwBonusRs}`);
    }

    const dwIdUsed     = (profile.linked_ids ?? [])[0] ?? customerId;
    const dwBillRef    = `BONUS-${periodKey}`;
    let   dwBonusResult = { applied: false, amount: 0 };

    if (dwBonusRs > 0) {
      const lr = await applyCredit(
        customerId, dwIdUsed, dwBonusRs,
        dwBracket === 'growth_with_product' ? 'DW growth+product bonus (period end)' : 'DW growth bonus (period end)',
        dwBillRef
      );
      dwBonusResult = { applied: true, amount: dwBonusRs, ledgerResult: lr };
    }

    await db.collection('customers').doc(customerId)
      .collection('period_bonuses').doc(periodKey)
      .set({
        period_key:        periodKey,
        bracket:           dwBracket,
        bonus_rs:          dwBonusRs,
        loyalty_topup_rs:  0,
        layer2_rs:         dwBonusRs,
        layer3_rs:         0,
        capped:            dwCapped,
        genuine_sales:     dwGenuineSales,
        product_completed: productDone,
        applied_at:        admin.firestore.FieldValue.serverTimestamp(),
        reasoning:         dwReasoning,
      });

    console.log(
      `[reward] checkPeriodEndBonus ${customerId} | ${periodKey} | ` +
      `DW bracket=${dwBracket}  bonus=Rs ${dwBonusRs}${dwCapped ? '  [CAPPED]' : ''} | ${dwReasoning}`
    );
    return {
      periodKey,
      bracket:  dwBracket,
      bonus:    dwBonusResult,
      loyalty:  { applied: false, amount: 0 },
      capped:   dwCapped,
      genuineSales: dwGenuineSales,
      targetAmount: dwGrowthThresh,
      skipped:  false,
    };
  }

  // ── AB ID path ────────────────────────────────────────────────────────────────

  // Must have a target set for this period
  const targetSnap = await db.collection('customers').doc(customerId)
    .collection('period_targets').doc(periodKey).get();
  if (!targetSnap.exists) {
    console.log(`[reward] checkPeriodEndBonus ${customerId} | ${periodKey} | no target set, skipping`);
    return { skipped: true, reason: 'no period target set', periodKey };
  }

  const targetData     = targetSnap.data();
  const isColdStart    = targetData.cold_start ?? false;
  const coldStartMonth = targetData.cold_start_month ?? null;

  // Genuine sales = raw purchases − returns in period (ST Rupees store-code bills excluded)
  const linkedIds    = profile.linked_ids ?? [];
  const abStoreCode  = await _getRcmStoreCode();
  const abExcludeIds = abStoreCode ? new Set([String(abStoreCode)]) : null;
  const rawSales     = await fetchPeriodSales(customerId, periodStart, periodEnd, abExcludeIds);
  const returns      = await fetchPeriodReturns(customerId, linkedIds, periodStart, periodEnd);
  const genuineSales = Math.max(0, rawSales - returns);

  // ── Bracket determination ─────────────────────────────────────────────────────
  let bracket   = 'missed';
  let bonusRs   = 0;
  let reasoning = '';

  if (isColdStart && coldStartMonth === 1) {
    // Month 1: 1% base only, no additional bonus regardless of spend
    bracket   = 'missed';
    bonusRs   = 0;
    reasoning = 'Cold-start month 1: 1% only, no bonus';

  } else if (isColdStart) {
    // Cold-start months 2 & 3: binary hit/miss against the stored ramp target
    const coldTarget = targetData.target_amount ?? 0;
    if (genuineSales >= coldTarget) {
      bracket   = 'maintenance';
      bonusRs   = Math.floor(genuineSales * 0.005);  // +0.5% → 1.5% total with L1
      reasoning = `Cold-start M${coldStartMonth}: Rs ${genuineSales} ≥ target Rs ${coldTarget}, Maintenance +0.5%`;
    } else {
      bracket   = 'missed';
      bonusRs   = 0;
      reasoning = `Cold-start M${coldStartMonth}: Rs ${genuineSales} < target Rs ${coldTarget}, 1% only`;
    }

  } else {
    // Full 3-bracket system against rolling average
    const rollingAvg      = targetData.rolling_average ?? 0;
    const missedThreshold = targetData.missed_threshold ?? Math.round(rollingAvg * 0.90);
    const growthThreshold = targetData.growth_threshold ?? Math.round(rollingAvg * 1.05);

    if (genuineSales < missedThreshold) {
      bracket   = 'missed';
      bonusRs   = 0;
      reasoning = `Missed: Rs ${genuineSales} < Rs ${missedThreshold} (90% of avg Rs ${rollingAvg}), 1% only`;

    } else if (genuineSales < growthThreshold) {
      bracket   = 'maintenance';
      bonusRs   = Math.floor(genuineSales * 0.005);  // +0.5% → 1.5% total
      reasoning = `Maintenance: Rs ${genuineSales} in [Rs ${missedThreshold}, Rs ${growthThreshold}), +0.5%`;

    } else {
      bracket   = 'growth';
      bonusRs   = Math.floor(genuineSales * 0.015);  // +1.5% → 2.5% total
      reasoning = `Growth: Rs ${genuineSales} ≥ Rs ${growthThreshold} (105% of avg Rs ${rollingAvg}), +1.5%`;
    }
  }

  // ── Loyalty top-up: +0.5% on combined 3-month total, paid at every 3rd consecutive month ──
  const prevConsecutive = profile.consecutive_months ?? 0;
  const newConsecutive  = bracket === 'missed' ? 0 : prevConsecutive + 1;
  let loyaltyTopupRs    = 0;

  if (bracket !== 'missed' && newConsecutive % 3 === 0) {
    // Fetch last 2 completed periods to compute the 3-month combined total
    const hist       = await fetchPurchaseHistory(customerId, isDW, 6);
    const prev2      = hist.filter(h => h.period < periodKey).slice(-2);
    const prev2Total = prev2.reduce((s, h) => s + h.total, 0);
    const combined3  = rawSales + prev2Total;
    loyaltyTopupRs   = Math.floor(combined3 * 0.005);
    reasoning += `; loyalty top-up: 0.5% of Rs ${combined3} (3-mo combined) = Rs ${loyaltyTopupRs}`;
  }

  // ── Absolute 3% ceiling: L1(est 1%) + bonus + loyalty_topup ≤ 3% of genuine sales ──
  const totalBonus = bonusRs + loyaltyTopupRs;
  const l1Estimate = Math.floor(genuineSales * 0.01);
  const abs3pct    = Math.floor(genuineSales * 0.03);
  let   capped     = false;

  if (l1Estimate + totalBonus > abs3pct) {
    const allowed = Math.max(0, abs3pct - l1Estimate);
    if (totalBonus > 0) {
      bonusRs        = Math.floor(bonusRs        * allowed / totalBonus);
      loyaltyTopupRs = Math.floor(loyaltyTopupRs * allowed / totalBonus);
    }
    capped = true;
    console.warn(
      `[reward] C5/C6 CEILING: ${customerId} | ${periodKey} | ` +
      `L1=Rs ${l1Estimate} + bonus=Rs ${bonusRs} + loyalty=Rs ${loyaltyTopupRs} → capped to Rs ${allowed} over L1`
    );
  }

  // ── Apply credits via ledger-writer ───────────────────────────────────────────
  const idUsed           = linkedIds[0] ?? customerId;
  const syntheticBillRef = `BONUS-${periodKey}`;
  let bonusResult   = { applied: false, amount: 0 };
  let loyaltyResult = { applied: false, amount: 0 };

  if (bonusRs > 0) {
    const lr = await applyCredit(
      customerId, idUsed, bonusRs,
      bracket === 'growth' ? 'growth bonus (period end)' : 'maintenance bonus (period end)',
      syntheticBillRef
    );
    bonusResult = { applied: true, amount: bonusRs, ledgerResult: lr };
  }
  if (loyaltyTopupRs > 0) {
    const lr = await applyCredit(
      customerId, idUsed, loyaltyTopupRs,
      'loyalty top-up (3-month streak)', syntheticBillRef
    );
    loyaltyResult = { applied: true, amount: loyaltyTopupRs, ledgerResult: lr };
  }

  // ── Update profile.consecutive_months ────────────────────────────────────────
  await db.collection('customers').doc(customerId).set(
    { profile: { consecutive_months: newConsecutive } },
    { merge: true }
  );

  // ── Write bonus record (idempotency guard for future runs) ────────────────────
  await db.collection('customers').doc(customerId)
    .collection('period_bonuses').doc(periodKey)
    .set({
      period_key:               periodKey,
      bracket,
      bonus_rs:                 bonusRs,
      loyalty_topup_rs:         loyaltyTopupRs,
      layer2_rs:                bonusRs,          // backward-compat alias
      layer3_rs:                loyaltyTopupRs,   // backward-compat alias
      capped,
      genuine_sales:            genuineSales,
      consecutive_months_after: newConsecutive,
      applied_at:               admin.firestore.FieldValue.serverTimestamp(),
      reasoning,
    });

  console.log(
    `[reward] checkPeriodEndBonus ${customerId} | ${periodKey} | ` +
    `bracket=${bracket}  bonus=Rs ${bonusRs}  loyalty=Rs ${loyaltyTopupRs}  ` +
    `cons=${newConsecutive}${capped ? '  [CAPPED]' : ''} | ${reasoning}`
  );
  return {
    periodKey,
    bracket,
    bonus:   bonusResult,
    loyalty: loyaltyResult,
    capped,
    genuineSales,
    targetAmount: targetData.target_amount ?? 0,
    skipped: false,
  };
}

// ── Nightly orchestration ─────────────────────────────────────────────────────
// Called from run-nightly.js.
// processedMobiles: Map<mobile, totalAmountToday>  (from ingestTransactions)
// salesDate: the date of the night's scraped sales (yesterday from cron's perspective)
async function runNightlyRewardChecks(processedMobiles, salesDate) {
  const today = salesDate ?? _nowFn();

  // Date-gated checks — run for ALL customers
  const customersSnap = await db.collection('customers').get();
  for (const doc of customersSnap.docs) {
    const mobile  = doc.id;
    const profile = doc.data()?.profile ?? {};
    const isDW    = isDisplayWallCustomer(profile);

    const dayOfPeriod = getDayOfPeriod(today, isDW);
    const daysLeft    = daysUntilPeriodEnd(today, isDW);

    if (dayOfPeriod >= 1 && dayOfPeriod <= 5) {
      await setPeriodTarget(mobile, today).catch(e =>
        console.error(`[reward] setPeriodTarget ${mobile}: ${e.message}`)
      );
    }
    if (daysLeft <= 1) {
      await checkPeriodEndBonus(mobile, today).catch(e =>
        console.error(`[reward] checkPeriodEndBonus ${mobile}: ${e.message}`)
      );
    }
  }

  // Transaction-gated check — only for tonight's batch
  const briefings = [];
  for (const [mobile, totalAmount] of processedMobiles) {
    const result = await decideDailyMessage(mobile, totalAmount, today).catch(e => {
      console.error(`[reward] decideDailyMessage ${mobile}: ${e.message}`);
      return { skipped: true };
    });
    if (result && !result.skipped && result.briefing) {
      briefings.push({
        mobile,
        ...result.briefing,
        progressPct: result.progressPct,
        daysLeft:    result.daysLeft,
        isNearEnd:   result.isNearEnd,
      });
    }
  }
  return { briefings };
}

module.exports = {
  setPeriodTarget,
  decideDailyMessage,
  checkPeriodEndBonus,
  runNightlyRewardChecks,
  _setNow,
};
