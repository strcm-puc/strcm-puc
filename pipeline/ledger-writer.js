const { db, admin } = require('../firebase-config');

async function applyCredit(mobile, id_used, amount, reason, bill_number) {
  const debtRef    = db.collection('customers').doc(mobile).collection('debts').doc(id_used);
  const ledgerRef  = db.collection('customers').doc(mobile).collection('st_rupees_ledger').doc(id_used);
  const entriesRef = ledgerRef.collection('entries');

  return db.runTransaction(async (txn) => {
    const [debtSnap, ledgerSnap] = await Promise.all([txn.get(debtRef), txn.get(ledgerRef)]);

    const debt           = debtSnap.exists   ? (debtSnap.data().amount          ?? 0) : 0;
    const currentBalance = ledgerSnap.exists ? (ledgerSnap.data().current_balance ?? 0) : 0;

    const now = admin.firestore.FieldValue.serverTimestamp();
    let remaining = amount;
    let newDebt   = debt;

    if (debt > 0) {
      const repayment = Math.min(remaining, debt);
      newDebt   = debt - repayment;
      remaining = remaining - repayment;

      txn.set(entriesRef.doc(), {
        type: 'credit',
        reason: 'debt repayment',
        amount: repayment,
        bill_number,
        timestamp: now,
      });
    }

    let newBalance = currentBalance;

    if (remaining > 0) {
      newBalance = currentBalance + remaining;
      txn.set(entriesRef.doc(), {
        type: 'credit',
        reason,
        amount: remaining,
        bill_number,
        timestamp: now,
      });
    }

    // Safety guard — balance must never go negative
    if (newBalance < 0) newBalance = 0;

    txn.set(debtRef,   { amount: newDebt });
    txn.set(ledgerRef, { current_balance: newBalance }, { merge: true });

    return {
      newBalance,
      newDebt,
      totalApplied: amount,
      debtRepaid: amount - remaining,
      credited: remaining,
    };
  });
}

async function applyDebit(mobile, id_used, amount, reason, bill_number) {
  const debtRef    = db.collection('customers').doc(mobile).collection('debts').doc(id_used);
  const ledgerRef  = db.collection('customers').doc(mobile).collection('st_rupees_ledger').doc(id_used);
  const entriesRef = ledgerRef.collection('entries');

  return db.runTransaction(async (txn) => {
    const [debtSnap, ledgerSnap] = await Promise.all([txn.get(debtRef), txn.get(ledgerRef)]);

    const currentDebt    = debtSnap.exists   ? (debtSnap.data().amount          ?? 0) : 0;
    const currentBalance = ledgerSnap.exists ? (ledgerSnap.data().current_balance ?? 0) : 0;

    const now = admin.firestore.FieldValue.serverTimestamp();

    let actualDebit, newBalance, additionalDebt;

    if (currentBalance >= amount) {
      actualDebit    = amount;
      newBalance     = currentBalance - amount;
      additionalDebt = 0;
    } else {
      actualDebit    = currentBalance;
      newBalance     = 0;
      additionalDebt = amount - currentBalance;
    }

    if (actualDebit > 0) {
      txn.set(entriesRef.doc(), {
        type: 'debit',
        reason,
        amount: actualDebit,
        bill_number,
        timestamp: now,
      });
    }

    txn.set(ledgerRef, { current_balance: newBalance }, { merge: true });

    if (additionalDebt > 0) {
      txn.set(debtRef, { amount: currentDebt + additionalDebt });
    }

    return {
      newBalance,
      actualDebit,
      additionalDebt,
      requested: amount,
    };
  });
}

module.exports = { applyCredit, applyDebit };
