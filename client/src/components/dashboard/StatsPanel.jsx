// ─────────────────────────────────────────────────────────────────────────
// StatsPanel.jsx — the aggregate figures from GET /api/stats.
// Shows "--" until the first stats poll returns.
// ─────────────────────────────────────────────────────────────────────────

import { formatNumber, formatDateTime } from '../../utils/formatters.js';

function Stat({ label, value, unit }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

export default function StatsPanel({ stats }) {
  return (
    <div className="stats-panel">
      <Stat label="Total Records"    value={stats ? stats.totalRecords : '--'} />
      <Stat label="Avg Flow Rate"    value={stats ? formatNumber(stats.averageFlowRate, 1) : '--'}          unit="L/min" />
      <Stat label="Avg RPM"          value={stats ? formatNumber(stats.averageRpm, 0) : '--'}               unit="rpm" />
      <Stat label="Avg Vibration"    value={stats ? formatNumber(stats.averageVibration, 2) : '--'}         unit="mm/s" />
      <Stat label="Avg Suction"      value={stats ? formatNumber(stats.averageSuctionPressure, 2) : '--'}   unit="bar" />
      <Stat label="Avg Discharge"    value={stats ? formatNumber(stats.averageDischargePressure, 2) : '--'} unit="bar" />
      <Stat label="Avg Motor Temp"   value={stats ? formatNumber(stats.averageMotorTemp, 1) : '--'}         unit="°C" />
      <Stat label="API Latency"      value={stats ? formatNumber(stats.apiLatencyMs, 2) : '--'}             unit="ms" />
      <Stat label="Last Reading"     value={stats ? formatDateTime(stats.latestTimestamp) : '--'} />
    </div>
  );
}
