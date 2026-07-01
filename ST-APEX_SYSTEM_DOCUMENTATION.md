# ST-APEX System Documentation

This document describes exactly what the ST-APEX codebase does today, verified by reading every source file. Nothing here is guessed or extrapolated from naming conventions — every claim is backed by a specific file and line. The running example throughout is **Bipin Kumar**, mobile `9279686885`, the one real (non-test) customer in the live database as of this writing.

Bipin's real state at the time of writing:
- Firestore path: `customers/9279686885`
- `profile`: `{ name: "Bipin Kumar", tier: "Bronze", gender: "unknown", language: "hi", linked_ids: [{id: "60307861", type: "display_wall"}], linked_id_values: ["60307861"], magic_token: "strcm.vercel.app/d/sc8d94bu7bzi", status: "active", consecutive_months: 0, tier_threshold: null, created_by: "telegram-listener" }`
- `join_date` / `created_at`: `2026-06-29` (Firestore Timestamp)
- Only linked ID: `60307861`, tagged `display_wall` (starts with `60`)
- `customers/9279686885/ids/60307861`: `{ current_balance: 0, debt: 0 }`
- Only period doc that exists: `customers/9279686885/ids/60307861/periods/FY2627-Q2`, containing only `{ message_budget: { tier: "Bronze", max_allowed: 5, period_key: "2026-Q3", sent: 1 } }` — no `purchases`, no `target`, no `st_rupees_ledger`, no `ai_notes`
- Two real bills exist for him in the RCM scrape export (`pipeline/downloads/bill-summary-2026-06-29.xlsx`, party code `60307861`): Bill #1663, ₹1036, and Bill #1664, ₹516 (both dated 29/Jun/2026) — **neither was ever ingested into Firestore, under the old schema or the new one.** This is the ₹1552 ingestion gap referenced in the Known Gaps section — pre-launch test data, not a live-system failure.

---

## 1. Architecture Overview

ST-APEX is a Node.js system (no Python component exists anywhere in this repo — despite the term appearing in casual references, `find . -name "*.py"` returns nothing). It has three deployment surfaces:

1. **Pipeline** (`pipeline/*.js`) — runs on a VM (`strcm-apex-vm`, referenced in `pipeline/telegram-listener.js`'s `/cost` command text) via two cron jobs plus one always-on polling process. No crontab file or systemd unit exists in this repo; the schedule is documented only in comments at the top of `pipeline/run-nightly.js` and `pipeline/run-morning.js`.
2. **Dashboard** (`dashboard/`) — a Next.js app, one dynamic route (`pages/d/[token].js`), server-rendered per customer via their `magic_token`.
3. **Telegram bot** (`pipeline/telegram-listener.js`) — a long-running poll loop (`startListener()`), the human-in-the-loop for onboarding new customers and owner commands.

All Firestore access goes through `firebase-config.js` at the repo root:
```js
const admin = require('firebase-admin');
const serviceAccount = require(path.join(__dirname, 'secrets', 'firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
```
Every other file does `const { db, admin } = require('../firebase-config')` (or `./firebase-config` from the root).

---

## 2. Firestore Schema (exact, post-migration, as of the July 1 2026 restructure)

Path builders live in `pipeline/customer-schema.js`:
```js
function customerRef(mobile) { return db.collection('customers').doc(mobile); }
function idRef(mobile, id) { return customerRef(mobile).collection('ids').doc(String(id)); }
function periodRef(mobile, id, periodKey) { return idRef(mobile, id).collection('periods').doc(periodKey); }
function purchasesCol(mobile, id, periodKey) { return periodRef(mobile, id, periodKey).collection('purchases'); }
function productsCol(mobile, id, periodKey) { return periodRef(mobile, id, periodKey).collection('products'); }
function ledgerEntriesCol(mobile, id, periodKey) { return periodRef(mobile, id, periodKey).collection('st_rupees_ledger').doc('ledger').collection('entries'); }
function aiNotesCol(mobile, id, periodKey) { return periodRef(mobile, id, periodKey).collection('ai_notes'); }
```

Resulting live paths:

| Path | Written by | Read by |
|---|---|---|
| `customers/{mobile}` (`profile` map) | `telegram-listener.js:_createProfile`, `data-ingestion.js` (denormalized `last_purchase_*`), `reward-calculator.js` (`consecutive_months`) | almost everything |
| `customers/{mobile}/behavior_advice/{id}` | `telegram-listener.js:_createProfile` (created empty at onboarding) | never read anywhere in the current codebase — write-only |
| `customers/{mobile}/message_history/{auto}` | `message-writer.js` is NOT the writer here — `sender.js:sendPendingMessages` writes these, one per send attempt | `message-writer.js:_getMessageCount`, `_getRecentOpeners` (for Law L3/L8) |
| `customers/{mobile}/ids/{id}` (`current_balance`, `debt`) | `ledger-writer.js` (`applyCredit`/`applyDebit`), initialized to `{0,0}` at onboarding by `telegram-listener.js` | `reward-calculator.js`, `customer-progress.js`, dashboard `getServerSideProps` |
| `customers/{mobile}/ids/{id}/periods/{fiscalKey}` (`target`, `message_budget`, `locked`) | `reward-calculator.js` (`setPeriodTarget`, `decideDailyMessage`, `checkPeriodEndBonus`), `product-ledger.js` (patches `target.recommended_product.quantity_purchased` / `target.product_completed`) | `reward-calculator.js`, `product-ledger.js`, dashboard |
| `.../periods/{fiscalKey}/purchases/{bill_number}` | `data-ingestion.js:processTransaction` (one doc per bill); `return-processor.js` writes a negative-amount doc for returns (same bill_number, merged) | `reward-calculator.js:fetchPurchaseHistory/fetchPeriodSales`, `leaderboard.js`, dashboard |
| `.../periods/{fiscalKey}/products/{auto}` | `data-ingestion.js:processTransaction` (one doc per line item per bill) | nothing currently reads this collection back — write-only today |
| `.../periods/{fiscalKey}/st_rupees_ledger/ledger/entries/{auto}` | `ledger-writer.js:applyCredit/applyDebit` | `reward-calculator.js:fetchPeriodReturns` (filters `reason === 'goods return reversal'`), `customer-progress.js` (sums all entries for lifetime/period totals) |
| `.../periods/{fiscalKey}/ai_notes/{auto}` | `period-aggregator.js:aggregatePeriodSummary` | nothing reads this back programmatically — it's a narrative record, not consumed by any bracket math |
| `processed_bills/{bill_number}` | `data-ingestion.js` (idempotency guard, written last after all other steps succeed) | `data-ingestion.js` (checked first, before any other step) |
| `pending_party_codes/{partyCode}` | `scraper.js` (unknown party code found), `telegram-listener.js` (skip/resolve/awaiting_confirmation) | `telegram-listener.js:_processUpdate` |
| `system_credentials/{category}` | `vault-write.js:saveCredential` (via `setup-credentials.js`, `update-telegram-creds.js`) | `vault-read.js:getCredential` — every module that needs a secret |
| `system_cache/whatsapp_templates` | `template-cache.js:getApprovedTemplates`/`refreshTemplateCache` | `message-writer.js:writeMessage` |
| `send_queue/{auto}` (`status: pending/sent/dry_run/failed/unsubscribed`) | `message-writer.js:writeMessage` (creates as `pending`) | `sender.js:sendPendingMessages` (reads `status==pending`, updates status) |
| `system/config` (`launch_date`) | `pipeline/system-config.js:setLaunchDate` (via the new `/setlaunchdate` Telegram command) | `pipeline/system-config.js:getLaunchDate`, read by every reward-eligibility gate (see §7) |
| `system_test/{docId}` | `firebase-config.js:testFirestoreConnection` (manual connectivity test only) | itself, immediately after writing |

Bipin's concrete example under this schema: `customers/9279686885/ids/60307861/periods/FY2627-Q2` exists as a document (addressable because it has the `message_budget` field set directly on it), but its `purchases` subcollection is empty and it has no `target` field.

---

## 3. Every Worker

### 3.1 `pipeline/scraper.js` — RCM portal scraper (Playwright)
- **Trigger**: called from `run-nightly.js` step 1, or manually via `node pipeline/scraper.js`.
- **What it does**: launches Microsoft Edge via Playwright (`chromium.launch({ channel: 'msedge', headless: false })` — Chromium/Chrome channel is explicitly noted to fail login), logs into `https://pos2.rcmworld.com` with credentials from the vault (`rcm_login`), navigates Reports → Sales → Sales View, sets an Ant Design date-range picker to yesterday (with a hard safety check that re-reads both input values and throws if they don't match the computed date), and downloads two Excel exports: **Bill Summary** and **Item Detail** (via "Export Bill Item").
- **Parsing**: `parseXlsx()` reads row 3 onward (rows 0–2 are title/store/period metadata). Items are joined to bills by `Bill No` into an `itemMap`.
- **Party code resolution**: for every bill, `isKnownPartyCode(partyCode)` checks `customers` where `profile.linked_id_values array-contains partyCode`. Unknown codes are written to `pending_party_codes/{partyCode}` with `status: 'pending'` and trigger a Telegram alert to the admin asking for the customer's mobile number.
- **`id_type`** is derived purely by prefix: `partyCode.startsWith('60') ? 'display_wall' : 'ab_id'`.
- **Output**: `{ transactions: [...], pending_new_ids: [...] }`, where each transaction carries `bill_no, date, party_code, party_name, tax_type, pv, bill_value, bill_type, buyer_type, id_type, items`.
- **Retry engine**: `scrapeWithRetry({ scrapeFn, maxAttempts=8, retryDelayMs=30min })` — retries on any thrown error, sends a Telegram alert on every attempt and a final "manual intervention needed" alert after exhausting attempts. `markManuallyResolved()` cancels the pending retry timer (e.g. if Adnan supplies data by hand).
- Bipin's example: this is exactly the script that produced `pipeline/downloads/bill-summary-2026-06-29.xlsx`, containing his two real bills — but the corresponding `data-ingestion.js` run that should have consumed that export never ran (or ran and the bills were never turned into `processTransaction` calls); no `processed_bills/{1663}` or `processed_bills/{1664}` doc exists.

### 3.2 `pipeline/data-ingestion.js` — per-transaction processor
- **Trigger**: `ingestTransactions(transactionsArray)`, called from `run-nightly.js` step 2 with the scraper's `transactions` array.
- **Per-transaction steps** (`processTransaction(tx)`, in exact order):
  1. **Idempotency**: skip if `processed_bills/{bill_number}` already exists.
  2. **Customer resolution**: `resolveMobile(partyCode)` queries `customers` where `profile.linked_id_values array-contains partyCode`. No match → Telegram alert, transaction dropped (no credit, no log entry).
  3. **Layer 1 base reward**: `calculateBaseReward(mobile, id_used, bill_number, amount, parsedDate)` — always runs (subject to the launch-date gate, see §7).
  4. **Product ledger**: `updateProductLedger(mobile, id_used, tx.items)` — no-op for AB IDs.
  5. **Purchases log**: one doc per bill written to `purchasesCol(mobile, id_used, periodKey)`.
  6. **Products log**: one doc per line item written to `productsCol(mobile, id_used, periodKey)`.
  7. **Profile denormalization**: `customerRef(mobile).set({ profile: { last_purchase_date, last_purchase_amount } }, { merge: true })`.
  8. **Mark processed**: `processed_bills/{bill_number}` written last, only after every prior step succeeds.
- **Accumulator**: returns `{ processedMobiles: Map<mobile, totalAmountToday> }`, consumed by `runNightlyRewardChecks` to decide who gets a `decideDailyMessage` pass tonight.
- Layer 2/3 (period-end bonuses) are **not** computed here — deferred entirely to `checkPeriodEndBonus`.

### 3.3 `pipeline/base-reward-calculator.js` — Layer 1 (guaranteed 1%)
```js
async function calculateBaseReward(mobile, id_used, bill_number, sale_amount, date = new Date()) {
  const launchDate = await getLaunchDate();
  if (!launchDate || date < launchDate) {
    return { baseAmount: 0, ledgerResult: null };
  }
  const storeCode = await _getRcmStoreCode();
  if (storeCode && String(id_used) === String(storeCode)) {
    return { baseAmount: 0, ledgerResult: null }; // ST Rupees redemption bill — excluded
  }
  const baseAmount = Math.floor(sale_amount * 0.01);
  if (baseAmount <= 0) return { baseAmount: 0, ledgerResult: null };
  const ledgerResult = await applyCredit(mobile, id_used, baseAmount, 'base (guaranteed)', bill_number, date);
  return { baseAmount, ledgerResult };
}
```
No budget ceiling, no eligibility check beyond the launch-date gate and the ST-Rupees-store-code exclusion. Runs on every single bill, unconditionally.

### 3.4 `pipeline/product-ledger.js` — Display Wall product-completion tracker
- No-ops immediately unless `idType(id_used) === 'display_wall'`.
- Reads the *current* period's `target.recommended_product` (a manually-set field — nothing in the codebase writes `recommended_product`; per the code comment, "Adnan sets manually").
- Matches item rows to `recommended_product.product_name` via `_namesMatch()`, a case-insensitive **bidirectional substring match** (chosen specifically because RCM POS exports may abbreviate/differently-case item names — an exact match would silently miss e.g. `"NITRI CHARGED"` vs `"Nitri Charged Man"`).
- Increments `target.recommended_product.quantity_purchased`; flips `target.product_completed = true` once `quantity_purchased >= quantity_required` (a one-way flip — never resets even if `quantity_purchased` later exceeds the requirement further).
- Writes via a single targeted `periodDoc.update({...})` call — never overwrites the rest of `target`.

### 3.5 `pipeline/reward-calculator.js` — the core bracket engine
Three public entry points, orchestrated nightly by `runNightlyRewardChecks`:

**`setPeriodTarget(customerId, salesDate)`** — runs only on days 1–5 of a new period (`getDayOfPeriod(today, isDW) <= 5`), idempotent (skips if `target` already exists for the period). Before computing the new target, it pays any missed period-end bonus for the *prior* period (`checkPeriodEndBonus` wrap-up call) if that period had a target and isn't locked yet.

**`decideDailyMessage(customerId, todaysPurchaseAmount, salesDate)`** — the **only** function in this file that calls Sonnet. Runs only for customers present in tonight's `processedMobiles` map (i.e. had an actual sale). Checks the message budget *before* calling Claude (zero API cost when exhausted):
```js
const budget = periodSnap.exists ? (periodSnap.data().message_budget ?? null) : null;
const sentThisPeriod = budget?.sent ?? 0;
const maxAllowed = _getBudgetMax(profile, isDW); // TIER_MESSAGE_BUDGET or DW_QUARTERLY_BUDGET(5)
if (sentThisPeriod >= maxAllowed) return { skipped: true, reason: `message budget exhausted (...)` };
```
`TIER_MESSAGE_BUDGET = { 'VIP Gold': 6, 'Gold': 6, 'Silver': 10, 'Saathi': 12 }`; `DW_QUARTERLY_BUDGET = 5`. Note: Bipin's tier is `Bronze`, which is **not a key in `TIER_MESSAGE_BUDGET`** — but he's DW, so `_getBudgetMax` returns `DW_QUARTERLY_BUDGET = 5` regardless (matches his live `message_budget.max_allowed: 5`). If Bipin were ever reclassified as AB ID, `TIER_MESSAGE_BUDGET['Bronze']` would be `undefined`, falling through to the `?? 12` default.

**`checkPeriodEndBonus(customerId, salesDate)`** — runs on the last 1–2 days of a period (`daysUntilPeriodEnd <= 1`), idempotent via `locked: true`. Computes `genuineSales = rawSales - returns` (via `fetchPeriodSales` minus `fetchPeriodReturns`, excluding the ST-Rupees store code), calls `period-aggregator.js` (a Gemini call, narration-only, not a decision point), then applies the bracket formula (§5) and credits via `ledger-writer.js:applyCredit`.

**`runNightlyRewardChecks(processedMobiles, salesDate)`** — orchestrator, called from `run-nightly.js` step 3. Iterates every doc in `customers`, running `setPeriodTarget`/`checkPeriodEndBonus` where the date window matches, then runs `decideDailyMessage` only for mobiles in tonight's batch. Returns `{ briefings: [...] }` for `run-nightly.js` to hand to `message-writer.js`.

### 3.6 `pipeline/period-aggregator.js` — Gemini narration pass
Called from inside `checkPeriodEndBonus`, **not** a decision point — the code comment is explicit that this "is NOT a Sonnet/Claude call site" and that "Gemini is never asked to compute [numbers], only to narrate them into `ai_notes`". Prompt:
```js
[
  "Write a one-sentence plain-English summary of this customer's period activity.",
  "Return ONLY a JSON object — no markdown, no text outside the braces.",
  "Do NOT recompute any numbers — use exactly the figures given below.",
  "", `Raw sales this period   : Rs ${rawSales}`, `Returns this period     : Rs ${returns}`,
  `Genuine sales (raw - returns): Rs ${genuineSales}`, "",
  'Return: {"summary":"<one sentence>"}',
].join('\n')
```
Model: `gemini-2.5-flash-lite`, via `@google/genai` in Vertex AI mode (`project: 'strcm-apex-500420', location: 'us-central1'`). The bracket math downstream reads the *input* `genuineSales` it was given, not anything Gemini returns — Gemini's only writable effect is the `summary` string and the `ai_notes` doc itself.

### 3.7 `pipeline/message-writer.js` — Gemini message composer
- **Trigger**: `writeMessage(briefingObject)`, called from `run-nightly.js` step 4 for every non-skipped briefing from `decideDailyMessage`, and directly by `send-real-welcome.js` for manual welcome sends.
- Checks `profile.unsubscribed === true` first — skips silently if so.
- Fetches approved WhatsApp templates via `template-cache.js`; throws if none are cached/fetchable.
- Builds a prompt containing **25 numbered "Writing Laws"** (Devanagari Hindi, banned words, no urgency language, exactly one emoji max, opener-uniqueness against the customer's last 5 message openers, etc.) plus the customer briefing and the approved-template list, and calls Gemini (`gemini-2.5-flash-lite`, same Vertex project) with `responseMimeType: 'application/json'`.
- Generates a magic token (`_generateMagicToken()` — 12 random base-36 chars) and persists it to `profile.magic_token`.
- Writes the result to `send_queue` with `status: 'pending'`. Sending itself happens later, in `sender.js`, run separately at 8 AM.

### 3.8 `pipeline/sender.js` — Meta WhatsApp Cloud API sender
- **Trigger**: `sendPendingMessages({ dryRun })`, called from `run-morning.js` (8 AM cron) or manually.
- Reads all `send_queue` docs with `status == 'pending'`. Re-checks `unsubscribed` status at send time (not just at write time).
- Real send: `_sendWhatsAppTemplate` POSTs to `https://graph.facebook.com/v21.0/{phone_number_id}/messages` with `Authorization: Bearer {access_token}`, `to: "91{mobile}"`, `type: "template"`. Captures `apiResponse.messages?.[0]?.id` as `wamid`.
- Dry-run mode logs the exact payload that *would* be sent and writes `status: 'dry_run'` instead of calling Meta.
- On success: updates `send_queue` doc to `status: 'sent'` (or `'dry_run'`) and appends to `customers/{mobile}/message_history`.
- On failure: `status: 'failed'`, error message stored, Telegram alert sent to the admin.
- Also exports `handleStopReply(mobile)` — marks `profile.unsubscribed = true` and alerts the admin. (Nothing currently wires an inbound WhatsApp "STOP" webhook to this function — it exists but has no caller in this codebase; it would need to be invoked from a webhook handler that doesn't exist yet.)

### 3.9 `pipeline/telegram-listener.js` — Telegram bot (long-poll)
- **Trigger**: `startListener()` — an infinite `while(true)` loop, long-polling `getUpdates` every 30 seconds (`offset`-based, tracks `_lastUpdateId`).
- **`/cost`** — owner-only (`chatId !== tg.admin_chat_id` → silent no-op). Reports honestly that no spend tracking is instrumented anywhere, and lists exactly what would need to be added per API (Sonnet, Gemini, WhatsApp, Firebase, server).
- **`/setlaunchdate YYYY-MM-DD`** — owner-only (new, this session). Validates the date format, calls `system-config.js:setLaunchDate`, and replies confirming the new gate is active. With no/invalid argument, replies with current `launch_date`.
- **Reply-to-alert flow** (onboarding a new customer from an unknown-party-code alert): extracts the party code from the alert text, then branches on the reply:
  - `skip`/`s` → marks `pending_party_codes/{code}` as `status: 'skipped'`.
  - Compound reply (`"Party Code X Mobile Y"`, for voice-to-text) → parsed via regex, uses the compound values (warns if the compound party code differs from the alert's).
  - 10-digit non-`60`-prefixed code → flagged as a "Reference ID" needing explicit `YES` confirmation (never auto-created).
  - Otherwise parses a mobile number (`_parseMobile` — accepts optional `+91`/`91` prefix, requires a valid 10-digit Indian mobile starting 6–9).
  - Verifies `pending_party_codes/{code}.status === 'pending'` still holds, then calls `_createProfile(mobile, partyCode, partyName)`.
- **`_createProfile`**: calls Gemini (`gemini-2.5-flash-lite`) once to infer gender + a cleaned name from the raw party name, then writes the full `profile` map, initializes `customers/{mobile}/ids/{partyCode}` to `{current_balance: 0, debt: 0}`, and creates an empty `behavior_advice/{partyCode}` doc.

### 3.10 `pipeline/customer-progress.js` — live progress aggregation (read-only, no writes)
`getCustomerProgress(mobile)` computes, **fresh on every call, never cached/stored**:
- `lifetime.earned` / `lifetime.redeemed` — sums every `credit`/`debit` entry across **every** period folder, for every linked ID matching the customer's type (AB or DW). Append-only log, never reset.
- `lifetime.balance` — sum of `current_balance` across the customer's matching-type IDs (read directly off the id-level doc, not recomputed from entries).
- `currentPeriod.earned` / `currentPeriod.spent` — same sum, scoped to just the current period's folder.
- This is the module that answers "what is this customer's lifetime total" — there is no separate stored `lifetime_earned`/`lifetime_redeemed` field anywhere in the live schema (see Known Gaps for where that field name *does* appear, in a stale reference file).
- For Bipin: `getCustomerProgress('9279686885')` returns `lifetime: {earned: 0, redeemed: 0, balance: 0}` today, because his one existing period folder (`FY2627-Q2`) has no `st_rupees_ledger` entries at all.

### 3.11 `pipeline/leaderboard.js` — live ranking (read-only, no writes, no cache)
`getLeaderboards()`, computed fresh on every call:
- **AB leaderboard**: ranked by **cumulative PV across all periods, all time** (`totalPv += Number(p.data().pv ?? 0)` over every purchase doc in every period folder). Top 10 only.
- **DW leaderboard**: ranked by **current-quarter purchase amount only** (`purchasesCol(mobile, li.id, dwStorageKey)`, summed).
- Customers with zero total are excluded entirely from their respective leaderboard (`if (total > 0) ...`).
- Bipin (DW, current-period purchases = 0) would not currently appear on the DW leaderboard at all.

### 3.12 `pipeline/ledger-writer.js` — the only place `current_balance`/`debt` are mutated
`applyCredit(mobile, id_used, amount, reason, bill_number, date)` — runs inside a Firestore transaction. If `debt > 0`, repays debt first (partial or full), logging a separate `'credit'`/`'debt repayment'` entry; any remainder credits `current_balance` with a `'credit'` entry under the given `reason`. Balance is clamped to never go negative.

`applyDebit(mobile, id_used, amount, reason, bill_number, date)` — debits `current_balance` first; anything beyond the available balance becomes new `debt` rather than a negative balance.

Both route the ledger-entry log through `fiscalPeriodKey(date, idType(id_used) === 'display_wall')`, so entries always land in the period folder matching the *transaction* date, not "today".

### 3.13 `pipeline/return-processor.js` — goods-return reversal (built but never wired in — see Known Gaps)
`processGoodsReturn(mobile, id_used, bill_number, purchase_date, original_credit_amount)` — rejects returns more than 30 days after purchase; otherwise calls `applyDebit(..., 'goods return reversal', ...)` and writes a negative-amount purchases-log doc for the same `bill_number`. **This function is never called from any live entry point** (`run-nightly.js`, `run-morning.js`, `data-ingestion.js`, and `telegram-listener.js` all lack any reference to it) — it only exists in its own file and in its own test.

### 3.14 `pipeline/system-config.js` — launch-date gate (new, this session)
`getLaunchDate()` reads `system/config.launch_date`, returns `null` if unset (never defaults to "today"). `setLaunchDate(dateStr)` validates `YYYY-MM-DD` format and writes it. See §7 for every place this gates behavior.

### 3.15 `pipeline/template-cache.js` — WhatsApp template cache
`getApprovedTemplates()` — checks `system_cache/whatsapp_templates` first; if unexpired (24h TTL), returns the cached array. On miss, fetches from `https://graph.facebook.com/v21.0/{waba_id_production}/message_templates` (paginating via `data.paging.next`), filters to `status === 'APPROVED'`, strips fields Firestore can't store (`example`, which contains nested arrays), and re-caches. `refreshTemplateCache()` forces a re-fetch (intended to be called after a template gets approved in Meta's dashboard).

### 3.16 `pipeline/run-nightly.js` / `pipeline/run-morning.js` — cron entry points
- `run-nightly.js`: intended to fire at 12:05 AM IST (`Cron: 35 18 * * *` UTC, per the file's own header comment — no actual crontab exists in this repo). Chain: `scraper → data-ingestion → reward-calculator.runNightlyRewardChecks → message-writer.writeMessage` (once per briefing).
- `run-morning.js`: intended to fire at 8:00 AM IST (`Cron: 30 2 * * *` UTC). Just calls `sender.sendPendingMessages()`.
- The 8-hour gap between nightly processing and morning sends is deliberate — messages are queued overnight and physically sent only in the morning.

### 3.17 `pipeline/send-real-welcome.js` — manual one-off welcome-message CLI
`node pipeline/send-real-welcome.js <mobile>` — reads the customer, builds a fixed `tone_needed: 'warm_welcome'` briefing, calls `writeMessage` then `sendPendingMessages({dryRun: false})` immediately (bypassing the overnight queue delay). Explicitly commented as "ONLY run this for customers who have already been created via telegram-listener... Never run for bulk sends."

### 3.18 `pipeline/message-decider.js` — dead stub, not implemented
```js
async function decideMessageNeeded(customer) {
  console.log('[message-decider] - not yet implemented');
  return { success: true, step: 'message-decider', customerId: customer?.mobile ?? null, messageNeeded: false, reason: 'placeholder' };
}
```
Not required by `run-nightly.js`, `run-morning.js`, or any test. The real message-needed decision is made by `reward-calculator.js:decideDailyMessage` (the Sonnet call) — this file appears to be an early scaffold that was superseded and never removed.

### 3.19 Vault / credentials (`vault-read.js`, `vault-write.js`, `config/vault-crypto.js`, `config/credentials-schema.js`)
- `config/vault-crypto.js`: AES-256-GCM, key stored at `secrets/vault-key.txt` (auto-generated 32-byte hex on first use if missing, file mode `0o600`).
- `config/credentials-schema.js`: defines the five known credential categories — `rcm_login`, `whatsapp_api`, `telegram_bot`, `gemini_api`, `anthropic_api` — with required-field validation.
- `vault-write.js:saveCredential(category, data)` encrypts and writes to `system_credentials/{category}`.
- `vault-read.js:getCredential(category)` reads and decrypts. Throws if the doc doesn't exist or has no `encrypted` payload.
- `setup-credentials.js` / `update-telegram-creds.js` — interactive CLI scripts (readline-based, with masked password input) for populating the vault by hand.
- `test-vault.js` — round-trip write/read/compare test against a throwaway `test_category` credential.

### 3.20 Dashboard (`dashboard/`)
- **`pages/d/[token].js`** — the only route. `getServerSideProps({ params: { token } })`:
  1. Queries `customers` where `profile.magic_token == token`, `limit(1)`. 404 (`notFound: true`) if no match.
  2. Splits `profile.linked_ids` into `abIds`/`dwIds` by `type`.
  3. Computes both AB (monthly) and DW (quarterly) `fiscalPeriodKey` for "now", in parallel fetches: id-level ledger docs (`idRef(...).get()`), this-period purchases (`purchasesCol(...).get()`), and this-period target docs.
  4. Sums `current_balance` across all linked IDs into `available`.
  5. Computes `abPct`/`dwPct` as `min(round(purchases/threshold*100), 100)`.
  6. Reads `target.recommended_product` for the DW product-bonus card.
  7. Calls `getCustomerProgress(mobile)` for `lifetimeEarned`/`lifetimeRedeemed`.
  8. Passes a single `data` object as page props.
  - **All Firestore reads here go through the current nested-schema helpers** (`idRef`, `purchasesCol`, `periodRef` from `customer-schema.js`) — verified in the prior session's audit: no stale flat-path reads remain.
- **`lib/v6-logic.js`** — client-side hydration. `hydrateV6Dashboard(data)` sets a specific, limited set of DOM elements by ID: customer name (both header and profile screen), lifetime/available/redeemed values, AB/DW purchase amounts and progress-bar widths, AB/DW ID numbers, product-bonus percentage. **It does not read `data.tier` or `data.joinDate` at all** — see Known Gaps.
- **`lib/v6-html.js`** — one giant template-literal string (`PHONE_HTML`) containing the entire phone-mockup markup for all 5 screens (home, coins/ledger, leaderboard, profile, referral-welcome), in both English and Hindi (via `id`-keyed spans swapped by `applyLang()`/`tL()`). Most of this content — the leaderboard rows (hardcoded names like "Anil Kumar", "Priya Singh"), the ledger transaction history (`ld1`–`ld9`, hardcoded dates and bill numbers), the tier badge text, the "FOR YOU" personalized message, the referral count — is **static demo content that `hydrateV6Dashboard` never overwrites**. Only the specific fields listed above are wired to real data.
- **`lib/v6-css.js`** — plain CSS injected via `<style jsx global>`.
- **`pages/_app.js`** — trivial Next.js App wrapper; sets a fixed, non-scalable viewport meta tag.

---

## 4. Every Connection (what waits for what, what reads what another piece wrote)

```
scraper.js (Playwright → RCM portal)
  └─ writes: pending_party_codes (unknown IDs), pipeline/downloads/*.xlsx
  └─ returns transactions[] to →

data-ingestion.js (per bill, in order)
  ├─ reads: processed_bills (idempotency), customers (resolveMobile)
  ├─ calls: base-reward-calculator.js → ledger-writer.js (writes ids/{id}, st_rupees_ledger entries)
  ├─ calls: product-ledger.js (patches periods/{key}.target.recommended_product, DW only)
  ├─ writes: periods/{key}/purchases/{bill}, periods/{key}/products/*, customers/{mobile}.profile (denorm)
  ├─ writes: processed_bills/{bill} (last)
  └─ returns processedMobiles Map to →

reward-calculator.js:runNightlyRewardChecks
  ├─ gates on system-config.js:getLaunchDate() (new)
  ├─ setPeriodTarget (days 1-5): reads fetchPurchaseHistory (periods/*/purchases), writes periods/{key}.target
  ├─ checkPeriodEndBonus (last 1-2 days): reads fetchPeriodSales/fetchPeriodReturns,
  │     calls period-aggregator.js (Gemini → writes periods/{key}/ai_notes),
  │     calls ledger-writer.js:applyCredit (writes ids/{id}, st_rupees_ledger entries),
  │     writes periods/{key}.target.bracket/bonus_rs/locked=true
  └─ decideDailyMessage (tonight's batch only): calls Sonnet directly (_callClaude),
        writes periods/{key}.message_budget, returns briefings[] to →

message-writer.js:writeMessage (per briefing)
  ├─ reads: customers/{mobile}.profile.unsubscribed, message_history (for L3/L8),
  │         template-cache.js:getApprovedTemplates (system_cache/whatsapp_templates,
  │           which itself may call Meta's Graph API on cache miss)
  ├─ calls Gemini (message text + template selection)
  ├─ writes: customers/{mobile}.profile.magic_token, send_queue/{new} (status:pending)
  └─ (queued — sending deferred to next morning)

sender.js:sendPendingMessages (run-morning.js, 8 AM)
  ├─ reads: send_queue where status==pending
  ├─ re-checks: customers/{mobile}.profile.unsubscribed
  ├─ calls Meta Graph API (real send) or logs dry-run payload
  └─ writes: send_queue status update, customers/{mobile}/message_history/{new}

telegram-listener.js (independent, always-on poll loop)
  ├─ reads/writes: pending_party_codes (onboarding flow)
  ├─ calls Gemini (gender/name inference) → writes customers/{mobile} (new profile), ids/{id} (init balance)
  └─ /setlaunchdate → system-config.js:setLaunchDate → system/config

dashboard (pages/d/[token].js, on every page load)
  ├─ reads: customers (by magic_token), ids/{id}, periods/{key} (purchases + target)
  ├─ calls: customer-progress.js:getCustomerProgress (reads every period's ledger entries)
  └─ (read-only — never writes anything)
```

---

## 5. Every Calculation, Quoted Verbatim

### 5.1 Base reward (Layer 1) — `pipeline/base-reward-calculator.js`
```js
const baseAmount = Math.floor(sale_amount * 0.01);
```
Guaranteed 1% of every genuine sale (ST-Rupees-store-code bills excluded), no ceiling of its own, subject only to the launch-date gate.

### 5.2 AB ID cold-start — `pipeline/reward-calculator.js:setPeriodTarget`
Cold-start trigger:
```js
const isInactive12 = realPeriods.length > 0 && (() => {
  const lastPeriod = realPeriods[realPeriods.length - 1].period;
  const cutoff = new Date(today.getFullYear() - 1, today.getMonth(), 1);
  return new Date(lastPeriod + '-01') < cutoff;
})();
const isColdStart = realPeriods.length < 3 || isInactive12;
const coldStartMonth = isColdStart ? Math.min(realPeriods.length + 1, 3) : null;
```
Month 1: `targetAmount = 0` ("no target, 1% only"). Month 2: `targetAmount = m1Total + 200`. Month 3: `targetAmount = m2Total + 200`.

### 5.3 AB ID full rolling-average system — `setPeriodTarget`
```js
const raw3 = realPeriods.slice(-3).map(h => h.total);
const rawAvg = raw3.reduce((a, b) => a + b, 0) / 3;
const floored3 = raw3.map(t => Math.max(t, Math.round(rawAvg * 0.80))); // 80% anti-sandbagging floor
const rollingAvg = Math.round(floored3.reduce((a, b) => a + b, 0) / 3);
const missedThreshold = Math.round(rollingAvg * 0.90);
const growthThreshold = Math.round(rollingAvg * 1.05);
```

### 5.4 AB ID bracket bonus — `checkPeriodEndBonus`
```js
if (genuineSales < missedThreshold) { bracket = 'missed'; bonusRs = 0; }
else if (genuineSales < growthThreshold) { bracket = 'maintenance'; bonusRs = Math.floor(genuineSales * 0.005); } // +0.5% → 1.5% total
else { bracket = 'growth'; bonusRs = Math.floor(genuineSales * 0.015); } // +1.5% → 2.5% total
```
Cold-start months 2–3 use a binary hit/miss against the ramp target instead: hit → `Math.floor(genuineSales * 0.005)` (maintenance bracket), miss → 0.

### 5.5 AB ID loyalty top-up — `checkPeriodEndBonus`
```js
const newConsecutive = bracket === 'missed' ? 0 : prevConsecutive + 1;
if (bracket !== 'missed' && newConsecutive % 3 === 0) {
  const combined3 = rawSales + prev2Total; // this period + prior 2 periods' raw totals
  loyaltyTopupRs = Math.floor(combined3 * 0.005);
}
```
Fires every 3rd consecutive non-missed period.

### 5.6 Absolute 3% ceiling (AB ID) — `checkPeriodEndBonus`
```js
const totalBonus = bonusRs + loyaltyTopupRs;
const l1Estimate = Math.floor(genuineSales * 0.01);
const abs3pct = Math.floor(genuineSales * 0.03);
if (l1Estimate + totalBonus > abs3pct) {
  const allowed = Math.max(0, abs3pct - l1Estimate);
  bonusRs = Math.floor(bonusRs * allowed / totalBonus);
  loyaltyTopupRs = Math.floor(loyaltyTopupRs * allowed / totalBonus);
}
```

### 5.7 Display Wall new-account onboarding target — `setPeriodTarget`
```js
const isNewAccount = realQuarters.length < 3;
const baselineAvg = realQuarters.length > 0 ? realQuarters.reduce((s,h)=>s+h.total,0)/realQuarters.length : 0;
const targetAmount = Math.round(baselineAvg * 1.08); // 108% stretch
```

### 5.8 Display Wall full system — `setPeriodTarget`
```js
const raw3 = realQuarters.slice(-3).map(h => h.total);
const rawAvg = raw3.reduce((a,b)=>a+b,0) / 3;
const floored3 = raw3.map(t => Math.max(t, Math.round(rawAvg * 0.70))); // 70% floor (DW ≠ AB's 80%)
const rollingAvg = Math.round(floored3.reduce((a,b)=>a+b,0) / 3);
const growthThreshold = Math.round(rollingAvg * 1.10); // 110%
```

### 5.9 Display Wall bracket bonus — `checkPeriodEndBonus`
```js
if (dwGenuineSales < dwGrowthThresh) { dwBracket = 'missed'; dwBonusRs = 0; }
else if (productDone) { dwBracket = 'growth_with_product'; dwBonusRs = Math.floor(dwGenuineSales * 0.02); }  // +2% → 3% total
else { dwBracket = 'growth'; dwBonusRs = Math.floor(dwGenuineSales * 0.015); }  // +1.5% → 2.5% total
```
Same 3% absolute ceiling applied, no loyalty top-up for DW (explicitly noted in the code comment: "No loyalty top-up for DW. No consecutive_months tracking for DW.").

### 5.10 PV / leaderboard ranking — `pipeline/leaderboard.js`
AB: `totalPv += Number(p.data().pv ?? 0)` summed across every purchase doc, every period, all time. DW: `total += Number(p.data().amount ?? 0)` summed across current-quarter purchase docs only. Both `.slice(0, 10)` after descending sort.

### 5.11 Period-reset progress — `pipeline/customer-progress.js`
```js
lifetimeEarned += (entry.type === 'credit' ? amount : 0);   // across EVERY period folder, ever
lifetimeRedeemed += (entry.type === 'debit' ? amount : 0);
periodEarned += (entry.type === 'credit' ? amount : 0);     // just this period's folder
periodSpent += (entry.type === 'debit' ? amount : 0);
```
Both computed fresh from the append-only ledger-entries log on every call — nothing is stored or cached.

### 5.12 Launch-date eligibility gate (new, this session) — `pipeline/system-config.js` + gate sites
```js
async function getLaunchDate() {
  const snap = await systemConfigRef().get();
  const raw = snap.exists ? snap.data()?.launch_date : null;
  if (!raw) return null;
  const d = new Date(`${raw}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}
```
Applied as `if (!launchDate || date < launchDate) return { skipped/baseAmount:0 }` at the top of `setPeriodTarget`, `decideDailyMessage`, `checkPeriodEndBonus`, `runNightlyRewardChecks`, and `calculateBaseReward`; and as a per-purchase filter (`if (!launchDate || dt < launchDate) continue`) inside `fetchPurchaseHistory`, `fetchPeriodSales`, `fetchPeriodReturns` — so even a purchase backfilled *after* launch, but dated *before* it, never counts.

---

## 6. Bipin Kumar — end-to-end trace of his real record

1. **Onboarding** (`telegram-listener.js:_createProfile`, `created_by: "telegram-listener"`): profile created 2026-06-29, `tier: "Bronze"`, `linked_ids: [{id: "60307861", type: "display_wall"}]`, `ids/60307861` initialized to `{current_balance: 0, debt: 0}`.
2. **Real purchases exist in the RCM export** (`bill-summary-2026-06-29.xlsx`): Bill #1663 (₹1036) and Bill #1664 (₹516), both party code `60307861`, both dated 29/Jun/2026 — **but `data-ingestion.js:processTransaction` was never run against them.** No `processed_bills/1663` or `/1664` doc exists; no `purchases` doc exists under his period folder; `ids/60307861.current_balance` is still `0`.
3. **Only Firestore write that ever landed for him post-onboarding**: `periods/FY2627-Q2.message_budget` (`{tier: 'Bronze', max_allowed: 5, period_key: '2026-Q3', sent: 1}`) — meaning `decideDailyMessage` ran for him once and Sonnet decided to send a message (consuming 1 of his 5 quarterly message-budget slots), even though there's no corresponding purchase record backing that decision in the current period folder.
4. **Dashboard** (`dashboard/pages/d/[token].js`, token `sc8d94bu7bzi`): would render `available: ₹0`, `dwPurchases: ₹0`, `dwPct: 0%`, `tier: "Bronze"` (fetched but — per the Known Gaps below — never actually displayed by `hydrateV6Dashboard`), `lifetimeEarned/Redeemed: 0` (from `customer-progress.js`, correctly reflecting the empty ledger).
5. **Leaderboard**: excluded entirely from the DW leaderboard (`total > 0` filter), since his current-quarter purchase sum is 0.
6. **Under the new launch-date gate**: with `launch_date` unset (its current live value), none of this would process even if the ingestion gap were fixed today — and if `launch_date` were set to any date after 2026-06-29, his two real bills would remain permanently excluded from reward eligibility even if later backfilled, by design.

---

## 7. Known Gaps

1. **The June 29 ingestion gap (₹1552 never ingested)** — Bipin's two real bills (#1663 ₹1036, #1664 ₹516, party code `60307861`, both dated 29/Jun/2026) exist in the scraped RCM export but were never run through `data-ingestion.js`. No `processed_bills` doc, no `purchases` doc, no ledger entry exists for either bill under either the old or new schema. **This is pre-launch test data, not a live-system failure** — the system had no formal launch date at the time, and with the new launch-date gate now in place, this data would be excluded from reward eligibility by design even if backfilled today.

2. **`return-processor.js` is built but never wired into any live entry point.** `applyDebit` (in `ledger-writer.js`) is only ever called from `processGoodsReturn`, and `processGoodsReturn` is never called from `run-nightly.js`, `run-morning.js`, `data-ingestion.js`, or `telegram-listener.js` — only from its own test file. Consequently, `reward-calculator.js:fetchPeriodReturns` (which filters ledger entries by `reason === 'goods return reversal'`) will always sum to 0 in production, because nothing ever writes an entry with that reason. `genuineSales` therefore always equals `rawSales` in live operation today.

3. **No stored `lifetime_earned`/`lifetime_redeemed` fields exist in the current live schema.** These field names appear only in `setup-schema.js` — a pre-migration reference/example script (`customerDocument.st_rupees_ledger.lifetime_earned/lifetime_redeemed`) that documents the *old* flat schema and was never updated after the July 1 restructure (it still uses plain-string `linked_ids: [RCM_ID]` instead of the tagged `[{id,type}]` shape, and a `st_rupees_ledger` map directly under the customer doc rather than the current nested-period structure). It is not read by, or wired into, any live code path. The actual live system computes lifetime totals **live, on every call**, via `pipeline/customer-progress.js` summing the append-only ledger-entries log — there is no "never updated" stored field in production; the field simply doesn't exist there at all. Worth noting as documentation debt in `setup-schema.js`, not a runtime bug.

4. **Sleeping/dormant-customer auto-detection does not exist.** A grep for `sleeping`/`dormant` across all production code finds only the "dormant freeze" comment in `setPeriodTarget`'s Display Wall path, which just excludes zero-spend quarters from the rolling average — there is no feature that flags a customer as inactive, alerts an admin, or changes their treatment based on prolonged inactivity (beyond the AB ID cold-start 12-month-inactivity re-trigger, which resets their target math but does not notify anyone or mark them specially).

5. **`pipeline/message-decider.js` is a dead placeholder stub** (`console.log('[message-decider] - not yet implemented')`, hardcoded `messageNeeded: false`). It is not required by any live entry point or test. The real message-decision logic lives in `reward-calculator.js:decideDailyMessage` — this file appears to be an earlier scaffold superseded by that function and never deleted.

6. **Dashboard hydration silently drops two server-computed fields.** `getServerSideProps` in `pages/d/[token].js` computes both `tier` and `joinDate` and includes them in the `data` object passed to the client — but `hydrateV6Dashboard` in `lib/v6-logic.js` never reads `data.tier` or `data.joinDate` anywhere in its body. The tier badge (`tBadge`, e.g. "SILVER +") and "member since" date (`mSince`) remain permanently on their hardcoded static demo values regardless of the real customer's actual tier or join date. For Bipin specifically, the dashboard would show a "SILVER +" badge despite his real tier being `Bronze`.

7. **Large portions of the dashboard UI are static demo content, never wired to real per-customer data at all**: the leaderboard rows in the "Leaderboard" screen (hardcoded names like "Anil Kumar", "Sunaina Devi", "Priya Singh"), the entire ledger transaction history list on the "ST Rupees" screen (`ld1`–`ld9`, hardcoded dates/bill numbers/amounts), the personalized "FOR YOU" message text, and the referral-count number are all baked into `lib/v6-html.js`'s template literal and are never touched by `hydrateV6Dashboard`. Only balance figures, purchase amounts, progress-bar percentages, tier-agnostic ID numbers, and the customer's name are actually live-wired.

8. **`message-history` write inconsistency**: `pipeline/message-writer.js` reads from `customers/{mobile}/message_history` (for Law L3's message-count check and Law L8's recent-openers list) but never writes to it — the only writer is `sender.js:sendPendingMessages`, which writes *after* the actual send attempt (success, dry-run, or failure). This means `writeMessage`'s message-count/opener checks are always based on prior *send* history, not prior *write/queue* history — functionally correct today (since every write is eventually sent or fails through the same queue), but worth knowing if `writeMessage` and `sendPendingMessages` are ever decoupled further.

9. **`products` subcollection is write-only.** `data-ingestion.js` writes one doc per line item to `.../periods/{key}/products/{auto}` for every bill, but no code anywhere reads this collection back. It is pure audit-log data today.

10. **`behavior_advice/{id}`** is created empty at onboarding (`telegram-listener.js:_createProfile`) and never read or written to again anywhere in the codebase.

11. **`sender.js:handleStopReply`** exists (marks a customer unsubscribed, alerts the admin) but has no caller — there is no inbound WhatsApp webhook handler in this codebase that would invoke it on a real "STOP" reply from a customer. Unsubscribing today would have to be triggered manually.

12. **Launch-date gate does not extend to `leaderboard.js` or `product-ledger.js`.** Per this session's Task 1 scope (eligibility/dormancy/cold-start checks in `reward-calculator.js` and the flat 1% in `base-reward-calculator.js`), the launch-date exclusion was not added to leaderboard ranking or product-ledger quantity tracking. If pre-launch test purchases are ever backfilled, they would be excluded from reward calculations but could still appear in leaderboard totals or count toward a Display Wall product's `quantity_purchased`.
