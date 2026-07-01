import { useEffect } from 'react';
import { CSS } from '../../lib/v6-css';
import { PHONE_HTML } from '../../lib/v6-html';
import { initV6Dashboard, teardownV6Dashboard, hydrateV6Dashboard } from '../../lib/v6-logic';

export default function DashboardTokenPage({ data }) {
  useEffect(() => {
    initV6Dashboard();
    hydrateV6Dashboard(data);
    return teardownV6Dashboard;
  }, []);

  return (
    <>
      <style jsx global>{CSS}</style>
      <div dangerouslySetInnerHTML={{ __html: PHONE_HTML }} />
    </>
  );
}

// ── Firestore helpers (client SDK, read-only — see /firestore.rules) ──────────
// This page must never import firebase-admin (../../../firebase-config) or any
// pipeline/*.js backend module — those carry privileged write access, vault
// credential access, and even Anthropic/Gemini call paths that have no business
// being reachable from a public customer-facing page. Everything this page
// needs is read directly here via the Firebase client SDK, gated by
// read-only Firestore Security Rules, not by service-account privilege.

import {
  collection, query, where, limit, getDocs, doc, getDoc,
} from 'firebase/firestore';
import { getDb } from '../../lib/firebase-client';
import { getPeriodBounds, fiscalPeriodKey, isDisplayWallProfile } from '../../lib/period-utils';

// Sum a customer's lifetime earned/redeemed ST Rupees across every period
// folder, for whichever linked-ID type matches their classification — the
// exact same restriction pipeline/customer-progress.js:getCustomerProgress
// applies, reimplemented here with the client SDK instead of imported.
async function getLifetimeProgress(db, mobile, linkedIds, isDW) {
  const matchingIds = linkedIds
    .filter((li) => li.type === (isDW ? 'display_wall' : 'ab_id'))
    .map((li) => li.id);

  let lifetimeEarned = 0;
  let lifetimeRedeemed = 0;

  for (const id of matchingIds) {
    const periodsSnap = await getDocs(collection(db, 'customers', mobile, 'ids', id, 'periods'));
    for (const periodDoc of periodsSnap.docs) {
      const entriesSnap = await getDocs(
        collection(db, 'customers', mobile, 'ids', id, 'periods', periodDoc.id, 'st_rupees_ledger', 'ledger', 'entries')
      );
      for (const e of entriesSnap.docs) {
        const ed = e.data();
        const amount = Number(ed.amount ?? 0);
        if (ed.type === 'credit') lifetimeEarned += amount;
        if (ed.type === 'debit') lifetimeRedeemed += amount;
      }
    }
  }

  return { lifetimeEarned, lifetimeRedeemed };
}

export async function getServerSideProps({ params }) {
  const db = getDb();
  const { token } = params;

  const custQuery = query(
    collection(db, 'customers'),
    where('profile.magic_token', '==', token),
    limit(1)
  );
  const snap = await getDocs(custQuery);

  if (snap.empty) return { notFound: true };

  const customerDoc = snap.docs[0];
  const mobile = customerDoc.id;
  const profile = customerDoc.data().profile ?? {};
  const linkedIds = profile.linked_ids ?? []; // [{id, type}]

  const abIds = linkedIds.filter(li => li.type === 'ab_id').map(li => li.id);
  const dwIds = linkedIds.filter(li => li.type === 'display_wall').map(li => li.id);

  const now = new Date();
  const { start: abPeriodStart } = getPeriodBounds(now, false);
  const { start: dwPeriodStart } = getPeriodBounds(now, true);
  const abStorageKey = fiscalPeriodKey(abPeriodStart, false);
  const dwStorageKey = fiscalPeriodKey(dwPeriodStart, true);

  const [ledgerSnaps, abPurchaseSnaps, dwPurchaseSnaps, abTargetSnap, dwTargetSnap] = await Promise.all([
    Promise.all(linkedIds.map(li => getDoc(doc(db, 'customers', mobile, 'ids', li.id)))),
    Promise.all(abIds.map(id => getDocs(collection(db, 'customers', mobile, 'ids', id, 'periods', abStorageKey, 'purchases')))),
    Promise.all(dwIds.map(id => getDocs(collection(db, 'customers', mobile, 'ids', id, 'periods', dwStorageKey, 'purchases')))),
    abIds[0] ? getDoc(doc(db, 'customers', mobile, 'ids', abIds[0], 'periods', abStorageKey)) : Promise.resolve(null),
    dwIds[0] ? getDoc(doc(db, 'customers', mobile, 'ids', dwIds[0], 'periods', dwStorageKey)) : Promise.resolve(null),
  ]);

  // Aggregate ledger totals (current_balance only — lifetime_earned/redeemed are
  // derived below via getLifetimeProgress, not needed for this dashboard view)
  let available = 0;
  const balanceById = {};
  for (let i = 0; i < linkedIds.length; i++) {
    if (ledgerSnaps[i].exists()) {
      const d = ledgerSnaps[i].data();
      available += Number(d.current_balance ?? 0);
      balanceById[linkedIds[i].id] = Number(d.current_balance ?? 0);
    }
  }

  // Sum purchases — current period only, already scoped to the right id+period folder
  let abPurchases = 0, dwPurchases = 0;
  for (const s of abPurchaseSnaps) for (const p of s.docs) abPurchases += Number(p.data().amount ?? 0);
  for (const s of dwPurchaseSnaps) for (const p of s.docs) dwPurchases += Number(p.data().amount ?? 0);

  // AB target
  const abTarget    = abTargetSnap?.exists() ? (abTargetSnap.data().target ?? {}) : {};
  const abThreshold = Number(abTarget.growth_threshold ?? 0);
  const abPct       = abThreshold > 0 ? Math.min(Math.round((abPurchases / abThreshold) * 100), 100) : 0;
  const abBalance   = abIds[0] ? (balanceById[abIds[0]] ?? 0) : 0;

  // DW target
  const dwTarget    = dwTargetSnap?.exists() ? (dwTargetSnap.data().target ?? {}) : {};
  const dwThreshold = Number(dwTarget.growth_threshold ?? 0);
  const dwPct       = dwThreshold > 0 ? Math.min(Math.round((dwPurchases / dwThreshold) * 100), 100) : 0;
  const dwBalance   = dwIds[0] ? (balanceById[dwIds[0]] ?? 0) : 0;

  // Product target (DW only)
  let hasProduct = false, productName = '', productRequired = 0, productPurchased = 0, productPct = 0;
  const rec = dwTarget.recommended_product;
  if (rec && rec.product_name) {
    hasProduct       = true;
    productName      = String(rec.product_name);
    productRequired  = Number(rec.quantity_required  ?? 0);
    productPurchased = Number(rec.quantity_purchased ?? 0);
    productPct       = productRequired > 0
      ? Math.min(Math.round((productPurchased / productRequired) * 100), 100)
      : 0;
  }

  // Join date
  let joinDate = '';
  if (profile.join_date) {
    const jd = typeof profile.join_date.toDate === 'function'
      ? profile.join_date.toDate()
      : new Date(profile.join_date);
    if (!isNaN(jd.getTime())) {
      joinDate = jd.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }
  }

  const isDW = isDisplayWallProfile(profile);
  const { lifetimeEarned, lifetimeRedeemed } = await getLifetimeProgress(db, mobile, linkedIds, isDW);

  const data = {
    name:            profile.name ?? '',
    tier:            profile.tier ?? 'Bronze',
    isAB:            abIds.length > 0,
    isDW:            dwIds.length > 0,
    abId:            abIds[0] ?? null,
    dwId:            dwIds[0] ?? null,
    abPurchases,
    abBalance,
    abThreshold,
    abPct,
    dwPurchases,
    dwBalance,
    dwThreshold,
    dwPct,
    hasProduct,
    productName,
    productRequired,
    productPurchased,
    productPct,
    lifetimeEarned,
    lifetimeRedeemed,
    available,
    joinDate,
  };

  return { props: { data } };
}
