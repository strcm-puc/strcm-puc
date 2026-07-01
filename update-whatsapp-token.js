const { getCredential } = require('./vault-read');
const { saveCredential } = require('./vault-write');

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
  console.log('\n=== Update WhatsApp API access_token ===');

  const current = await getCredential('whatsapp_api');

  const access_token = await promptMasked('New access_token: ');
  if (!access_token) {
    console.error('ERROR: access_token cannot be empty.');
    process.exit(1);
  }

  await saveCredential('whatsapp_api', {
    phone_number_id:     current.phone_number_id,
    waba_id_production:  current.waba_id_production,
    access_token,
  });

  console.log('✓ whatsapp_api.access_token updated. phone_number_id and waba_id_production left unchanged.\n');
  process.exit(0);
}

run().catch(e => { console.error('Failed:', e.message); process.exit(1); });
