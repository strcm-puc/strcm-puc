'use strict';

const { db } = require('../firebase-config');

// /system/config — single doc holding system-wide settings. launch_date is
// unset (null) until an owner explicitly sets it via /setlaunchdate; every
// reward-eligibility check treats "unset" as "system not live yet".

function systemConfigRef() {
  return db.collection('system').doc('config');
}

// Returns a Date (midnight local) for the configured launch_date, or null if
// unset/invalid. Never defaults to "today" or any guessed value.
async function getLaunchDate() {
  const snap = await systemConfigRef().get();
  const raw  = snap.exists ? snap.data()?.launch_date : null;
  if (!raw) return null;
  const d = new Date(`${raw}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

async function setLaunchDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`launch_date must be YYYY-MM-DD, got "${dateStr}"`);
  }
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: "${dateStr}"`);
  await systemConfigRef().set({ launch_date: dateStr }, { merge: true });
  return dateStr;
}

module.exports = { systemConfigRef, getLaunchDate, setLaunchDate };
