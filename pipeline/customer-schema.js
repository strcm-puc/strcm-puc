'use strict';

const { db } = require('../firebase-config');

// ── ID type tagging ─────────────────────────────────────────────────────────────
// Same rule as before (IDs starting with '60' are Display Wall) — now tagged
// explicitly at write time instead of re-derived by prefix-check on every read.

function idType(id) {
  return String(id).startsWith('60') ? 'display_wall' : 'ab_id';
}

// Converts a plain string array of IDs into the new tagged shape: [{id, type}].
function tagLinkedIds(rawIds) {
  return (rawIds ?? []).map(id => ({ id: String(id), type: idType(id) }));
}

// Plain string values out of a tagged linked_ids array — Firestore's
// array-contains can't match into array-of-object fields, so callers that need
// to query by raw ID value (isKnownPartyCode, resolveMobile) use the parallel
// profile.linked_id_values field instead, kept in sync wherever linked_ids is written.
function linkedIdValues(linkedIds) {
  return (linkedIds ?? []).map(li => li.id);
}

function isDisplayWallProfile(profile) {
  const linkedIds = profile?.linked_ids ?? [];
  return linkedIds.length > 0 && linkedIds.every(li => li.type === 'display_wall');
}

// ── Fiscal-year period key (April–March) ───────────────────────────────────────
// Pure relabeling of the exact same calendar date ranges getPeriodBounds() already
// groups transactions by — no boundary or grouping math changes here. Calendar
// Apr–Jun is always Apr–Jun; this only changes what string we call it.
//   AB ID (monthly):       "FY2627-04"  (fiscal year label + calendar month number)
//   Display Wall (quarter): "FY2627-Q1" (Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar)
function fiscalYearLabel(calendarYear, calendarMonth /* 0-indexed */) {
  // Fiscal year starts in April (month index 3). Jan-Mar belongs to the fiscal
  // year that started the previous April.
  const fyStartYear = calendarMonth >= 3 ? calendarYear : calendarYear - 1;
  const a = String(fyStartYear % 100).padStart(2, '0');
  const b = String((fyStartYear + 1) % 100).padStart(2, '0');
  return `FY${a}${b}`;
}

function fiscalPeriodKey(date, isDW) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-indexed
  const fy = fiscalYearLabel(y, m);

  if (isDW) {
    // Calendar quarter (0=Jan-Mar,1=Apr-Jun,2=Jul-Sep,3=Oct-Dec) -> fiscal quarter number
    const calQ = Math.floor(m / 3); // 0..3
    const fiscalQ = ((calQ - 1) + 4) % 4 + 1; // Apr-Jun(calQ=1)->Q1 ... Jan-Mar(calQ=0)->Q4
    return `${fy}-Q${fiscalQ}`;
  }
  return `${fy}-${String(m + 1).padStart(2, '0')}`;
}

// ── Path builders ──────────────────────────────────────────────────────────────
// /customers/{mobile}/ids/{id}/periods/{period_key}/...

function customerRef(mobile) {
  return db.collection('customers').doc(mobile);
}

function idRef(mobile, id) {
  return customerRef(mobile).collection('ids').doc(String(id));
}

function periodRef(mobile, id, periodKey) {
  return idRef(mobile, id).collection('periods').doc(periodKey);
}

function purchasesCol(mobile, id, periodKey) {
  return periodRef(mobile, id, periodKey).collection('purchases');
}

function productsCol(mobile, id, periodKey) {
  return periodRef(mobile, id, periodKey).collection('products');
}

function ledgerEntriesCol(mobile, id, periodKey) {
  return periodRef(mobile, id, periodKey).collection('st_rupees_ledger').doc('ledger').collection('entries');
}

function aiNotesCol(mobile, id, periodKey) {
  return periodRef(mobile, id, periodKey).collection('ai_notes');
}

module.exports = {
  idType,
  tagLinkedIds,
  linkedIdValues,
  isDisplayWallProfile,
  fiscalPeriodKey,
  customerRef,
  idRef,
  periodRef,
  purchasesCol,
  productsCol,
  ledgerEntriesCol,
  aiNotesCol,
};
