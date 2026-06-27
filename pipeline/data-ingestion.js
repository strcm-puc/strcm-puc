async function ingestSalesData(rawData) {
  console.log('[data-ingestion] - not yet implemented');
  return {
    success: true,
    step: 'data-ingestion',
    recordsProcessed: 0,
    rawData,
  };
}

module.exports = { ingestSalesData };
