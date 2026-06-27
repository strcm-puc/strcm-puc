const { admin, db } = require('./firebase-config');

const MOBILE = '9999999999';
const RCM_ID = 'RCM782104';

const customerRef = db.collection('customers').doc(MOBILE);

const malformedCustomerRef = db
  .collection('customers')
  .doc('T')
  .collection('customers')
  .doc(MOBILE);

const now = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

const customerDocument = {
  profile: {
    name: 'Test Customer',
    tier: 'Saathi',
    linked_ids: [RCM_ID],
    join_date: admin.firestore.Timestamp.fromDate(new Date('2025-11-15')),
    language: 'hi',
    whatsapp_verified: true,
    whatsapp_delivery_failed_count: 0,
    is_active: true,
  },
  st_rupees_ledger: {
    current_balance: 248,
    lifetime_earned: 512,
    lifetime_redeemed: 260,
    entries: [
      {
        date: '2026-06-10',
        time: '14:32',
        type: 'credit',
        amount: 42,
        reason: 'base_reward_1_percent',
        bill_number: 'BILL-2026-0610-8841',
        id_used: RCM_ID,
      },
      {
        date: '2026-05-28',
        time: '11:05',
        type: 'debit',
        amount: 150,
        reason: 'counter_redemption',
        bill_number: null,
        id_used: RCM_ID,
      },
      {
        date: '2026-05-15',
        time: '09:18',
        type: 'credit',
        amount: 85,
        reason: 'bonus_layer_target',
        bill_number: 'BILL-2026-0515-7720',
        id_used: RCM_ID,
      },
    ],
  },
  purchase_summary: [
    {
      date: '2026-06-10',
      bill_no: 'BILL-2026-0610-8841',
      products: [
        { name: 'RCM Nutrimore Powder', qty: 2, amount: 2100 },
        { name: 'RCM Dish Wash Gel', qty: 1, amount: 120 },
      ],
      amount: 2220,
      pv: 42,
      id_used: RCM_ID,
    },
    {
      date: '2026-05-15',
      bill_no: 'BILL-2026-0515-7720',
      products: [{ name: 'RCM Health Guard', qty: 1, amount: 8500 }],
      amount: 8500,
      pv: 85,
      id_used: RCM_ID,
    },
  ],
  message_history: [
    {
      date: admin.firestore.Timestamp.fromDate(new Date('2026-06-01')),
      type: 'new_month_welcome',
      sent_status: 'delivered',
      opened: true,
    },
    {
      date: admin.firestore.Timestamp.fromDate(new Date('2026-06-15')),
      type: 'target_progress',
      sent_status: 'delivered',
      opened: false,
    },
  ],
  targets: {
    current: {
      amount: 5000,
      type: 'monthly_stretch',
      period: 'monthly',
      start: admin.firestore.Timestamp.fromDate(monthStart),
      end: admin.firestore.Timestamp.fromDate(monthEnd),
      progress: 2220,
      progress_percent: 44.4,
      bonus_eligible: true,
      bonus_earned: 0,
    },
    history: [
      {
        amount: 4000,
        type: 'monthly_stretch',
        period: '2026-05',
        progress: 8500,
        outcome: 'achieved',
        bonus_earned: 85,
      },
    ],
  },
  ai_notes: {
    week_start: admin.firestore.Timestamp.fromDate(new Date('2026-06-21')),
    summary:
      'Test Customer is a steady Saathi-tier buyer, opens messages occasionally. ' +
      'Responded well to target reminders. No tier change expected this month. ' +
      'Primary AB ID RCM782104 — moderate PV, one redemption in May.',
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  },
};

async function deleteMalformedCustomer() {
  const idsSnapshot = await malformedCustomerRef.collection('ids').get();
  const batch = db.batch();

  idsSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(malformedCustomerRef);

  await batch.commit();

  const malformedSnap = await malformedCustomerRef.get();
  if (malformedSnap.exists) {
    throw new Error('Failed to delete malformed customer document');
  }

  console.log('Deleted malformed document at customers/T/customers/' + MOBILE);
}

async function setupSchema() {
  const firestorePath = `customers/${MOBILE}`;
  console.log('Cleaning up any malformed test document...');
  await deleteMalformedCustomer();

  console.log('Setting up Firestore schema for test customer...');
  console.log(`Firestore path: ${firestorePath}`);

  await customerRef.set(customerDocument, { merge: true });

  const snapshot = await customerRef.get();
  if (!snapshot.exists) {
    throw new Error('Customer document was written but could not be read back');
  }

  const data = snapshot.data();
  const sections = ['profile', 'st_rupees_ledger', 'purchase_summary', 'message_history', 'targets', 'ai_notes'];

  console.log('\n--- Customer document confirmed in Firestore ---');
  console.log(`Document path: ${snapshot.ref.path}`);
  console.log(`Mobile: ${MOBILE}`);
  console.log(`Name: ${data.profile.name}`);
  console.log(`Sections present: ${sections.filter((s) => data[s] != null).join(', ')}`);
  console.log('\nFull document:');
  console.log(JSON.stringify(data, null, 2));
  console.log('\nSchema setup complete.');
}

if (require.main === module) {
  setupSchema()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Schema setup failed:', error.message);
      process.exit(1);
    });
}

module.exports = { setupSchema, deleteMalformedCustomer, MOBILE, RCM_ID };
