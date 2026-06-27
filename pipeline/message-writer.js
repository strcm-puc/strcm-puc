async function writeMessage(customer, category, variantHistory) {
  console.log('[message-writer] - not yet implemented');
  return {
    success: true,
    step: 'message-writer',
    customerId: customer?.mobile ?? null,
    category,
    variantHistory,
    message: null,
  };
}

module.exports = { writeMessage };
