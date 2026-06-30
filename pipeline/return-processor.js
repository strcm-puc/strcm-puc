const { applyDebit } = require('./ledger-writer');
const { purchasesCol, idType, fiscalPeriodKey } = require('./customer-schema');

async function processGoodsReturn(mobile, id_used, bill_number, purchase_date, original_credit_amount) {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const returnDate = new Date(purchase_date);
  const daysSincePurchase = (Date.now() - returnDate.getTime()) / MS_PER_DAY;

  if (daysSincePurchase > 30) {
    return { rejected: true, reason: 'return window expired (30 day limit)' };
  }

  const result = await applyDebit(mobile, id_used, original_credit_amount, 'goods return reversal', bill_number, returnDate);

  // Bill-level purchases log entry for this return — negative amount, same bill_number.
  const periodKey = fiscalPeriodKey(returnDate, idType(id_used) === 'display_wall');
  await purchasesCol(mobile, id_used, periodKey).doc(String(bill_number)).set({
    date:       purchase_date,
    party_code: id_used,
    amount:     -Math.abs(original_credit_amount),
  }, { merge: true });

  return { rejected: false, result };
}

module.exports = { processGoodsReturn };
