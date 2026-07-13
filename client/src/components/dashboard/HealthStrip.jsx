// ─────────────────────────────────────────────────────────────────────────
// HealthStrip.jsx — 6-tile machine-health summary above the process
// schematic (V2 Overview spec §02/§06): Machine Health, Status,
// Availability, Active Alarms, Run Hours, Last Comm.
//
// Honesty pass: the old "Efficiency" tile was a fabricated proxy number and
// has been retired in favour of a real Availability figure from the period
// summary. Run Hours and Availability both come from /api/summary?range=24h
// (measured running time, not server uptime); Active Alarms splits the count
// into critical vs caution so a manager never reads a single merged number;
// Last Comm's tone is now driven by the true age of the reading.
// ─────────────────────────────────────────────────────────────────────────

import { computeHealth } from '../../utils/health.js';
import { formatNumber, secondsSince } from '../../utils/formatters.js';

const GAUGE_CIRCUMFERENCE = 113; // 2 * PI * r18, matches the r=18 gauge below

// Human-readable labels for the simulator's fault signatures (see
// node-red/flow.json's FAULT_PROFILES) — each pairs with a distinct,
// dominant metric so "Thermal" reliably means motorTemp is the one spiking.
const FAULT_LABELS = { THERMAL: 'Thermal', CAVITATION: 'Cavitation', BEARING: 'Bearing' };

function HealthGauge({ score, color }) {
  const dashoffset = score == null ? GAUGE_CIRCUMFERENCE : GAUGE_CIRCUMFERENCE * (1 - score / 100);
  return (
    <svg viewBox="0 0 44 44" width="52" height="52" className="health-gauge" aria-hidden="true">
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--panel-2)" strokeWidth="5" />
      <circle
        cx="22" cy="22" r="18" fill="none" stroke={color} strokeWidth="5"
        strokeLinecap="round" strokeDasharray={GAUGE_CIRCUMFERENCE}
        strokeDashoffset={dashoffset}
        transform="rotate(-90 22 22)"
      />
    </svg>
  );
}

function Tile({ state = 'neutral', children }) {
  return <div className={`health-tile health-tile--${state}`}>{children}</div>;
}

export default function HealthStrip({ reading, summary }) {
  const hasReading = reading != null;
  const health = computeHealth(reading);
  const lastCommSeconds = hasReading && reading.timestamp ? Math.round(secondsSince(reading.timestamp)) : null;

  const statusFault = reading?.status === 'FAULT';
  const statusState = !hasReading ? 'neutral' : statusFault ? 'alarm' : 'ok';
  const alarmState = health.alarms > 0 ? 'alarm' : health.warns > 0 ? 'warn' : 'ok';

  // Availability — measured running time over the last 24 h (may be null early).
  const availability = summary?.availabilityPct;
  const hasAvail = availability != null;
  const availState = !hasAvail ? 'neutral' : availability >= 95 ? 'ok' : availability >= 80 ? 'warn' : 'alarm';

  const runHours = summary?.runHours;

  // Last Comm tone — honest read of how fresh the feed is.
  const commState = lastCommSeconds == null
    ? 'neutral'
    : lastCommSeconds < 10 ? 'ok' : lastCommSeconds <= 30 ? 'warn' : 'alarm';
  const commSub = lastCommSeconds == null
    ? 'Awaiting first reading'
    : commState === 'ok' ? 'Feed healthy'
      : commState === 'warn' ? 'Feed delayed'
        : 'Feed stale — values frozen';

  const noAlarms = health.alarms === 0 && health.warns === 0;

  return (
    <section className="health-strip" aria-label="Machine health summary">
      <Tile state={alarmState}>
        <div className="health-tile__gauge-row">
          <HealthGauge score={health.score} color={health.color} />
          <div className="health-tile__body">
            <span className="health-tile__label">Machine Health</span>
            <span className="health-tile__value" style={{ color: health.color }}>
              {health.score ?? '--'}<span className="health-tile__unit">/100</span>
            </span>
            <span className="health-tile__sub">{health.label}</span>
          </div>
        </div>
      </Tile>

      <Tile state={statusState}>
        <span className="health-tile__label">Status</span>
        <span className={`health-tile__value health-tile__value--status health-tile__value--${statusState}`}>
          {reading?.status ?? '—'}
        </span>
        <span className="health-tile__sub">
          {!hasReading
            ? 'Awaiting data'
            : statusFault
              ? (reading?.faultType ? `Auto-trip · ${FAULT_LABELS[reading.faultType] ?? reading.faultType}` : 'Auto-trip engaged')
              : 'Auto mode · nominal'}
        </span>
      </Tile>

      <Tile state={availState}>
        <span className="health-tile__label">Availability</span>
        <span className={`health-tile__value${availState === 'neutral' ? '' : ` health-tile__value--${availState}`}`}>
          {hasAvail ? formatNumber(availability, 1) : '--'}<span className="health-tile__unit">%</span>
        </span>
        <span className="health-tile__sub">Running time · last 24 h</span>
      </Tile>

      <Tile state={alarmState}>
        <span className="health-tile__label">Active Alarms</span>
        <span className="health-tile__value health-tile__value--split">
          {!hasReading ? (
            '--'
          ) : noAlarms ? (
            '0'
          ) : (
            <>
              {health.alarms > 0 && (
                <span className="health-tile__count health-tile__count--alarm">{health.alarms} ALM</span>
              )}
              {health.alarms > 0 && health.warns > 0 && (
                <span className="health-tile__count-sep"> · </span>
              )}
              {health.warns > 0 && (
                <span className="health-tile__count health-tile__count--warn">{health.warns} WRN</span>
              )}
            </>
          )}
        </span>
        <span className="health-tile__sub">
          {health.alarms > 0 ? 'Immediate attention needed' : health.warns > 0 ? 'Monitor closely' : 'All within limits'}
        </span>
      </Tile>

      <Tile>
        <span className="health-tile__label">Run Hours</span>
        <span className="health-tile__value">
          {runHours != null ? formatNumber(runHours, 1) : '--'}<span className="health-tile__unit">h</span>
        </span>
        <span className="health-tile__sub">Pump running · last 24 h</span>
      </Tile>

      <Tile state={commState}>
        <span className="health-tile__label">Last Comm</span>
        <span className={`health-tile__value${commState === 'neutral' ? '' : ` health-tile__value--${commState}`}`}>
          {lastCommSeconds != null ? lastCommSeconds : '--'}<span className="health-tile__unit">s</span>
        </span>
        <span className="health-tile__sub">{commSub}</span>
      </Tile>
    </section>
  );
}
