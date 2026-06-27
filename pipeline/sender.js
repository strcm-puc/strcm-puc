async function sendWhatsappMessage(customer, message) {
  console.log('[sender] - not yet implemented');
  return {
    success: true,
    step: 'sender',
    customerId: customer?.mobile ?? null,
    message,
    deliveryStatus: 'skipped',
  };
}

module.exports = { sendWhatsappMessage };
