const readline = require('readline');
const { saveCredential } = require('./vault-write');

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptMasked(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      throw new Error('Masked input requires a real TTY. Run this script directly in a terminal.');
    }

    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';

    function onData(char) {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '') {
        process.stdout.write('\n');
        process.exit(0);
      } else if (char === '' || char === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += char;
        process.stdout.write('*');
      }
    }

    process.stdin.on('data', onData);
  });
}

async function run() {
  console.log('\n=== ST-APEX Credential Setup ===');
  console.log('All input is encrypted before writing to Firestore.\n');

  // ── RCM Login ──────────────────────────────────────────────
  console.log('[ RCM Portal — pos2.rcmworld.com ]');
  const rcm_username  = await prompt('  Mobile number : ');
  const rcm_password  = await promptMasked('  Password       : ');
  const rcm_store_code = await prompt('  Store code     : ');

  console.log('\nSaving rcm_login...');
  await saveCredential('rcm_login', {
    username:   rcm_username,
    password:   rcm_password,
    store_code: rcm_store_code,
  });
  console.log('  ✓ rcm_login saved');

  // ── Telegram Bot ───────────────────────────────────────────
  console.log('\n[ Telegram Bot ]');
  const bot_token     = await promptMasked('  Bot token      : ');
  const admin_chat_id = await prompt('  Admin chat ID  : ');

  console.log('\nSaving telegram_bot...');
  await saveCredential('telegram_bot', {
    bot_token,
    admin_chat_id,
  });
  console.log('  ✓ telegram_bot saved');

  console.log('\n=== All credentials vaulted successfully ===\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
