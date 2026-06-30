const { db, admin } = require('../firebase-config');
const { idRef, ledgerEntriesCol, idType, fiscalPeriodKey } = require('./customer-schema');

// current_balance/debt live on the id-level doc (customers/{mobile}/ids/{id}) —
// running totals that span every period, never reset. The entries log itself is
// period-scoped, filed under whichever period `date` falls into; date defaults to
// "now" for callers that don't have a specific transaction date.
async function applyCredit(mobile, id_used, amount, reason, bill_number, date = new Date()) {
  const idDoc      = idRef(mobile, id_used);
  const periodKey  = fiscalPeriodKey(date, idType(id_used) === 'display_wall');
  const entriesRef = ledgerEntriesCol(mobile, id_used, periodKey);

  return db.runTransaction(async (txn) => {
    const idSnap = await txn.get(idDoc);
    const data   = idSnap.exists ? idSnap.data() : {};

    const debt           = data.debt            ?? 0;
    const currentBalance = data.current_balance ?? 0;

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

    txn.set(idDoc, { current_balance: newBalance, debt: newDebt }, { merge: true });

    return {
      newBalance,
      newDebt,
      totalApplied: amount,
      debtRepaid: amount - remaining,
      credited: remaining,
    };
  });
}

async function applyDebit(mobile, id_used, amount, reason, bill_number, date = new Date()) {
  const idDoc      = idRef(mobile, id_used);
  const periodKey  = fiscalPeriodKey(date, idType(id_used) === 'display_wall');
  const entriesRef = ledgerEntriesCol(mobile, id_used, periodKey);

  return db.runTransaction(async (txn) => {
    const idSnap = await txn.get(idDoc);
    const data   = idSnap.exists ? idSnap.data() : {};

    const currentDebt    = data.debt            ?? 0;
    const currentBalance = data.current_balance ?? 0;

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

    const newDebt = currentDebt + additionalDebt;
    txn.set(idDoc, { current_balance: newBalance, debt: newDebt }, { merge: true });

    return {
      newBalance,
      actualDebit,
      additionalDebt,
      requested: amount,
    };
  });
}

module.exports = { applyCredit, applyDebit };
