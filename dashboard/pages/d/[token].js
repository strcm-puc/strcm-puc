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

// ── Firestore helpers (server-side only) ──────────────────────────────────────

export async function getServerSideProps({ params }) {
  const { db } = require('../../../firebase-config');
  const { idRef, purchasesCol, fiscalPeriodKey } = require('../../../pipeline/customer-schema');
  const { getPeriodBounds } = require('../../../pipeline/reward-calculator');
  const { getCustomerProgress } = require('../../../pipeline/customer-progress');
  const { token } = params;

  const snap = await db.collection('customers')
    .where('profile.magic_token', '==', token)
    .limit(1)
    .get();

  if (snap.empty) return { notFound: true };

  const doc = snap.docs[0];
  const mobile = doc.id;
  const profile = doc.data().profile ?? {};
  const linkedIds = profile.linked_ids ?? []; // [{id, type}]

  const abIds = linkedIds.filter(li => li.type === 'ab_id').map(li => li.id);
  const dwIds = linkedIds.filter(li => li.type === 'display_wall').map(li => li.id);

  const now = new Date();
  const { start: abPeriodStart } = getPeriodBounds(now, false);
  const { start: dwPeriodStart } = getPeriodBounds(now, true);
  const abStorageKey = fiscalPeriodKey(abPeriodStart, false);
  const dwStorageKey = fiscalPeriodKey(dwPeriodStart, true);

  const [ledgerSnaps, abPurchaseSnaps, dwPurchaseSnaps, abTargetSnap, dwTargetSnap] = await Promise.all([
    Promise.all(linkedIds.map(li => idRef(mobile, li.id).get())),
    Promise.all(abIds.map(id => purchasesCol(mobile, id, abStorageKey).get())),
    Promise.all(dwIds.map(id => purchasesCol(mobile, id, dwStorageKey).get())),
    abIds[0] ? idRef(mobile, abIds[0]).collection('periods').doc(abStorageKey).get() : Promise.resolve(null),
    dwIds[0] ? idRef(mobile, dwIds[0]).collection('periods').doc(dwStorageKey).get() : Promise.resolve(null),
  ]);

  // Aggregate ledger totals (current_balance only — lifetime_earned/redeemed are
  // derived elsewhere via customer-progress.js, not needed for this dashboard view)
  let available = 0;
  const balanceById = {};
  for (let i = 0; i < linkedIds.length; i++) {
    if (ledgerSnaps[i].exists) {
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
  const abTarget    = abTargetSnap?.exists ? (abTargetSnap.data().target ?? {}) : {};
  const abThreshold = Number(abTarget.growth_threshold ?? 0);
  const abPct       = abThreshold > 0 ? Math.min(Math.round((abPurchases / abThreshold) * 100), 100) : 0;
  const abBalance   = abIds[0] ? (balanceById[abIds[0]] ?? 0) : 0;

  // DW target
  const dwTarget    = dwTargetSnap?.exists ? (dwTargetSnap.data().target ?? {}) : {};
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

  const progress = await getCustomerProgress(mobile);

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
    lifetimeEarned:   progress?.lifetime.earned   ?? 0,
    lifetimeRedeemed: progress?.lifetime.redeemed ?? 0,
    available,
    joinDate,
  };

  return { props: { data } };
}
