'use strict';

const { applyCredit }   = require('./ledger-writer');
const { getCredential } = require('../vault-read');

let _rcmCreds;
async function _getRcmStoreCode() {
  if (_rcmCreds !== undefined) return _rcmCreds?.store_code ?? null;
  try   { _rcmCreds = await getCredential('rcm_login'); }
  catch (e) { console.warn('[base-reward] RCM creds unavailable:', e.message); _rcmCreds = null; }
  return _rcmCreds?.store_code ?? null;
}

// Layer 1 — guaranteed base reward, 1% of sale amount, no budget ceiling.
// Skipped entirely when id_used matches the ST Rupees store code (redemption bills).
async function calculateBaseReward(mobile, id_used, bill_number, sale_amount) {
  const storeCode = await _getRcmStoreCode();
  if (storeCode && String(id_used) === String(storeCode)) {
    console.log(`[base-reward] Bill ${bill_number}: id_used=${id_used} is ST Rupees store code — Layer 1 skipped`);
    return { baseAmount: 0, ledgerResult: null };
  }

  const baseAmount = Math.floor(sale_amount * 0.01);
  if (baseAmount <= 0) return { baseAmount: 0, ledgerResult: null };

  const ledgerResult = await applyCredit(mobile, id_used, baseAmount, 'base (guaranteed)', bill_number);
  return { baseAmount, ledgerResult };
}

module.exports = { calculateBaseReward };
