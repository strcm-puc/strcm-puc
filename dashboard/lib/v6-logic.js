const allS = ['home', 'coins', 'lb', 'profile', 'ref-welcome'];

const tx = {
  en: {
    tBadge: 'SILVER +',
    acType: 'Associate Buyer · Display Wall Holder',
    rnkTxt: 'Rank 5 in Leaderboard ↗',
    lifeLabel: 'Total ST Rupees Received',
    lifeNote: 'Lifetime · Every rupee you ever earned',
    availLabel: 'Available Now',
    rdmNote: 'Visit store to redeem · Free',
    mSpnd: 'June 2026 Purchases',
    b1L: 'June 2026 — AB 12345678',
    b1H: '₹353 away from your bonus',
    b1E: '→ earn ₹18 bonus',
    b2L: 'Jan · Feb · Mar — DW 60191521',
    b2H: '₹52K away from your bonus',
    b2E: '→ earn ₹1,020 bonus',
    ptH: 'YOUR JANUARY · FEBRUARY · MARCH PRODUCT BONUS',
    ptS: 'Buy this product across these 3 months — bonus coins when complete',
    ptProd: 'Nitri Charged Man',
    ptQ: '20 units · Jan · Feb · Mar',
    ptBL: 'Complete → earn',
    ptPL: '8 of 20 units purchased',
    ptR: '12 more units — your ₹50 bonus is waiting',
    msgL: 'FOR YOU',
    msgT: 'Ramesh, you are very close to a special milestone this June.',
    scrCoin: 'ST RUPEES WALLET',
    lsE: 'Lifetime Earned',
    lsR: 'Redeemed',
    lsA: 'Available',
    ld1: 'June — your hard work paid off. Bonus allotted.',
    ld2: 'ST Rupees allotted — Bill #1425',
    ld3: 'Free product redeemed at store',
    ld4: 'Five months of loyalty — bonus allotted.',
    ld5: 'ST Rupees allotted — Bill #1390',
    ld6: 'Return adjustment — Bill #1388',
    ld7: 'May — another perfect month. Bonus allotted.',
    ld8: 'Free product redeemed at store',
    ld9: 'Referral reward — Priya joined the family!',
    la1: 'ALLOTTED',
    la2: 'ALLOTTED',
    la3: 'REDEEMED',
    la4: 'ALLOTTED',
    la5: 'ALLOTTED',
    la6: 'GR DEBIT',
    la7: 'ALLOTTED',
    la8: 'REDEEMED',
    la9: 'ALLOTTED',
    scrLB: 'LEADERBOARD',
    lbSA: 'Monthly · June 2026',
    lbSD: 'January · February · March 2027',
    privN: 'Amounts private',
    privN2: 'Amounts private',
    meAB: 'Ramesh Kumar (You) · ₹847',
    meDW: 'Ramesh Kumar (You) · ₹1,48,000',
    lbOA: '68 more members',
    ordBtnLabel: 'Place an Order',
    ordBtnSub: 'Call · 92968 54632',
    mSince: 'Member since August 2024',
    abLabel: 'ASSOCIATE BUYER',
    abTier: 'Silver',
    abM: 'June 2026 Purchases',
    abC: 'ST Rupees from this ID',
    abPV: 'Leaderboard Rank',
    dwLabel: 'DISPLAY WALL',
    dwStatus: 'Active',
    dwQ: 'January · February · March Purchases',
    dwC: 'ST Rupees from this ID',
    dwB: 'Bill on every purchase',
    refTi: 'REFER & EARN',
    refSubHero: 'ST Rupees · per person you bring in',
    famLabel: 'People you brought to the family',
    refDe:
      'Share your link. When someone who has never bought from STRCM makes their first purchase — ₹50 lands in your wallet instantly. Only you earn this — not them.',
    refSh: 'Share ↗',
    refNote: 'Tap Share · Preview what your friend sees',
    confTitle: 'Please Confirm',
    confSub: 'Are these details correct?',
    confMlbl: 'Mobile',
    confIlbl: 'AB ID',
    backBtn: 'Back',
    confBtn: 'Confirm ✓',
    rwTitle: 'Welcome to the<br>STRCM Family! 🎉',
    rwSub: 'Invited by Ramesh Kumar',
    rwEarnLbl: 'Earn ST Rupees on Every Purchase',
    rwEarnSub: 'Redeem anytime for a FREE product — any amount, no limit, no restriction',
    mLbl: 'YOUR MOBILE NUMBER',
    idLbl: 'YOUR RCM AB ID',
    joinBtn: 'Join the Family',
    benefLabel: 'WHAT YOU GET',
    b1: 'Every purchase earns you ST Rupees — redeemable for FREE products',
    b2: 'Free home delivery — right to your doorstep',
    b3: 'Your personal account — always live, always yours',
    successTitle: 'You are in the Family!',
    successMsg:
      'Your account is being set up. You will receive your personal dashboard link on WhatsApp shortly.',
    wnLbl: 'What happens next',
    wn1: 'Every purchase earns ST Rupees — yours to keep forever',
    wn2: 'Redeem for FREE products of any amount at the store',
    wn3: 'Free delivery to your home — always',
    callLbl: 'Place Your First Order',
    waMsgNote: 'Or WhatsApp us on the same number',
    ledCapNote: 'Showing your last 10 transactions',
    nH: 'Home',
    nS: 'ST Rupees',
    nL: 'Leaderboard',
    nP: 'Profile',
    btnNext: 'हि',
  },
  hi: {
    tBadge: 'सिल्वर +',
    acType: 'एसोसिएट खरीदार · डिस्प्ले वॉल होल्डर',
    rnkTxt: 'लीडरबोर्ड में रैंक 5 ↗',
    lifeLabel: 'कुल ST रुपये प्राप्त',
    lifeNote: 'जीवनकाल · आपकी हर मेहनत का हिसाब',
    availLabel: 'अभी उपलब्ध',
    rdmNote: 'स्टोर पर रिडीम करें · मुफ्त',
    mSpnd: 'जून 2026 की खरीद',
    b1L: 'जून 2026 — AB 12345678',
    b1H: '₹353 और आपका बोनस',
    b1E: '→ ₹18 बोनस पाएं',
    b2L: 'जन · फर · मार — DW 60191521',
    b2H: '₹52K और आपका बोनस',
    b2E: '→ ₹1,020 बोनस पाएं',
    ptH: 'आपका जनवरी · फरवरी · मार्च प्रोडक्ट बोनस',
    ptS: 'इन 3 महीनों में यह प्रोडक्ट खरीदें — पूरा होने पर बोनस ST रुपये',
    ptProd: 'Nitri Charged Man',
    ptQ: '20 यूनिट · जन · फर · मार',
    ptBL: 'पूरा करें → पाएं',
    ptPL: '20 में से 8 यूनिट खरीदे',
    ptR: '12 यूनिट और — आपका ₹50 बोनस इंतज़ार में है',
    msgL: 'आपके लिए',
    msgT: 'रमेश जी, इस जून में आप एक खास मुकाम के बिल्कुल करीब हैं।',
    scrCoin: 'ST रुपये वॉलेट',
    lsE: 'जीवनकाल में कमाए',
    lsR: 'रिडीम किए',
    lsA: 'उपलब्ध',
    ld1: 'जून — आपकी मेहनत रंग लाई। बोनस क्रेडिट।',
    ld2: 'ST रुपये क्रेडिट — Bill #1425',
    ld3: 'स्टोर पर मुफ्त प्रोडक्ट लिया',
    ld4: 'पाँच महीने की निरंतरता — बोनस क्रेडिट',
    ld5: 'ST रुपये क्रेडिट — Bill #1390',
    ld6: 'रिटर्न एडजस्टमेंट — Bill #1388',
    ld7: 'मई — एक और शानदार महीना। बोनस क्रेडिट।',
    ld8: 'स्टोर पर मुफ्त प्रोडक्ट लिया',
    ld9: 'रेफरल इनाम — प्रिया परिवार में जुड़ गईं!',
    la1: 'क्रेडिट',
    la2: 'क्रेडिट',
    la3: 'रिडीम',
    la4: 'क्रेडिट',
    la5: 'क्रेडिट',
    la6: 'GR डेबिट',
    la7: 'क्रेडिट',
    la8: 'रिडीम',
    la9: 'क्रेडिट',
    scrLB: 'लीडरबोर्ड',
    lbSA: 'मासिक · जून 2026',
    lbSD: 'जनवरी · फरवरी · मार्च 2027',
    privN: 'राशि निजी',
    privN2: 'राशि निजी',
    meAB: 'रमेश कुमार (आप) · ₹847',
    meDW: 'रमेश कुमार (आप) · ₹1,48,000',
    lbOA: '68 और सदस्य',
    ordBtnLabel: 'ऑर्डर दें',
    ordBtnSub: 'कॉल करें · 92968 54632',
    mSince: 'अगस्त 2024 से सदस्य',
    abLabel: 'एसोसिएट खरीदार',
    abTier: 'सिल्वर',
    abM: 'जून 2026 की खरीद',
    abC: 'इस ID से ST रुपये',
    abPV: 'लीडरबोर्ड रैंक',
    dwLabel: 'डिस्प्ले वॉल',
    dwStatus: 'सक्रिय',
    dwQ: 'जनवरी · फरवरी · मार्च की खरीद',
    dwC: 'इस ID से ST रुपये',
    dwB: 'हर खरीद पर बिल',
    refTi: 'रेफर करें और कमाएं',
    refSubHero: 'ST रुपये · हर नए परिवार के सदस्य पर',
    famLabel: 'जितने लोगों को आपने परिवार से जोड़ा',
    refDe:
      'अपना लिंक शेयर करें। जब कोई STRCM से पहली बार खरीदता है — ₹50 आपके वॉलेट में तुरंत आ जाते हैं। यह सिर्फ आपको मिलता है — उन्हें नहीं।',
    refSh: 'शेयर करें ↗',
    refNote: 'शेयर दबाएं · देखें आपका दोस्त क्या देखेगा',
    confTitle: 'कृपया जांचें',
    confSub: 'क्या ये जानकारी सही है?',
    confMlbl: 'मोबाइल',
    confIlbl: 'AB ID',
    backBtn: 'वापस',
    confBtn: 'पुष्टि करें ✓',
    rwTitle: 'STRCM परिवार में<br>स्वागत है! 🎉',
    rwSub: 'रमेश कुमार ने आपको बुलाया है',
    rwEarnLbl: 'हर खरीद पर ST रुपये पाएं',
    rwEarnSub: 'किसी भी समय FREE प्रोडक्ट के लिए रिडीम करें — कोई सीमा नहीं, कोई शर्त नहीं',
    mLbl: 'आपका मोबाइल नंबर',
    idLbl: 'आपका RCM AB ID',
    joinBtn: 'परिवार से जुड़ें',
    benefLabel: 'आपको क्या मिलेगा',
    b1: 'हर खरीद पर ST रुपये — FREE प्रोडक्ट के रूप में पाएं',
    b2: 'घर तक मुफ्त डिलीवरी — हमेशा',
    b3: 'आपका पर्सनल अकाउंट — हमेशा लाइव',
    successTitle: 'आप परिवार में आ गए!',
    successMsg: 'आपका खाता तैयार हो रहा है। जल्द ही WhatsApp पर आपका डैशबोर्ड लिंक मिलेगा।',
    wnLbl: 'आगे क्या होगा',
    wn1: 'हर खरीद पर ST रुपये — हमेशा के लिए आपके',
    wn2: 'किसी भी राशि के FREE प्रोडक्ट के लिए रिडीम करें',
    wn3: 'घर पर मुफ्त डिलीवरी — बिना किसी शर्त के',
    callLbl: 'पहला ऑर्डर दें',
    waMsgNote: 'या उसी नंबर पर WhatsApp करें',
    ledCapNote: 'आपके आखिरी 10 ट्रांज़ैक्शन दिखाए जा रहे हैं',
    nH: 'होम',
    nS: 'ST रुपये',
    nL: 'लीडरबोर्ड',
    nP: 'प्रोफाइल',
    btnNext: 'EN',
  },
};

const ids = [
  'tBadge', 'acType', 'rnkTxt', 'lifeLabel', 'lifeNote', 'availLabel', 'rdmNote', 'mSpnd',
  'b1L', 'b1H', 'b1E', 'b2L', 'b2H', 'b2E', 'ptH', 'ptS', 'ptProd', 'ptQ', 'ptBL', 'ptPL',
  'ptR', 'msgL', 'msgT', 'scrCoin', 'lsE', 'lsR', 'lsA', 'ld1', 'ld2', 'ld3', 'ld4', 'ld5',
  'ld6', 'ld7', 'ld8', 'ld9', 'la1', 'la2', 'la3', 'la4', 'la5', 'la6', 'la7', 'la8', 'la9',
  'scrLB', 'lbSA', 'lbSD', 'privN', 'privN2', 'meAB', 'meDW', 'lbOA', 'ordBtnLabel',
  'ordBtnSub', 'mSince', 'abLabel', 'abTier', 'abM', 'abC', 'abPV', 'dwLabel', 'dwStatus',
  'dwQ', 'dwC', 'dwB', 'refTi', 'refSubHero', 'famLabel', 'refDe', 'refSh', 'refNote',
  'confTitle', 'confSub', 'confMlbl', 'confIlbl', 'backBtn', 'confBtn', 'rwTitle', 'rwSub',
  'rwEarnLbl', 'rwEarnSub', 'mLbl', 'idLbl', 'joinBtn', 'benefLabel', 'b1', 'b2', 'b3',
  'successTitle', 'successMsg', 'wnLbl', 'wn1', 'wn2', 'wn3', 'callLbl', 'waMsgNote',
  'ledCapNote', 'nH', 'nS', 'nL', 'nP',
];

let lang = 'hi';
let progressTimer = null;

function showS(id) {
  allS.forEach((s) => {
    const el = document.getElementById(`s-${s}`);
    if (el) el.className = `screen${s === id ? ' act' : ''}`;
  });
  ['home', 'coins', 'lb', 'profile'].forEach((n) => {
    const ni = document.getElementById(`n-${n}`);
    if (!ni) return;
    const active = n === id;
    ni.querySelector('.ni-ico').style.color = active ? '#C9A84C' : '#3A3A3A';
    ni.querySelector('.ni-lbl').style.color = active ? '#C9A84C' : '#3A3A3A';
  });
  const inner = document.querySelector('.inner');
  if (inner) inner.scrollTop = 0;
  if (id === 'ref-welcome') {
    const rwForm = document.getElementById('rw-form');
    const rwSuccess = document.getElementById('rw-success');
    if (rwForm) rwForm.style.display = 'block';
    if (rwSuccess) rwSuccess.style.display = 'none';
    launchCF();
  }
}

function swLB(w) {
  const lbAb = document.getElementById('lb-ab');
  const lbDw = document.getElementById('lb-dw');
  const tabAB = document.getElementById('tabAB');
  const tabDW = document.getElementById('tabDW');
  if (lbAb) lbAb.style.display = w === 'ab' ? 'block' : 'none';
  if (lbDw) lbDw.style.display = w === 'dw' ? 'block' : 'none';
  if (tabAB) tabAB.className = `lt${w === 'ab' ? ' act' : ''}`;
  if (tabDW) tabDW.className = `lt${w === 'dw' ? ' actb' : ''}`;
}

function fL(f, btn) {
  document.querySelectorAll('.ft').forEach((t) => {
    t.className = 'ft';
  });
  btn.className = 'ft act';
  document.querySelectorAll('.cr-e').forEach((e) => {
    e.style.display = f === 'dr' ? 'none' : 'flex';
  });
  document.querySelectorAll('.dr-e').forEach((e) => {
    e.style.display = f === 'cr' ? 'none' : 'flex';
  });
}

function tryJoin() {
  const mob = document.getElementById('rw-mob').value.trim();
  const id = document.getElementById('rw-id').value.trim();
  const err = document.getElementById('mob-err');
  const idErr = document.getElementById('id-err');
  if (mob.length !== 10 || !/^\d{10}$/.test(mob)) {
    document.getElementById('rw-mob').style.borderColor = 'rgba(231,76,60,0.5)';
    err.style.display = 'block';
    return;
  }
  if (id.startsWith('60')) {
    document.getElementById('rw-id').style.borderColor = 'rgba(231,76,60,0.5)';
    idErr.style.display = 'block';
    return;
  }
  document.getElementById('conf-mob').textContent = mob;
  document.getElementById('conf-id').textContent = id || '—';
  const m = document.getElementById('modal');
  m.style.display = 'flex';
}

function clrIdErr() {
  document.getElementById('rw-id').style.borderColor = '#2A2A2A';
  document.getElementById('id-err').style.display = 'none';
}

function clrErr() {
  document.getElementById('rw-mob').style.borderColor = '#2A2A2A';
  document.getElementById('mob-err').style.display = 'none';
}

function goBack() {
  document.getElementById('modal').style.display = 'none';
}

function confirmJoin() {
  document.getElementById('modal').style.display = 'none';
  document.getElementById('rw-form').style.display = 'none';
  document.getElementById('rw-success').style.display = 'block';
  launchCF();
}

function launchCF() {
  const w = document.getElementById('cf-wrap');
  if (!w) return;
  w.innerHTML = '';
  const cols = ['#C9A84C', '#4A90D9', '#2ECC71', '#E74C3C', '#F1C40F', '#9B59B6', '#E67E22'];
  for (let i = 0; i < 60; i += 1) {
    const d = document.createElement('div');
    const sz = 4 + Math.random() * 6;
    const left = Math.random() * 100;
    const delay = Math.random() * 0.7;
    const dur = 1.3 + Math.random() * 1.2;
    const col = cols[Math.floor(Math.random() * cols.length)];
    const rnd = Math.random() > 0.4 ? '50%' : '2px';
    d.style.cssText = `position:absolute;width:${sz}px;height:${sz}px;background:${col};left:${left}%;top:-12px;border-radius:${rnd};animation:cffall ${dur}s ${delay}s ease-in both;`;
    w.appendChild(d);
  }
}

function applyLang() {
  const t = tx[lang];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el && t[id] !== undefined) el.innerHTML = t[id];
  });
  const lbtn = document.getElementById('lbtn');
  if (lbtn) lbtn.textContent = t.btnNext;
}

function tL() {
  lang = lang === 'en' ? 'hi' : 'en';
  applyLang();
}

function attachGlobals() {
  window.showS = showS;
  window.swLB = swLB;
  window.fL = fL;
  window.tryJoin = tryJoin;
  window.clrIdErr = clrIdErr;
  window.clrErr = clrErr;
  window.goBack = goBack;
  window.confirmJoin = confirmJoin;
  window.tL = tL;
}

function removeGlobals() {
  delete window.showS;
  delete window.swLB;
  delete window.fL;
  delete window.tryJoin;
  delete window.clrIdErr;
  delete window.clrErr;
  delete window.goBack;
  delete window.confirmJoin;
  delete window.tL;
}

function initV6Dashboard() {
  attachGlobals();
  applyLang();
  progressTimer = setTimeout(() => {
    const bf1 = document.getElementById('bf1');
    const bf2 = document.getElementById('bf2');
    const bf3 = document.getElementById('bf3');
    if (bf1) bf1.style.width = '70.6%';
    if (bf2) bf2.style.width = '48%';
    if (bf3) bf3.style.width = '40%';
  }, 500);
}

function teardownV6Dashboard() {
  if (progressTimer) clearTimeout(progressTimer);
  removeGlobals();
}

module.exports = {
  initV6Dashboard,
  teardownV6Dashboard,
};
