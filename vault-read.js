const { db } = require('./firebase-config');
const { COLLECTION } = require('./config/credentials-schema');
const { decryptPayload } = require('./config/vault-crypto');

async function getCredential(category) {
  if (!category || typeof category !== 'string') {
    throw new Error('category must be a non-empty string');
  }

  const docRef = db.collection(COLLECTION).doc(category);
  const snapshot = await docRef.get();

  if (!snapshot.exists) {
    throw new Error(`Credential not found: ${category}`);
  }

  const record = snapshot.data();

  if (!record.encrypted) {
    throw new Error(`Credential document is missing encrypted payload: ${category}`);
  }

  return decryptPayload(record.encrypted);
}

module.exports = { getCredential };
