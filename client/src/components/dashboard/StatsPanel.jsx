// ─────────────────────────────────────────────────────────────────────────
// StatsPanel.jsx — operating statistics panel.
// v3: two visual groups — pump averages (6) + system info (3).
// ─────────────────────────────────────────────────────────────────────────

import { formatNumber, formatDateTime } from '../../utils/formatters.js';

function Stat({ label, value, unit, accent }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={`stat__value${accent ? ' stat__value--accent' : ''}`}>
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

function StatDivider({ label }) {
  return (
    <div className="stat-divider" role="presentation">
      <span className="stat-divider__label">{label}</span>
    </div>
  );
}

export default function StatsPanel({ stats }) {
  const s = stats;
  return (
    <div className="stats-panel-wrap">
      <StatDivider label="Pump Averages — all stored readings" />
      <div className="stats-panel">
        <Stat label="Avg Flow Rate"   value={s ? formatNumber(s.averageFlowRate,          1) : '--'} unit="L/min" />
        <Stat label="Avg Shaft Speed" value={s ? formatNumber(s.averageRpm,               0) : '--'} unit="rpm"  />
        <Stat label="Avg Vibration"   value={s ? formatNumber(s.averageVibration,         2) : '--'} unit="mm/s" />
        <Stat label="Avg Suction P"   value={s ? formatNumber(s.averageSuctionPressure,   2) : '--'} unit="bar"  />
        <Stat label="Avg Discharge P" value={s ? formatNumber(s.averageDischargePressure, 2) : '--'} unit="bar"  />
        <Stat label="Avg Motor Temp"  value={s ? formatNumber(s.averageMotorTemp,         1) : '--'} unit="°C"   />
      </div>
      <StatDivider label="System" />
      <div className="stats-panel stats-panel--system">
        <Stat label="Total Records"  value={s ? s.totalRecords : '--'} />
        <Stat label="API Latency"    value={s ? formatNumber(s.apiLatencyMs, 2) : '--'} unit="ms" />
        <Stat label="Last Reading"   value={s ? formatDateTime(s.latestTimestamp) : '--'} />
      </div>
    </div>
  );
}
