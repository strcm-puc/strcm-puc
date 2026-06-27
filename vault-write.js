const { db, admin } = require('./firebase-config');
const { COLLECTION, isValidCategory, validateCredentialShape } = require('./config/credentials-schema');
const { encryptPayload } = require('./config/vault-crypto');

async function saveCredential(category, data, { validate = true } = {}) {
  if (!category || typeof category !== 'string') {
    throw new Error('category must be a non-empty string');
  }

  if (validate && isValidCategory(category)) {
    validateCredentialShape(category, data);
  }

  const encrypted = encryptPayload(data);
  const docRef = db.collection(COLLECTION).doc(category);

  await docRef.set({
    category,
    encrypted,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { category, path: `${COLLECTION}/${category}` };
}

module.exports = { saveCredential };
