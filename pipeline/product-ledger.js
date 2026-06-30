'use strict';

const { idType, fiscalPeriodKey, periodRef } = require('./customer-schema');

let _nowFn = () => new Date();
function _setNow(fn) { _nowFn = fn; }

// Pick a string field from a raw Excel row using common column-name variants.
function _pickStr(row, ...candidates) {
  const norm = s => s.toLowerCase().replace(/[\s._]/g, '');
  for (const c of candidates) {
    const key = Object.keys(row).find(k => norm(k) === norm(c));
    if (key !== undefined) return String(row[key] ?? '').trim();
  }
  return '';
}

function _pickNum(row, ...candidates) {
  const v = _pickStr(row, ...candidates);
  return parseFloat(v) || 0;
}

// Case-insensitive, trimmed bidirectional substring match.
// Strategy flagged: RCM POS item names in the export may be abbreviated or
// cased differently from the recommended_product.product_name value that Adnan
// sets manually. Exact match silently misses truncated exports (e.g. "NITRI
// CHARGED" vs "Nitri Charged Man"). Bidirectional substring match catches both
// directions and is the safest strategy without seeing a live export sample.
function _namesMatch(rowName, productName) {
  if (!rowName || !productName) return false;
  const a = rowName.toLowerCase().replace(/\s+/g, ' ').trim();
  const b = productName.toLowerCase().replace(/\s+/g, ' ').trim();
  return a === b || a.includes(b) || b.includes(a);
}

// Called once per ingested transaction batch per (mobile, id_used), immediately
// after the Layer 1 base reward. No-ops for non-DW ids, missing targets, and
// missing recommended_product. Idempotency against duplicate bills is handled
// upstream by the processed_bills guard in data-ingestion.js; this function
// is not called a second time for the same bill.
async function updateProductLedger(mobile, id_used, itemRows) {
  if (!Array.isArray(itemRows) || itemRows.length === 0) return;
  if (idType(id_used) !== 'display_wall') return;

  const periodKey  = fiscalPeriodKey(_nowFn(), true);
  const periodDoc  = periodRef(mobile, id_used, periodKey);
  const periodSnap = await periodDoc.get();
  if (!periodSnap.exists) return;

  const periodData = periodSnap.data();
  const target      = periodData.target ?? {};
  const recProd     = target.recommended_product;
  if (!recProd || !recProd.product_name) return;

  const productName      = String(recProd.product_name);
  const quantityRequired = Number(recProd.quantity_required) || 0;
  if (quantityRequired <= 0) return;

  // Tally matching units across all item rows in this transaction.
  let matchedQty = 0;
  for (const row of itemRows) {
    const itemName = _pickStr(row,
      'Item Name', 'ItemName', 'Product Name', 'ProductName',
      'Description', 'Item', 'Product'
    );
    if (!_namesMatch(itemName, productName)) continue;
    const qty = _pickNum(row, 'Qty', 'Quantity', 'Qty.', 'Ordered Qty', 'Qty Ordered');
    matchedQty += qty;
  }
  if (matchedQty <= 0) return;

  const alreadyCompleted = target.product_completed === true;
  const currentPurchased = Number(recProd.quantity_purchased ?? 0);
  const newPurchased     = currentPurchased + matchedQty;

  // Single targeted field update — never overwrites other target fields.
  const updateObj = { 'target.recommended_product.quantity_purchased': newPurchased };
  if (!alreadyCompleted && newPurchased >= quantityRequired) {
    updateObj['target.product_completed'] = true;
  }

  await periodDoc.update(updateObj);

  console.log(
    `[product-ledger] ${mobile} | ${id_used} | ${periodKey} | ` +
    `${productName}: +${matchedQty} → ${newPurchased}/${quantityRequired}` +
    (updateObj['target.product_completed'] ? ' → COMPLETED ✓' : '')
  );
}

module.exports = { updateProductLedger, _pickStr, _pickNum, _setNow };
