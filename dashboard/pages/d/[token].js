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

function _toMs(d) {
  if (!d) return null;
  if (typeof d.toDate === 'function') return d.toDate().getTime();
  const t = new Date(d).getTime();
  return isNaN(t) ? null : t;
}

export async function getServerSideProps({ params }) {
  const { db } = require('../../../firebase-config');
  const { token } = params;

  const snap = await db.collection('customers')
    .where('profile.magic_token', '==', token)
    .limit(1)
    .get();

  if (snap.empty) return { notFound: true };

  const doc = snap.docs[0];
  const mobile = doc.id;
  const profile = doc.data().profile ?? {};
  const linkedIds = (profile.linked_ids ?? []).map(String);

  const abIds = linkedIds.filter(id => !id.startsWith('60'));
  const dwIds = linkedIds.filter(id => id.startsWith('60'));

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const abPeriodKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const q = Math.floor(m / 3) + 1;
  const dwPeriodKey = `${y}-Q${q}`;

  const monthStart = new Date(y, m, 1).getTime();
  const monthEnd   = new Date(y, m + 1, 1).getTime();
  const qStart     = new Date(y, (q - 1) * 3, 1).getTime();
  const qEnd       = new Date(y, q * 3, 1).getTime();

  const custRef = db.collection('customers').doc(mobile);

  const [ledgerSnaps, purchaseSnap, abTargetSnap, dwTargetSnap] = await Promise.all([
    Promise.all(linkedIds.map(id => custRef.collection('st_rupees_ledger').doc(id).get())),
    custRef.collection('purchase_summary').get(),
    abIds.length > 0 ? custRef.collection('period_targets').doc(abPeriodKey).get() : Promise.resolve(null),
    dwIds.length > 0 ? custRef.collection('period_targets').doc(dwPeriodKey).get() : Promise.resolve(null),
  ]);

  // Aggregate ledger totals
  let lifetimeEarned = 0, lifetimeRedeemed = 0, available = 0;
  const ledgerById = {};
  for (let i = 0; i < linkedIds.length; i++) {
    if (ledgerSnaps[i].exists) {
      const d = ledgerSnaps[i].data();
      lifetimeEarned   += Number(d.lifetime_earned   ?? 0);
      lifetimeRedeemed += Number(d.lifetime_redeemed ?? 0);
      available        += Number(d.current_balance   ?? 0);
      ledgerById[linkedIds[i]] = d;
    }
  }

  // Sum purchases by period
  const abIdSet = new Set(abIds);
  const dwIdSet = new Set(dwIds);
  let abPurchases = 0, dwPurchases = 0;

  for (const p of purchaseSnap.docs) {
    const pd = p.data();
    const ms = _toMs(pd.date);
    const amt = Number(pd.amount ?? 0);
    const uid = String(pd.id_used ?? '');
    if (abIdSet.has(uid) && ms !== null && ms >= monthStart && ms < monthEnd) abPurchases += amt;
    if (dwIdSet.has(uid) && ms !== null && ms >= qStart     && ms < qEnd)     dwPurchases += amt;
  }

  // AB target
  const abThreshold = abTargetSnap?.exists ? Number(abTargetSnap.data().growth_threshold ?? 0) : 0;
  const abPct       = abThreshold > 0 ? Math.min(Math.round((abPurchases / abThreshold) * 100), 100) : 0;
  const abBalance   = abIds[0] && ledgerById[abIds[0]] ? Number(ledgerById[abIds[0]].current_balance ?? 0) : 0;

  // DW target
  const dwThreshold = dwTargetSnap?.exists ? Number(dwTargetSnap.data().growth_threshold ?? 0) : 0;
  const dwPct       = dwThreshold > 0 ? Math.min(Math.round((dwPurchases / dwThreshold) * 100), 100) : 0;
  const dwBalance   = dwIds[0] && ledgerById[dwIds[0]] ? Number(ledgerById[dwIds[0]].current_balance ?? 0) : 0;

  // Product target (DW only)
  let hasProduct = false, productName = '', productRequired = 0, productPurchased = 0, productPct = 0;
  if (dwTargetSnap?.exists) {
    const rec = dwTargetSnap.data().recommended_product;
    if (rec && rec.product_name) {
      hasProduct       = true;
      productName      = String(rec.product_name);
      productRequired  = Number(rec.quantity_required  ?? 0);
      productPurchased = Number(rec.quantity_purchased ?? 0);
      productPct       = productRequired > 0
        ? Math.min(Math.round((productPurchased / productRequired) * 100), 100)
        : 0;
    }
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
