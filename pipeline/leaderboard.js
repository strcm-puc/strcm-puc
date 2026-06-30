'use strict';

const { db } = require('../firebase-config');
const { idRef, purchasesCol, fiscalPeriodKey } = require('./customer-schema');
const { isDisplayWallCustomer, getPeriodBounds } = require('./reward-calculator');

// ── Test hook: inject a fixed "today" so unit tests control the DW quarter ────
let _nowFn = () => new Date();
function _setNow(fn) { _nowFn = fn; }

// Both leaderboards are computed fresh from customers/{mobile}/ids/{id}/periods/*
// on every call — no cached/stored leaderboard document, matching the rest of
// the dashboard.
async function getLeaderboards() {
  const today = _nowFn();
  const { start: qStart } = getPeriodBounds(today, true);
  const dwStorageKey = fiscalPeriodKey(qStart, true);

  const customersSnap = await db.collection('customers').get();

  const abEntries = [];
  const dwEntries = [];

  for (const doc of customersSnap.docs) {
    const mobile    = doc.id;
    const profile   = doc.data()?.profile ?? {};
    const linkedIds = profile.linked_ids ?? [];
    const name      = profile.name ?? mobile;
    const isDW      = isDisplayWallCustomer(profile);

    if (isDW) {
      // Current-quarter purchase amount only — sum across this customer's DW ids.
      let total = 0;
      for (const li of linkedIds.filter(li => li.type === 'display_wall')) {
        const snap = await purchasesCol(mobile, li.id, dwStorageKey).get();
        for (const p of snap.docs) total += Number(p.data().amount ?? 0);
      }
      if (total > 0) dwEntries.push({ mobile, name, total });
    } else {
      // Cumulative PV across ALL periods, all of this customer's AB ids.
      let totalPv = 0;
      for (const li of linkedIds.filter(li => li.type === 'ab_id')) {
        const periodsSnap = await idRef(mobile, li.id).collection('periods').get();
        for (const periodDoc of periodsSnap.docs) {
          const purchasesSnap = await periodDoc.ref.collection('purchases').get();
          for (const p of purchasesSnap.docs) totalPv += Number(p.data().pv ?? 0);
        }
      }
      if (totalPv > 0) abEntries.push({ mobile, name, totalPv });
    }
  }

  abEntries.sort((a, b) => b.totalPv - a.totalPv);
  dwEntries.sort((a, b) => b.total - a.total);

  return {
    abLeaderboard: abEntries.slice(0, 10),
    dwLeaderboard: dwEntries.slice(0, 10),
  };
}

module.exports = { getLeaderboards, _setNow };
