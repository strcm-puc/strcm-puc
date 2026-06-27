const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, 'secrets', 'firebase-service-account.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function testFirestoreConnection() {
  const docId = `test-${Date.now()}`;
  const testData = {
    message: 'ST-APEX system test - connection successful',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = db.collection('system_test').doc(docId);

  await docRef.set(testData);
  console.log('Write successful:', docId);

  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    throw new Error('Document was written but could not be read back');
  }

  const data = snapshot.data();
  console.log('Read successful:', data);

  return { docId, data };
}

module.exports = { admin, db, testFirestoreConnection };

if (require.main === module) {
  testFirestoreConnection()
    .then(() => {
      console.log('Firestore connection test passed.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Firestore connection test failed:', error.message);
      process.exit(1);
    });
}
