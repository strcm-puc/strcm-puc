const { scrapeRcmSales } = require('./scraper');
const { ingestSalesData } = require('./data-ingestion');
const { calculateRewards } = require('./reward-calculator');
const { decideMessageNeeded } = require('./message-decider');
const { writeMessage } = require('./message-writer');
const { sendWhatsappMessage } = require('./sender');

const DUMMY_CUSTOMER = {
  mobile: '9999999999',
  name: 'Test Customer',
  tier: 'Saathi',
};

async function runStep(stepName, fn) {
  console.log(`\n--- START: ${stepName} ---`);
  const result = await fn();
  console.log(`--- DONE: ${stepName} ---`, result);
  return result;
}

async function runNightly() {
  const runDate = new Date().toISOString().slice(0, 10);

  console.log('========================================');
  console.log('ST-APEX Nightly Pipeline (skeleton run)');
  console.log(`Run date: ${runDate}`);
  console.log('========================================');

  const scrapeResult = await runStep('scraper', () => scrapeRcmSales(runDate));
  const ingestResult = await runStep('data-ingestion', () =>
    ingestSalesData(scrapeResult),
  );

  const dummyCustomers = [DUMMY_CUSTOMER];
  const rewardResult = await runStep('reward-calculator', () =>
    calculateRewards(dummyCustomers),
  );

  const decideResult = await runStep('message-decider', () =>
    decideMessageNeeded(DUMMY_CUSTOMER),
  );

  const writeResult = await runStep('message-writer', () =>
    writeMessage(DUMMY_CUSTOMER, 'new_month_welcome', []),
  );

  const sendResult = await runStep('sender', () =>
    sendWhatsappMessage(DUMMY_CUSTOMER, writeResult.message),
  );

  console.log('\n========================================');
  console.log('Nightly pipeline skeleton run complete');
  console.log(
    'Steps executed: scraper -> data-ingestion -> reward-calculator -> message-decider -> message-writer -> sender',
  );
  console.log('========================================\n');

  return {
    success: true,
    runDate,
    scrapeResult,
    ingestResult,
    rewardResult,
    decideResult,
    writeResult,
    sendResult,
  };
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
