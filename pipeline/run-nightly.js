'use strict';

// ── 12:05 AM IST nightly pipeline ────────────────────────────────────────────
// Cron: 35 18 * * *  (12:05 AM IST = 6:35 PM UTC previous day)
// VM:   cd /home/ubuntu/strcm-puc && node pipeline/run-nightly.js >> /home/ubuntu/logs/nightly.log 2>&1

const { scrapeWithRetry }        = require('./scraper');
const { ingestTransactions }     = require('./data-ingestion');
const { runNightlyRewardChecks } = require('./reward-calculator');
const { writeMessage }           = require('./message-writer');

async function runStep(stepName, fn) {
  console.log(`\n--- START: ${stepName} ---`);
  const result = await fn();
  console.log(`--- DONE: ${stepName} ---`);
  return result;
}

async function runNightly() {
  // salesDate = yesterday (the date whose transactions the scraper fetches)
  const salesDate = new Date();
  salesDate.setDate(salesDate.getDate() - 1);
  const runDateStr = salesDate.toISOString().slice(0, 10);

  console.log('========================================');
  console.log('ST-APEX Nightly Pipeline');
  console.log(`Sales date: ${runDateStr}`);
  console.log('========================================');

  // 1. Scrape yesterday's RCM transactions
  const scrapeResult = await runStep('scraper', () => scrapeWithRetry());

  // 2. Ingest — writes Layer 1 credits, returns processedMobiles Map<mobile, totalAmountToday>
  const { processedMobiles } = await runStep('data-ingestion', () =>
    ingestTransactions(scrapeResult.transactions)
  );

  // 3. Reward checks:
  //    - setPeriodTarget    → days 1-5 of new period (all customers)
  //    - checkPeriodEndBonus → last 1-2 days of period (all customers)
  //    - decideDailyMessage  → tonight's transaction batch only
  //    Returns: { briefings: [{mobile, ...briefingFields}] }
  const { briefings } = await runStep('reward-checks', () =>
    runNightlyRewardChecks(processedMobiles, salesDate)
  );

  // 4. Write messages to send_queue for each briefing
  //    Actual sending happens at 8 AM via run-morning.js
  let queued = 0;
  for (const briefing of (briefings ?? [])) {
    const result = await writeMessage(briefing).catch(e => {
      console.error(`[nightly] writeMessage ${briefing.mobile}: ${e.message}`);
      return null;
    });
    if (result && !result.skipped) queued++;
  }
  console.log(`\n--- Message queue: ${queued}/${(briefings ?? []).length} briefings queued ---`);

  console.log('\n========================================');
  console.log('Nightly pipeline complete');
  console.log(`Processed: ${processedMobiles.size} customers`);
  console.log(`Queued messages: ${queued}`);
  console.log('========================================\n');

  return { success: true, runDateStr, processedCount: processedMobiles.size, queuedMessages: queued };
}

if (require.main === module) {
  runNightly()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('\nNightly pipeline failed:', error.message);
      process.exit(1);
    });
}

module.exports = { runNightly };
