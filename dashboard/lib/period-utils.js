// Pure date-math helpers, deliberately duplicated (not imported) from
// pipeline/reward-calculator.js (getPeriodBounds) and pipeline/customer-schema.js
// (fiscalPeriodKey, isDisplayWallProfile) — this dashboard must never import
// backend pipeline modules. Keep in sync manually if that fiscal-period math
// ever changes.

export function getPeriodBounds(date, isDW) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-indexed
  if (isDW) {
    const q = Math.floor(m / 3);
    const startM = q * 3;
    const endM = startM + 2;
    return { start: new Date(y, startM, 1), end: new Date(y, endM + 1, 0) };
  }
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0) };
}

function fiscalYearLabel(calendarYear, calendarMonth /* 0-indexed */) {
  const fyStartYear = calendarMonth >= 3 ? calendarYear : calendarYear - 1;
  const a = String(fyStartYear % 100).padStart(2, '0');
  const b = String((fyStartYear + 1) % 100).padStart(2, '0');
  return `FY${a}${b}`;
}

export function fiscalPeriodKey(date, isDW) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const fy = fiscalYearLabel(y, m);

  if (isDW) {
    const calQ = Math.floor(m / 3);
    const fiscalQ = ((calQ - 1) + 4) % 4 + 1;
    return `${fy}-Q${fiscalQ}`;
  }
  return `${fy}-${String(m + 1).padStart(2, '0')}`;
}

export function isDisplayWallProfile(profile) {
  const linkedIds = profile?.linked_ids ?? [];
  return linkedIds.length > 0 && linkedIds.every((li) => li.type === 'display_wall');
}
