const { db } = require('./firebase-config');
const { COLLECTION } = require('./config/credentials-schema');
const { ensureVaultKeyFile } = require('./config/vault-crypto');
const { saveCredential } = require('./vault-write');
const { getCredential } = require('./vault-read');

const TEST_CATEGORY = 'test_category';
const TEST_DATA = { note: 'vault test successful' };

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runVaultTest() {
  ensureVaultKeyFile();

  console.log('=== ST-APEX Credential Vault Test ===\n');

  try {
    console.log(`Writing test credential to ${COLLECTION}/${TEST_CATEGORY}...`);
    const writeResult = await saveCredential(TEST_CATEGORY, TEST_DATA, { validate: false });
    console.log(`Write OK: ${writeResult.path}`);

    console.log(`Reading back ${COLLECTION}/${TEST_CATEGORY}...`);
    const decrypted = await getCredential(TEST_CATEGORY);
    console.log('Read OK:', decrypted);

    const matches = deepEqual(decrypted, TEST_DATA);
    if (!matches) {
      console.log('\nRESULT: FAIL — decrypted data does not match written data');
      process.exit(1);
    }

    console.log(`\nDeleting test document ${COLLECTION}/${TEST_CATEGORY}...`);
    await db.collection(COLLECTION).doc(TEST_CATEGORY).delete();

    const deletedSnap = await db.collection(COLLECTION).doc(TEST_CATEGORY).get();
    if (deletedSnap.exists) {
      console.log('\nRESULT: FAIL — test document was not deleted');
      process.exit(1);
    }

    console.log('Cleanup OK: test document removed');
    console.log('\nRESULT: PASS — vault write, read, decrypt, and cleanup all succeeded');
    process.exit(0);
  } catch (error) {
    console.error('\nRESULT: FAIL —', error.message);
    process.exit(1);
  }
}

runVaultTest();
