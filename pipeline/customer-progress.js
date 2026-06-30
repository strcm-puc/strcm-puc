'use strict';

const { db } = require('../firebase-config');
const { idRef, ledgerEntriesCol, fiscalPeriodKey } = require('./customer-schema');
const { isDisplayWallCustomer, getPeriodBounds, getPeriodKey } = require('./reward-calculator');

// ── Test hook: inject a fixed "today" so unit tests control the active period ──
let _nowFn = () => new Date();
function _setNow(fn) { _nowFn = fn; }

// Lifetime totals and current-period progress are both computed fresh from the
// permanent st_rupees_ledger entries log on every call — never a separate stored
// field. Lifetime = every entry ever logged across every period folder (the log
// is append-only and never reset). Current-period = just this period's folder —
// the new period folder naturally starts with zero entries until the first real
// purchase comes in; there is nothing to manually reset.
async function getCustomerProgress(mobile) {
  const custSnap = await db.collection('customers').doc(mobile).get();
  if (!custSnap.exists) return null;

  const profile   = custSnap.data().profile ?? {};
  const isDW      = isDisplayWallCustomer(profile);
  const linkedIds = (profile.linked_ids ?? []).filter(li => li.type === (isDW ? 'display_wall' : 'ab_id'));

  const today      = _nowFn();
  const periodKey  = getPeriodKey(today, isDW);
  const storageKey = fiscalPeriodKey(today, isDW);

  let lifetimeEarned = 0, lifetimeRedeemed = 0, currentBalance = 0;
  let periodEarned = 0, periodSpent = 0;

  for (const li of linkedIds) {
    const idDocSnap = await idRef(mobile, li.id).get();
    if (idDocSnap.exists) {
      currentBalance += Number(idDocSnap.data().current_balance ?? 0);
    }

    // Lifetime: every entry across every period folder for this id.
    const periodsSnap = await idRef(mobile, li.id).collection('periods').get();
    for (const periodDoc of periodsSnap.docs) {
      const entriesSnap = await periodDoc.ref.collection('st_rupees_ledger').doc('ledger').collection('entries').get();
      for (const e of entriesSnap.docs) {
        const amount = Number(e.data().amount ?? 0);
        if (e.data().type === 'credit') lifetimeEarned   += amount;
        if (e.data().type === 'debit')  lifetimeRedeemed += amount;
      }
    }

    // Current period: just this period's folder, no date filtering needed —
    // the folder boundary already is the period boundary.
    const periodEntriesSnap = await ledgerEntriesCol(mobile, li.id, storageKey).get();
    for (const e of periodEntriesSnap.docs) {
      const ed     = e.data();
      const amount = Number(ed.amount ?? 0);
      if (ed.type === 'credit') periodEarned += amount;
      if (ed.type === 'debit')  periodSpent  += amount;
    }
  }

  return {
    mobile,
    tier:           profile.tier ?? 'Saathi',   // tier is never touched by period reset
    isDisplayWall:  isDW,
    periodKey,
    lifetime: {
      earned:   lifetimeEarned,
      redeemed: lifetimeRedeemed,
      balance:  currentBalance,
    },
    currentPeriod: {
      earned: periodEarned,
      spent:  periodSpent,
    },
  };
}

module.exports = { getCustomerProgress, _setNow };
