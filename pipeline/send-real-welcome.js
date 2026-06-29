'use strict';

// ── send-real-welcome.js ───────────────────────────────────────────────────────
// Usage: node pipeline/send-real-welcome.js <mobile_number>
//
// Sends a real (non-dry-run) onboarding WhatsApp message to one new customer.
// Flow: Firestore customer read → Gemini template → send_queue → Meta Cloud API
//
// ONLY run this for customers who have already been created via telegram-listener
// and whose linked_ids are confirmed correct. Never run for bulk sends.

const { db }                 = require('../firebase-config');
const { writeMessage }       = require('./message-writer');
const { sendPendingMessages } = require('./sender');

async function sendWelcome(mobile) {
  if (!mobile || !/^[6-9]\d{9}$/.test(mobile)) {
    console.error(`[send-real-welcome] Invalid mobile number: "${mobile}"`);
    console.error('Usage: node pipeline/send-real-welcome.js <10-digit-mobile>');
    process.exit(1);
  }

  // Read customer profile
  const snap = await db.collection('customers').doc(mobile).get();
  if (!snap.exists) {
    console.error(`[send-real-welcome] No customer found at customers/${mobile}`);
    process.exit(1);
  }
  const profile = snap.data().profile ?? {};

  if (profile.unsubscribed === true) {
    console.error(`[send-real-welcome] Customer ${mobile} is unsubscribed — aborting.`);
    process.exit(1);
  }

  console.log(`[send-real-welcome] Sending welcome to ${mobile} (${profile.name ?? 'unknown name'})`);

  // Build welcome briefing
  const briefing = {
    mobile,
    customer_name:      profile.name    ?? '',
    gender:             profile.gender  ?? 'unknown',
    tone_needed:        'warm_welcome',
    what_happened:      'new member onboarding — welcome to STRCM family',
    show_rupee_amount:  false,
    st_account_link:    true,
    do_not_mention:     [],
    isNearEnd:          false,
    _source:            'send-real-welcome',
  };

  // Step 1: Gemini → template → send_queue
  const written = await writeMessage(briefing);
  if (written.skipped) {
    console.log(`[send-real-welcome] Message skipped: ${written.reason}`);
    return;
  }
  console.log(`[send-real-welcome] Queued: queue_id=${written.queueId} | template=${written.templateName}`);
  console.log(`[send-real-welcome] Preview: "${written.messagePreview?.slice(0, 80)}..."`);
  console.log(`[send-real-welcome] Magic token: ${written.magicToken}`);

  // Step 2: Send from queue via Meta Cloud API (dryRun=false)
  const result = await sendPendingMessages({ dryRun: false });
  console.log(`[send-real-welcome] Send result: sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`);
}

if (require.main === module) {
  const mobile = (process.argv[2] ?? '').trim().replace(/^\+?91/, '');
  sendWelcome(mobile)
    .then(() => process.exit(0))
    .catch(e => { console.error('[send-real-welcome] FATAL:', e.message); process.exit(1); });
}

module.exports = { sendWelcome };
