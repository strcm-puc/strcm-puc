'use strict';

// ── 8 AM IST morning send job ─────────────────────────────────────────────────
// Cron: 30 2 * * *  (8:00 AM IST = 2:30 AM UTC)
// VM:   cd /home/ubuntu/strcm-puc && node pipeline/run-morning.js >> /home/ubuntu/logs/morning-send.log 2>&1

const { sendPendingMessages } = require('./sender');

async function runMorningSend() {
  const startTime = new Date().toISOString();
  console.log('========================================');
  console.log('ST-APEX Morning Send Job');
  console.log(`Started: ${startTime}`);
  console.log('========================================');

  const result = await sendPendingMessages();

  console.log('========================================');
  console.log(`Sent: ${result.sent}  Failed: ${result.failed}  Skipped: ${result.skipped}`);
  console.log(`Completed: ${new Date().toISOString()}`);
  console.log('========================================\n');

  return result;
}

if (require.main === module) {
  runMorningSend()
    .then(() => process.exit(0))
    .catch(e => { console.error('Morning send failed:', e.message); process.exit(1); });
}

module.exports = { runMorningSend };
