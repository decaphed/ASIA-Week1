// ─────────────────────────────────────────────────────────────────────────
// StatsPanel.jsx — the six aggregate figures from GET /api/stats.
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
      <Stat label="Total Records" value={stats ? stats.totalRecords : '--'} />
      <Stat label="Avg Temp" value={stats ? formatNumber(stats.averageTemperature) : '--'} unit="°C" />
      <Stat label="Avg Humidity" value={stats ? formatNumber(stats.averageHumidity) : '--'} unit="%" />
      <Stat label="Avg Pressure" value={stats ? formatNumber(stats.averagePressure) : '--'} unit="hPa" />
      <Stat label="API Latency" value={stats ? formatNumber(stats.apiLatencyMs, 2) : '--'} unit="ms" />
      <Stat label="Latest Reading" value={stats ? formatDateTime(stats.latestTimestamp) : '--'} />
    </div>
  );
}
