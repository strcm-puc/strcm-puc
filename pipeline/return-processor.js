const { applyDebit } = require('./ledger-writer');

async function processGoodsReturn(mobile, id_used, bill_number, purchase_date, original_credit_amount) {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const daysSincePurchase = (Date.now() - new Date(purchase_date).getTime()) / MS_PER_DAY;

  if (daysSincePurchase > 30) {
    return { rejected: true, reason: 'return window expired (30 day limit)' };
  }

  const result = await applyDebit(mobile, id_used, original_credit_amount, 'goods return reversal', bill_number);
  return { rejected: false, result };
}

module.exports = { processGoodsReturn };
