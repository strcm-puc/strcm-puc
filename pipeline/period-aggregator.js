'use strict';

// ── Gemini period-end aggregation pass ─────────────────────────────────────────
// Called from checkPeriodEndBonus (reward-calculator.js) — the actual deterministic
// bonus-bracket function. NOTE: this is NOT a Sonnet/Claude call site — Sonnet only
// ever runs inside decideDailyMessage (the daily-message decision), a separate,
// unrelated function. checkPeriodEndBonus has never called any AI; this module
// inserts Gemini into that pipeline as a write-the-summary step only.
//
// rawSales/returns/genuineSales are computed deterministically by the caller
// (checkPeriodEndBonus, reusing its existing fetchPeriodSales/fetchPeriodReturns
// logic, completely unchanged) and handed in here already finished. Gemini is
// never asked to compute them — only to narrate them into ai_notes (same "do NOT
// recompute any numbers" pattern already used in message-writer.js's prompt).
// The bracket/percentage math downstream reads the returned genuineSales value,
// which is the exact same deterministic figure that was written to ai_notes —
// Gemini cannot alter it, it only writes the narrative sentence alongside it.

const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { admin } = require('../firebase-config');
const { aiNotesCol, fiscalPeriodKey } = require('./customer-schema');

const GEMINI_MODEL = 'gemini-2.5-flash-lite';

process.env.GOOGLE_APPLICATION_CREDENTIALS ??=
  path.join(__dirname, '..', 'secrets', 'firebase-service-account.json');

let _ai;
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

async function aggregatePeriodSummary(mobile, idUsed, periodStart, isDW, rawSales, returns, genuineSales) {
  const prompt = [
    'Write a one-sentence plain-English summary of this customer\'s period activity.',
    'Return ONLY a JSON object — no markdown, no text outside the braces.',
    'Do NOT recompute any numbers — use exactly the figures given below.',
    '',
    `Raw sales this period   : Rs ${rawSales}`,
    `Returns this period     : Rs ${returns}`,
    `Genuine sales (raw - returns): Rs ${genuineSales}`,
    '',
    'Return: {"summary":"<one sentence>"}',
  ].join('\n');

  let summary = '';
  try {
    const response = await _getAi().models.generateContent({
      model:    GEMINI_MODEL,
      contents: prompt,
      config:   { responseMimeType: 'application/json' },
    });
    const text  = response.text ?? '{}';
    const match = text.match(/\{[\s\S]*\}/);
    summary = JSON.parse(match?.[0] ?? '{}').summary ?? '';
  } catch (e) {
    console.warn(`[aggregator] Gemini summary failed for ${mobile}/${idUsed}: ${e.message}`);
  }

  const periodKey = fiscalPeriodKey(periodStart, isDW);
  const noteRef = await aiNotesCol(mobile, idUsed, periodKey).add({
    total_purchase_amount: genuineSales,
    raw_sales:              rawSales,
    returns,
    summary,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { genuineSales, rawSales, returns, summary, noteId: noteRef.id };
}

module.exports = { aggregatePeriodSummary };
