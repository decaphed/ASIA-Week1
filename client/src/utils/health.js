// ─────────────────────────────────────────────────────────────────────────
// health.js — derived machine-health metrics for the Overview health strip,
// alarms rail, and system-health panel. Everything here is computed from
// real polled data (readings, alarm thresholds, API latency) — nothing is
// simulated.
// ─────────────────────────────────────────────────────────────────────────

import { SENSORS, getAlarmState, NODE_RED_FRESH_SECONDS } from './constants.js';
import { formatNumber, secondsSince } from './formatters.js';

/** Derive the 3 connection statuses (backend/database/Node-RED feed) shared by the Topbar pills and the System Health panel. */
export function computeServiceStatus(health, healthError) {
  const backend = healthError ? 'offline' : health ? 'online' : 'unknown';
  const database = healthError
    ? 'offline'
    : health?.database === 'connected'
      ? 'online'
      : health ? 'offline' : 'unknown';
  let nodeRed = 'unknown';
  if (health) {
    nodeRed = !health.lastReadingAt
      ? 'offline'
      : secondsSince(health.lastReadingAt) <= NODE_RED_FRESH_SECONDS
        ? 'online'
        : 'offline';
  }
  return { backend, database, nodeRed };
}

/** Count sensors currently in alarm/warn state for one reading. */
export function countAlarms(reading) {
  if (!reading) return { alarms: 0, warns: 0 };
  let alarms = 0, warns = 0;
  for (const sensor of SENSORS) {
    const state = getAlarmState(sensor, reading[sensor.key]);
    if (state === 'alarm') alarms++;
    else if (state === 'warn') warns++;
  }
  return { alarms, warns };
}

/** Machine health score (0-100) — penalises active alarms/warnings. */
export function computeHealth(reading) {
  const { alarms, warns } = countAlarms(reading);
  const hasReading = reading != null;
  const score = hasReading ? Math.max(0, Math.min(100, 100 - alarms * 40 - warns * 18)) : null;
  const color = score === null
    ? 'var(--text-faint)'
    : score >= 85 ? 'var(--ok-bright)' : score >= 60 ? 'var(--warn-bright)' : 'var(--danger-bright)';
  const label = score === null
    ? 'Awaiting data'
    : alarms > 0
      ? 'Critical — intervention required'
      : warns > 0
        ? `Good — ${warns} factor${warns > 1 ? 's' : ''} flagged`
        : 'Excellent — all systems nominal';
  return { score, color, label, alarms, warns };
}

/**
 * Is the latest reading older than `seconds`? Used to gray out a frozen
 * number so a stalled feed never looks live. Age is recomputed at render
 * time (the poll keeps returning the same reading object every second, which
 * re-renders the cards), so no timer of our own is needed.
 */
export function isReadingStale(reading, seconds = 10) {
  if (!reading || !reading.timestamp) return false;
  return secondsSince(reading.timestamp) > seconds;
}

/** Bucket an API-latency figure into a signal-quality label + bar count (1-3). */
export function connectionQuality(latencyMs) {
  if (latencyMs == null) return { label: 'Unknown', bars: 0 };
  if (latencyMs <= 50) return { label: 'Excellent', bars: 3 };
  if (latencyMs <= 150) return { label: 'Good', bars: 2 };
  return { label: 'Degraded', bars: 1 };
}

/** Live alarm/warning rows for the Alarms & Events panel, newest-relevant first. */
export function buildAlarmFeed(reading, timeLabel) {
  if (!reading) {
    return [{ key: 'awaiting', severity: 'info', title: 'Awaiting first reading…', meta: timeLabel }];
  }
  const rows = [];
  for (const sensor of SENSORS) {
    const value = reading[sensor.key];
    const state = getAlarmState(sensor, value);
    if (state !== 'alarm' && state !== 'warn') continue;
    const limit = state === 'alarm' ? (sensor.alarmHigh ?? sensor.alarmLow) : (sensor.warnHigh ?? sensor.warnLow);
    rows.push({
      key: sensor.key,
      severity: state,
      title: `${sensor.label} ${state === 'alarm' ? 'exceeded alarm limit' : 'above warning limit'}`,
      meta: `${formatNumber(value, sensor.prec)} ${sensor.unit} · limit ${formatNumber(limit, sensor.prec)} · ${timeLabel}`,
    });
  }
  if (rows.length === 0) {
    rows.push({ key: 'ok', severity: 'ok', title: 'All parameters within operating limits', meta: `System nominal · ${timeLabel}` });
  }
  return rows.slice(0, 4);
}
