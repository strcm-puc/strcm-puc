'use strict';

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const { chromium } = require('playwright');
const XLSX  = require('xlsx');
const { getCredential } = require('../vault-read');
const { db } = require('../firebase-config');

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// ── Helpers ────────────────────────────────────────────────────────────────────

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return { formatted: `${dd}-${mm}-${yyyy}`, iso: `${yyyy}-${mm}-${dd}` };
}

function parseXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Rows 0-2 are title/store/period metadata; row 3 is the real header row.
  return XLSX.utils.sheet_to_json(ws, { defval: '', range: 3 });
}

// Fuzzy header match: strip spaces/dots/underscores, case-insensitive
function pick(row, ...candidates) {
  const norm = s => s.toLowerCase().replace(/[\s._]/g, '');
  for (const c of candidates) {
    const key = Object.keys(row).find(k => norm(k) === norm(c));
    if (key !== undefined) return String(row[key] ?? '').trim();
  }
  return '';
}

async function sendTelegramAlert(botToken, chatId, text) {
  // Trim credentials — prevents "unescaped characters" error if vault value has trailing whitespace
  const token  = String(botToken).trim();
  const chatId_ = String(chatId).trim();
  const body   = JSON.stringify({ chat_id: chatId_, text, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function isKnownPartyCode(partyCode) {
  const snap = await db.collection('customers')
    .where('profile.linked_ids', 'array-contains', partyCode)
    .limit(1)
    .get();
  return !snap.empty;
}


// ── Main export ────────────────────────────────────────────────────────────────

async function scrapeYesterdaySales() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  const { formatted: dateFmt, iso: dateIso } = getYesterday();
  const billSummaryPath = path.join(DOWNLOADS_DIR, `bill-summary-${dateIso}.xlsx`);
  const itemDetailPath  = path.join(DOWNLOADS_DIR, `item-detail-${dateIso}.xlsx`);

  console.log(`[scraper] Date target: ${dateFmt}`);

  const [rcm, tg] = await Promise.all([
    getCredential('rcm_login'),
    getCredential('telegram_bot'),
  ]);

  // ── STATUS: scrape started ───────────────────────────────────────────
  await sendTelegramAlert(tg.bot_token, tg.admin_chat_id,
    `🔄 ST-APEX: Starting nightly scrape for ${dateFmt}...`
  ).catch(e => console.warn('[scraper] Telegram start-alert failed:', e.message));

  let browser = null;
  let page    = null;

  try {

    // ── LAUNCH ──────────────────────────────────────────────────────────
    // Edge channel is mandatory — site returns "wrong password" with Chromium/Chrome channel.
    console.log('[scraper] Launching Microsoft Edge (channel: msedge)...');
    browser = await chromium.launch({ channel: 'msedge', headless: false });
    const context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    page.setDefaultTimeout(25000);

    // ── LOGIN ────────────────────────────────────────────────────────────
    console.log('[scraper] → https://pos2.rcmworld.com');
    await page.goto('https://pos2.rcmworld.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.locator('input[placeholder="Enter Your Mobile No."]').fill(rcm.username);
    await page.locator('input[placeholder="Password"]').fill(rcm.password);
    await page.getByRole('button', { name: /sign in/i }).click();

    console.log('[scraper] Waiting for dashboard (Quick Access)...');
    try {
      await page.waitForSelector('text=Quick Access', { timeout: 30000 });
    } catch {
      // Capture whatever error the page is showing before throwing
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const errorHint = bodyText.slice(0, 300).replace(/\n+/g, ' ');
      throw new Error(`Login failed — dashboard never appeared. Page says: "${errorHint}"`);
    }
    console.log('[scraper] Login ✓');

    // ── SIDEBAR: Reports > Sales > Sales View ────────────────────────────
    // Sidebar is always visible — no hamburger toggle needed.
    console.log('[scraper] Navigating: Reports > Sales > Sales View...');

    await page.locator('text=Reports').first().click();
    await page.waitForTimeout(500);

    // After Reports expands, "Sales" appears — avoid matching "Sales View" by using exact partial
    await page.locator('li:has-text("Sales") >> text=Sales').first().click();
    await page.waitForTimeout(500);

    await page.locator('text=Sales View').first().click();
    await page.waitForSelector('text=Search by', { timeout: 15000 });
    console.log('[scraper] On Sales View page ✓');

    // ── DATE FILTER ──────────────────────────────────────────────────────
    // Confirmed by inspection: Ant Design RangePicker with two separate text inputs
    // (placeholder "Start date" / "End date"). Day cells carry title="YYYY-MM-DD".
    // Two clicks on the same cell are required: click 1 = start, click 2 = end.
    console.log(`[scraper] Setting date filter → ${dateFmt}...`);

    // Ensure "Date" radio is selected
    await page.locator('label').filter({ hasText: /^Date$/ }).first().click().catch(() =>
      page.getByRole('radio', { name: /^date$/i }).click().catch(() => {})
    );
    await page.waitForTimeout(500);

    // Open the Ant Design range picker by clicking its container
    await page.locator('.ant-picker').first().click();
    await page.waitForSelector('.ant-picker-dropdown', { timeout: 8000 });
    await page.waitForTimeout(300);

    // Select yesterday using its exact ISO title attribute — unambiguous, never matches
    // a disabled future-month cell, works correctly on every date forever.
    const yesterdayCell = page.locator(`td[title="${dateIso}"]`);
    await yesterdayCell.click();         // click 1: sets start date
    await page.waitForTimeout(400);
    await yesterdayCell.click();         // click 2: sets end date = same day, closes picker
    await page.waitForTimeout(500);

    // ── HARD SAFETY CHECK ─────────────────────────────────────────────────
    // Read both inputs and confirm they match the dynamically-calculated yesterday.
    // If either is wrong, throw immediately — never proceed to Search with a bad range.
    const startVal = await page.locator('input[placeholder="Start date"]').inputValue();
    const endVal   = await page.locator('input[placeholder="End date"]').inputValue();
    console.log(`[scraper] Start date: "${startVal}" | End date: "${endVal}" | Expected: "${dateFmt}"`);

    if (startVal !== dateFmt || endVal !== dateFmt) {
      throw new Error(
        `Date safety check FAILED — start="${startVal}", end="${endVal}", ` +
        `expected both="${dateFmt}". Picker did not close to a single-day range.`
      );
    }
    console.log('[scraper] Date verified ✓');

    // Search button — Ant Design icon-button accessible name is "search Search" (icon
    // aria-label + span), so getByRole name matching fails. Use has-text instead.
    console.log('[scraper] Clicking Search...');
    await page.locator('button:has-text("Search")').first().click({ timeout: 10000 })
      .catch(() => page.locator('.ant-btn-primary, [class*="search" i]').filter({ hasText: /Search/ }).first().click());

    console.log('[scraper] Waiting for results...');
    // Wait for Ant Design spinner to clear first, then for rows or empty state
    await page.locator('.ant-spin-spinning, .ant-spin-dot').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    await page.waitForSelector(
      '.ant-table-row, .ant-table-tbody tr, .ant-empty-description, text=No Record, text=No Data',
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(800);

    const visibleRows = await page.locator('.ant-table-row, .ant-table-tbody tr').count();
    console.log(`[scraper] Rows visible in results table: ${visibleRows}`);

    const debugSs = path.join(DOWNLOADS_DIR, `debug-pre-export-${Date.now()}.png`);
    await page.screenshot({ path: debugSs, fullPage: true });
    console.log(`[scraper] Pre-export screenshot → ${path.basename(debugSs)}`);

    if (visibleRows === 0) {
      console.log('[scraper] No sales rows found in UI after waiting — confirmed zero transactions for this date');
    }
    console.log('[scraper] Results loaded ✓');

    // ── EXPORT 1: Bill Summary → Excel ───────────────────────────────────
    console.log('[scraper] Downloading bill summary (Export As → Excel)...');
    const [dl1] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      (async () => {
        await page.locator('button:has-text("Export As"), a:has-text("Export As")').first().click();
        await page.waitForTimeout(400);
        await page.locator('text=Excel').first().click();
      })(),
    ]);
    await dl1.saveAs(billSummaryPath);
    console.log(`[scraper] Bill summary → ${path.basename(billSummaryPath)}`);

    // ── EXPORT 2: Item Detail → Export Bill Item ─────────────────────────
    console.log('[scraper] Downloading item detail (Export As → Export Bill Item)...');
    const [dl2] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      (async () => {
        await page.locator('button:has-text("Export As"), a:has-text("Export As")').first().click();
        await page.waitForTimeout(400);
        await page.locator('text=Export Bill Item').first().click();
      })(),
    ]);
    await dl2.saveAs(itemDetailPath);
    console.log(`[scraper] Item detail  → ${path.basename(itemDetailPath)}`);

    await browser.close();
    browser = null;
    console.log('[scraper] Browser closed ✓');

    // ── PARSE ────────────────────────────────────────────────────────────
    console.log('[scraper] Parsing Excel files...');
    const billRows = parseXlsx(billSummaryPath);
    const itemRows = parseXlsx(itemDetailPath);

    console.log(`[scraper] Bill rows: ${billRows.length} | Item rows: ${itemRows.length}`);
    if (billRows.length > 0) console.log('[scraper] Bill columns :', Object.keys(billRows[0]).join(' | '));
    if (itemRows.length > 0) console.log('[scraper] Item columns :', Object.keys(itemRows[0]).join(' | '));

    // ── JOIN on Bill Number ──────────────────────────────────────────────
    // Build item lookup map: bill_no → [item rows]
    const itemMap = {};
    for (const row of itemRows) {
      const key = pick(row, 'Bill No', 'BillNo', 'Bill Number', 'BillNumber', 'Bill_No');
      if (!key) continue;
      (itemMap[key] ??= []).push(row);
    }

    const transactions    = [];
    const pending_new_ids = [];

    for (const bill of billRows) {
      const billNo    = pick(bill, 'Bill No', 'BillNo', 'Bill Number', 'BillNumber');
      const partyCode = pick(bill, 'Party Code', 'PartyCode', 'Party_Code');
      const partyName = pick(bill, 'Party Name', 'PartyName', 'Party_Name');
      const billValue = pick(bill, 'Bill Value', 'BillValue', 'Net Amount', 'Amount');
      const pv        = pick(bill, 'P.V.', 'PV', 'Point Value', 'Points', 'PointValue');
      const date      = pick(bill, 'Date', 'Bill Date', 'BillDate');
      const taxType   = pick(bill, 'Tax Type', 'TaxType');
      const billType  = pick(bill, 'Bill Type', 'BillType');
      const buyerType = pick(bill, 'Buyer Type', 'BuyerType');

      if (!partyCode) continue;

      const id_type = partyCode.startsWith('60') ? 'display_wall' : 'ab_id';
      const known   = await isKnownPartyCode(partyCode);

      if (!known) {
        pending_new_ids.push({ partyCode, partyName, billValue, billNo });
        try {
          await sendTelegramAlert(
            tg.bot_token,
            tg.admin_chat_id,
            `⚠️ <b>Unknown RCM Party Code — nightly scrape (${dateFmt})</b>\n\n` +
            `Party Code: <code>${partyCode}</code>\n` +
            `Party Name: ${partyName}\n` +
            `Bill No: ${billNo}\n` +
            `Bill Value: ₹${billValue}\n\n` +
            `Please reply with the customer's mobile number, or confirm if this is a temporary/guest ID to skip.`
          );
          console.log(`[scraper] PENDING: ${partyCode} | ${partyName} | ₹${billValue} — Telegram alert sent ✓`);
        } catch (tgErr) {
          console.warn(`[scraper] PENDING: ${partyCode} — Telegram alert FAILED: ${tgErr.message}`);
        }
        await db.collection('pending_party_codes').doc(partyCode).set({
          party_code:  partyCode,
          party_name:  partyName,
          bill_no:     billNo,
          bill_value:  billValue,
          scrape_date: dateFmt,
          status:      'pending',
          alerted_at:  new Date().toISOString(),
        }).catch(e => console.warn(`[scraper] pending_party_codes/${partyCode} write failed: ${e.message}`));
        continue;
      }

      transactions.push({
        bill_no:    billNo,
        date,
        party_code: partyCode,
        party_name: partyName,
        tax_type:   taxType,
        pv,
        bill_value: billValue,
        bill_type:  billType,
        buyer_type: buyerType,
        id_type,
        items:      itemMap[billNo] ?? [],
      });
    }

    // ── SUMMARY ──────────────────────────────────────────────────────────
    console.log('\n[scraper] ══════════════════════════════════════════');
    console.log(`[scraper] Scraped date:              ${dateFmt}`);
    console.log(`[scraper] Total bills parsed:        ${billRows.length}`);
    console.log(`[scraper] Transactions (known IDs):  ${transactions.length}`);
    console.log(`[scraper] Pending new IDs:           ${pending_new_ids.length}`);
    if (pending_new_ids.length) {
      pending_new_ids.forEach(p =>
        console.log(`[scraper]   → ${p.partyCode} | ${p.partyName} | Bill ${p.billNo} | ₹${p.billValue}`)
      );
    }
    console.log('[scraper] ══════════════════════════════════════════\n');

    // ── STATUS: scrape succeeded ─────────────────────────────────────────
    await sendTelegramAlert(tg.bot_token, tg.admin_chat_id,
      `✅ ST-APEX: Scrape complete for ${dateFmt}. ` +
      `${transactions.length} transaction(s) found, ` +
      `${pending_new_ids.length} new ID(s) need your confirmation.`
    ).catch(e => console.warn('[scraper] Telegram success-alert failed:', e.message));

    return { transactions, pending_new_ids };

  } catch (err) {
    // Screenshot the failure state before dying
    if (page) {
      const screenshotPath = path.join(DOWNLOADS_DIR, `error-screenshot-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      console.error(`[scraper] Error screenshot → ${screenshotPath}`);
    }
    if (browser) await browser.close().catch(() => {});

    // ── STATUS: scrape failed ─────────────────────────────────────────
    await sendTelegramAlert(tg.bot_token, tg.admin_chat_id,
      `❌ ST-APEX: Scrape FAILED for ${dateFmt} — ${err.message}. ` +
      `Check the error screenshot in pipeline/downloads/.`
    ).catch(() => {});

    throw err;
  }
}

// ── Retry engine ───────────────────────────────────────────────────────────────

const MAX_ATTEMPTS   = 8;
const RETRY_DELAY_MS = 30 * 60 * 1000; // 30 minutes

let _retryTimer   = null;
let _retryAborted = false;

// Call this to cancel any pending retry wait (e.g. when Adnan supplies data manually).
function markManuallyResolved() {
  _retryAborted = true;
  if (_retryTimer !== null) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  console.log('[scraper] Retry loop cancelled via markManuallyResolved()');
}

// Wraps any scrape function with automatic retry-on-failure logic.
// scrapeFn   — defaults to scrapeYesterdaySales; override in tests
// maxAttempts — defaults to MAX_ATTEMPTS (8)
// retryDelayMs — defaults to RETRY_DELAY_MS (30 min); reduce in tests
async function scrapeWithRetry({
  scrapeFn     = scrapeYesterdaySales,
  maxAttempts  = MAX_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  _retryAborted = false;

  const { formatted: dateFmt } = getYesterday();
  const delayLabel = retryDelayMs < 60_000
    ? `${Math.round(retryDelayMs / 1000)} seconds`
    : `${Math.round(retryDelayMs / 60_000)} minutes`;
  const totalLabel = retryDelayMs < 60_000
    ? `${Math.round((maxAttempts * retryDelayMs) / 1000)} seconds`
    : `${Math.round((maxAttempts * retryDelayMs) / (1000 * 60 * 60))} hours`;

  let tg;
  try {
    tg = await getCredential('telegram_bot');
  } catch (e) {
    console.warn('[scraper] Could not load Telegram creds for retry alerts:', e.message);
    tg = null;
  }

  const alert = async (text) => {
    if (!tg) return;
    await sendTelegramAlert(tg.bot_token, tg.admin_chat_id, text)
      .catch(e => console.warn('[scraper] Telegram retry-alert failed:', e.message));
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (_retryAborted) {
      console.log('[scraper] Retry loop aborted by markManuallyResolved()');
      return;
    }

    console.log(`\n[scraper] ── Attempt ${attempt} / ${maxAttempts} ─────────────────────`);

    try {
      const result = await scrapeFn();
      console.log(`[scraper] Attempt ${attempt} succeeded ✓`);
      return result;
    } catch (err) {
      console.error(`[scraper] Attempt ${attempt} failed: ${err.message}`);

      if (attempt >= maxAttempts) {
        const finalMsg =
          `🚨 ST-APEX: Scrape failed ${maxAttempts} times over ${totalLabel}. ` +
          `Manual intervention needed.`;
        console.error('[scraper]', finalMsg);
        await alert(finalMsg);
        throw err;
      }

      const retryMsg =
        `❌ ST-APEX: Scrape failed (attempt ${attempt}/${maxAttempts}), ` +
        `retrying in ${delayLabel} — ${err.message}`;
      console.log('[scraper]', retryMsg);
      await alert(retryMsg);

      // Interruptible wait — clearTimeout fires immediately if markManuallyResolved() is called
      await new Promise((resolve) => {
        _retryTimer = setTimeout(() => { _retryTimer = null; resolve(); }, retryDelayMs);
      });

      if (_retryAborted) {
        console.log('[scraper] Retry loop aborted during wait period');
        return;
      }
    }
  }
}

module.exports = { scrapeYesterdaySales, scrapeWithRetry, markManuallyResolved };

if (require.main === module) {
  scrapeWithRetry()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('\n[scraper] FATAL:', err.message);
      process.exit(1);
    });
}
