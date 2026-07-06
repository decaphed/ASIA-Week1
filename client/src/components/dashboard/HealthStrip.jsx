// ─────────────────────────────────────────────────────────────────────────
// HealthStrip.jsx — 6-tile machine-health summary above the process
// schematic (V2 Overview spec §02/§06): Machine Health, Status, Efficiency,
// Active Alarms, Runtime, Last Comm.
// ─────────────────────────────────────────────────────────────────────────

import { computeHealth, estimateEfficiency } from '../../utils/health.js';
import { formatNumber, secondsSince } from '../../utils/formatters.js';

const GAUGE_CIRCUMFERENCE = 113; // 2 * PI * r18, matches the r=18 gauge below

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

export default function HealthStrip({ reading, uptimeSeconds }) {
  const hasReading = reading != null;
  const health = computeHealth(reading);
  const efficiency = estimateEfficiency(reading);
  const lastCommSeconds = hasReading && reading.timestamp ? Math.round(secondsSince(reading.timestamp)) : null;
  const runtimeHours = uptimeSeconds != null ? uptimeSeconds / 3600 : null;

  const statusFault = reading?.status === 'FAULT';
  const statusState = !hasReading ? 'neutral' : statusFault ? 'alarm' : 'ok';
  const alarmState = health.alarms > 0 ? 'alarm' : health.warns > 0 ? 'warn' : 'ok';

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
          {!hasReading ? 'Awaiting data' : statusFault ? 'Auto-trip engaged' : 'Auto mode · nominal'}
        </span>
      </Tile>

      <Tile>
        <span className="health-tile__label">Efficiency</span>
        <span className="health-tile__value">
          {efficiency != null ? formatNumber(efficiency, 1) : '--'}<span className="health-tile__unit">%</span>
        </span>
        <span className="health-tile__sub">Est. from vibration + temp</span>
      </Tile>

      <Tile state={alarmState}>
        <span className="health-tile__label">Active Alarms</span>
        <span className={`health-tile__value health-tile__value--${alarmState}`}>
          {hasReading ? health.alarms + health.warns : '--'}
          <span className="health-tile__unit">{health.alarms > 0 ? 'crit' : health.warns > 0 ? 'warn' : 'ok'}</span>
        </span>
        <span className="health-tile__sub">
          {health.alarms > 0 ? 'Immediate attention needed' : health.warns > 0 ? 'Monitor closely' : 'All within limits'}
        </span>
      </Tile>

      <Tile>
        <span className="health-tile__label">Runtime</span>
        <span className="health-tile__value">
          {runtimeHours != null ? formatNumber(runtimeHours, 1) : '--'}<span className="health-tile__unit">h</span>
        </span>
        <span className="health-tile__sub">Since server start</span>
      </Tile>

      <Tile>
        <span className="health-tile__label">Last Comm</span>
        <span className="health-tile__value">
          {lastCommSeconds != null ? lastCommSeconds : '--'}<span className="health-tile__unit">s</span>
        </span>
        <span className="health-tile__sub health-tile__sub--ok">Feed healthy</span>
      </Tile>
    </section>
  );
}
