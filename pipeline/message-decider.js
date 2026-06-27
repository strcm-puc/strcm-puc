async function decideMessageNeeded(customer) {
  console.log('[message-decider] - not yet implemented');
  return {
    success: true,
    step: 'message-decider',
    customerId: customer?.mobile ?? null,
    messageNeeded: false,
    reason: 'placeholder',
  };
}

module.exports = { decideMessageNeeded };
