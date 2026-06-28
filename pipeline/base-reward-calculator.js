const { applyCredit } = require('./ledger-writer');

// Layer 1 — guaranteed base reward, 1% of sale amount, no budget ceiling.
async function calculateBaseReward(mobile, id_used, bill_number, sale_amount) {
  const baseAmount = Math.floor(sale_amount * 0.01);

  if (baseAmount <= 0) {
    return { baseAmount: 0, ledgerResult: null };
  }

  const ledgerResult = await applyCredit(mobile, id_used, baseAmount, 'base (guaranteed)', bill_number);
  return { baseAmount, ledgerResult };
}

module.exports = { calculateBaseReward };
