const { applyCredit } = require('./ledger-writer');

// Layer 2 + Layer 3 only. Layer 1 (base) is handled in base-reward-calculator.js and
// is never counted against this ceiling.
function getBonusBudgetCeiling(monthlySalesTotal) {
  return monthlySalesTotal * 0.02;
}

// Layer 2 — target bonus: awarded when the customer's monthly purchase total crosses
// a threshold that puts them above their tier's baseline.
async function applyTargetBonus(mobile, id_used, bill_number, monthlyTotal, tierThreshold) {
  if (monthlyTotal < tierThreshold) {
    return { applied: false, amount: 0 };
  }

  const bonus = Math.floor((monthlyTotal - tierThreshold) * 0.005);
  if (bonus <= 0) {
    return { applied: false, amount: 0 };
  }

  const ledgerResult = await applyCredit(mobile, id_used, bonus, 'target bonus', bill_number);
  return { applied: true, amount: bonus, ledgerResult };
}

// Layer 3 — loyalty bonus: awarded based on consecutive active months.
async function applyLoyaltyBonus(mobile, id_used, bill_number, consecutiveMonths) {
  if (consecutiveMonths < 3) {
    return { applied: false, amount: 0 };
  }

  // 2 coins per completed 3-month streak
  const bonus = Math.floor(consecutiveMonths / 3) * 2;
  if (bonus <= 0) {
    return { applied: false, amount: 0 };
  }

  const ledgerResult = await applyCredit(mobile, id_used, bonus, 'loyalty bonus', bill_number);
  return { applied: true, amount: bonus, ledgerResult };
}

// Entry point called by run-nightly.js.
async function calculateRewards(customerData) {
  const rewards = [];

  for (const customer of customerData ?? []) {
    const { mobile, id_used, bill_number, monthly_sales_total, tier_threshold, consecutive_months } = customer;

    const monthlySalesTotal = monthly_sales_total ?? 0;
    const budgetCeiling     = getBonusBudgetCeiling(monthlySalesTotal);

    const targetResult  = await applyTargetBonus(mobile, id_used, bill_number, monthlySalesTotal, tier_threshold ?? Infinity);
    const loyaltyResult = await applyLoyaltyBonus(mobile, id_used, bill_number, consecutive_months ?? 0);

    const totalBonusSpent = (targetResult.amount ?? 0) + (loyaltyResult.amount ?? 0);

    rewards.push({
      mobile,
      budgetCeiling,
      totalBonusSpent,
      withinBudget: totalBonusSpent <= budgetCeiling,
      targetBonus:  targetResult,
      loyaltyBonus: loyaltyResult,
    });
  }

  return {
    success: true,
    step: 'reward-calculator',
    customersProcessed: customerData?.length ?? 0,
    rewards,
  };
}

module.exports = { calculateRewards, getBonusBudgetCeiling, applyTargetBonus, applyLoyaltyBonus };
