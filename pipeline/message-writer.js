'use strict';

const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { db, admin } = require('../firebase-config');
const { getApprovedTemplates } = require('./template-cache');

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

// ── Message history helpers ────────────────────────────────────────────────────

async function _getMessageCount(mobile) {
  const snap = await db.collection('customers').doc(mobile)
    .collection('message_history').get();
  return snap.docs.length;
}

async function _getRecentOpeners(mobile, n = 5) {
  const snap = await db.collection('customers').doc(mobile)
    .collection('message_history').get();
  return snap.docs
    .sort((a, b) => {
      const ta = a.data().sent_at ?? '';
      const tb = b.data().sent_at ?? '';
      return tb > ta ? 1 : -1;
    })
    .slice(0, n)
    .map(d => d.data().opener ?? '')
    .filter(Boolean);
}

// ── Template placeholder counting ─────────────────────────────────────────────
// Counted deterministically in code rather than left for Gemini to count itself —
// asking the model to both count {{n}} occurrences AND extract values in one pass
// is where it previously under/over-reported the variable count.
function _countPlaceholders(text) {
  return new Set((text ?? '').match(/\{\{\d+\}\}/g) ?? []).size;
}

// ── Magic token ────────────────────────────────────────────────────────────────

function _generateMagicToken() {
  const a = Math.random().toString(36).slice(2);
  const b = Math.random().toString(36).slice(2);
  return (a + b).slice(0, 12);
}

// ── Core writeMessage ─────────────────────────────────────────────────────────
// briefingObject comes from decideDailyMessage in reward-calculator.js.
// Required field: mobile.
// Optional fields: customer_name, gender, tone_needed, what_happened,
//   show_rupee_amount, st_account_link, do_not_mention, isNearEnd.

async function writeMessage(briefingObject) {
  const mobile = briefingObject?.mobile;
  if (!mobile) throw new Error('briefingObject.mobile is required');

  // Unsubscribed check — skip silently, caller handles
  const customerSnap = await db.collection('customers').doc(mobile).get();
  const profile = customerSnap.data()?.profile ?? {};
  if (profile.unsubscribed === true) {
    console.log(`[writer] ${mobile} is unsubscribed — skipping message queue`);
    return { skipped: true, reason: 'unsubscribed' };
  }

  // Fetch approved templates (cached)
  const templates = await getApprovedTemplates();
  if (!templates || templates.length === 0) {
    throw new Error('No approved WhatsApp templates available — cannot write message');
  }

  // Message history context
  const messageCount   = await _getMessageCount(mobile);
  const recentOpeners  = await _getRecentOpeners(mobile, 5);

  // Magic token — generated here, stored to profile + included in message if needed
  const magicCode  = _generateMagicToken();
  const magicToken = `strcm.vercel.app/d/${magicCode}`;

  // Template summary for Gemini — full body text, untruncated (a truncated body
  // hides trailing {{n}} placeholders), plus the EXACT required variable counts,
  // computed deterministically here rather than left for Gemini to count itself.
  const templateSummary = templates.map(t => {
    const body       = t.components?.find(c => c.type === 'BODY')?.text ?? '';
    const header     = t.components?.find(c => c.type === 'HEADER')?.text ?? '';
    const bodyCount   = _countPlaceholders(body);
    const headerCount = _countPlaceholders(header);
    return `  - name: "${t.name}" | lang: ${t.language} | body: "${body}" | ` +
      `body_variables_required: ${bodyCount} | header_variables_required: ${headerCount}`;
  }).join('\n');

  const showRupee     = briefingObject.show_rupee_amount === true;
  const showLink      = briefingObject.st_account_link  === true;
  const isNearEnd     = briefingObject.isNearEnd        === true;
  const toneNeeded    = briefingObject.tone_needed      ?? 'warm';
  const whatHappened  = briefingObject.what_happened    ?? 'regular check-in';
  const customerName  = briefingObject.customer_name    ?? profile.name ?? 'Customer';
  const gender        = briefingObject.gender           ?? profile.gender ?? 'unknown';
  const doNotMention  = (briefingObject.do_not_mention ?? []).join(', ') || 'nothing';

  const includeStopFooter = messageCount < 10;

  const prompt = [
    'You are the ST-APEX WhatsApp message writer for RCM India customers.',
    'Follow ALL 25 Writing Laws below — each one is non-negotiable.',
    '',
    '═══ 25 WRITING LAWS ═══',
    'L1.  Language: Devanagari Hindi with Urdu soul. Warm, respectful, literary.',
    'L2.  FIRST LINE: Always exactly "जय RCM!" — no variation, no punctuation changes.',
    `L3.  STOP footer: "${includeStopFooter ? 'INCLUDE' : 'OMIT'}" — message count for this customer is ${messageCount}. Only include in first 10 messages.`,
    `L4.  Rupee amounts: ${showRupee ? 'MAY be shown (briefing says true)' : 'NEVER show any amount (briefing says false)'}.`,
    `L5.  Dashboard link: ${showLink ? `Include as exactly "आपका ST account link: ${magicToken}" — never say "Magic Token"` : 'Do NOT include any link'}.`,
    'L6.  BANNED WORDS — never use in any language: target/टार्गेट, inactive/निष्क्रिय, loss/नुकसान, missing/गायब, gift/गिफ्ट.',
    'L7.  One personal detail: include exactly one — name, tier, streak count, or what happened.',
    `L8.  Unique opener: never open (after जय RCM!) with any of these recent openers: [${recentOpeners.join(' | ') || 'none yet'}].`,
    'L9.  No urgency: never use — जल्दी/hurry, आखिरी मौका/last chance, deadline, limited time, मत चूको/don\'t miss.',
    `L10. ${isNearEnd ? 'Last 5 days of period: extra warmth, zero pressure. Be encouraging, not pushy.' : 'Regular period day — balanced and warm.'}`,
    'L11. Address the customer by name at least once.',
    'L12. Tone must match the briefing tone exactly.',
    'L13. Keep message concise — fit within template body character limits.',
    'L14. Hindi must be grammatically correct Devanagari, not transliteration.',
    'L15. Gender-appropriate address: M → आप / भाई, F → आप / बहन, unknown → आप.',
    'L16. Avoid repeating the same message structure from recent messages.',
    'L17. RCM brand name may appear as "RCM" or "आरसीएम" — never a third form.',
    'L18. Never promise specific bonus amounts unless show_rupee_amount is true.',
    'L19. Focus on the customer\'s journey and progress, not on what they need to do.',
    'L20. The closing should feel complete — never end mid-thought.',
    'L21. Never translate English loanwords that sound unnatural in Hindi.',
    'L22. Compound variables ({{1}} {{2}}): keep each one self-contained.',
    'L23. No more than one emoji in the entire message, and only if culturally appropriate.',
    'L24. Never address the customer as "user", "member", or any generic term.',
    'L25. Review all laws before finalising — violations are not acceptable.',
    '',
    '═══ CUSTOMER BRIEFING ═══',
    `  Mobile:          ${mobile}`,
    `  Name:            ${customerName}`,
    `  Gender:          ${gender}`,
    `  Tone needed:     ${toneNeeded}`,
    `  What happened:   ${whatHappened}`,
    `  Do not mention:  ${doNotMention}`,
    '',
    '═══ APPROVED TEMPLATES ═══',
    templateSummary,
    '',
    '═══ INSTRUCTIONS ═══',
    '1. Select the single best-fitting approved template from the list above.',
    '2. Write the complete message body in Devanagari Hindi following all 25 laws.',
    '3. body_variables and header_variables MUST contain EXACTLY body_variables_required and ' +
      'header_variables_required values for the template you selected — no more, no fewer. ' +
      'These counts are given to you already computed; do not count {{n}} yourself and do not ' +
      'include any value that is not one of the template\'s own {{n}} placeholders (e.g. never put ' +
      '"nothing" or any do-not-mention filler value into body_variables). If a count is 0, return an empty array.',
    '4. Return opener = first meaningful phrase after "जय RCM!" (4-6 words) — used for Law L8.',
    '',
    'Return ONLY a valid JSON object — no markdown, no text outside the braces:',
    '{"template_name":"<name>","template_language":"<hi or en or whatever the template uses>","body_variables":["<val1>","<val2>"],"header_variables":[],"message_preview":"<full Devanagari text with जय RCM! first>","opener":"<4-6 word opener phrase after जय RCM>"}',
  ].join('\n');

  const geminiResult = await _callGemini(prompt);

  if (!geminiResult.template_name) {
    throw new Error(`Gemini did not return a template_name. Raw: ${JSON.stringify(geminiResult).slice(0, 200)}`);
  }

  // Fail fast on a variable-count mismatch — Meta only reports this as an opaque
  // "(#132000) Number of parameters does not match" after the live send is
  // attempted; catching it here avoids a wasted Meta API call on a response
  // Gemini didn't extract correctly.
  const selectedTemplate = templates.find(t =>
    t.name === geminiResult.template_name &&
    t.language === (geminiResult.template_language ?? 'hi')
  ) ?? templates.find(t => t.name === geminiResult.template_name);

  if (selectedTemplate) {
    const bodyText   = selectedTemplate.components?.find(c => c.type === 'BODY')?.text ?? '';
    const headerText = selectedTemplate.components?.find(c => c.type === 'HEADER')?.text ?? '';
    const expectedBody   = _countPlaceholders(bodyText);
    const expectedHeader = _countPlaceholders(headerText);
    const actualBody   = (geminiResult.body_variables ?? []).length;
    const actualHeader = (geminiResult.header_variables ?? []).length;

    if (actualBody !== expectedBody || actualHeader !== expectedHeader) {
      throw new Error(
        `Gemini template variable mismatch for "${geminiResult.template_name}": ` +
        `body expects ${expectedBody}, got ${actualBody}; header expects ${expectedHeader}, got ${actualHeader}. ` +
        `body_variables: ${JSON.stringify(geminiResult.body_variables)}`
      );
    }
  }

  // Persist magic token to customer profile
  await db.collection('customers').doc(mobile).set({
    profile: { magic_token: magicToken },
  }, { merge: true });

  // Write to send_queue
  const queueRef = await db.collection('send_queue').add({
    mobile,
    template_name:      geminiResult.template_name,
    template_language:  geminiResult.template_language ?? 'hi',
    body_variables:     geminiResult.body_variables    ?? [],
    header_variables:   geminiResult.header_variables  ?? [],
    message_preview:    geminiResult.message_preview   ?? '',
    opener:             geminiResult.opener            ?? '',
    magic_token:        magicToken,
    status:             'pending',
    created_at:         admin.firestore.FieldValue.serverTimestamp(),
    sent_at:            null,
    wamid:              null,
    error:              null,
    briefing:           briefingObject,
  });

  console.log(`[writer] Queued: mobile=${mobile} | template=${geminiResult.template_name} | queue_id=${queueRef.id}`);
  return {
    queueId:        queueRef.id,
    templateName:   geminiResult.template_name,
    messagePreview: geminiResult.message_preview,
    magicToken,
    skipped:        false,
  };
}

module.exports = { writeMessage };
