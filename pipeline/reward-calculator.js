async function calculateRewards(customerData) {
  console.log('[reward-calculator] - not yet implemented');
  return {
    success: true,
    step: 'reward-calculator',
    customersProcessed: customerData?.length ?? 0,
    rewards: [],
  };
}

module.exports = { calculateRewards };
