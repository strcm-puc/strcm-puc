const readline = require('readline');
const { saveCredential } = require('./vault-write');

function prompt(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans.trim()); });
  });
}

async function run() {
  console.log('\n=== Update Telegram Bot Credentials ===');
  console.log('Bot token format: 1234567890:ABCdefGHIjklMNO... (~46 chars, no spaces)\n');
  const bot_token     = await prompt('Bot token      : ');
  const admin_chat_id = await prompt('Admin chat ID  : ');
  console.log(`\nToken length: ${bot_token.length} (expected ~46)`);
  if (bot_token.length < 20 || bot_token.length > 100) {
    console.error('ERROR: Token length looks wrong. A Telegram bot token is typically 42-50 characters.');
    process.exit(1);
  }
  if (!bot_token.includes(':')) {
    console.error('ERROR: Token should contain a colon (:) separating the bot ID from the secret.');
    process.exit(1);
  }
  await saveCredential('telegram_bot', { bot_token, admin_chat_id });
  console.log('✓ telegram_bot credential updated.\n');
  process.exit(0);
}

run().catch(e => { console.error('Failed:', e.message); process.exit(1); });
