// ─────────────────────────────────────────────────────────────────────────
// MetricSummaryStrip.jsx — 6-card min/avg/max strip for AnalyticsPage.
// Purely derived from the same chartSeries points already plotted in the
// ChartGroups below — no new endpoint, no fabricated numbers.
// ─────────────────────────────────────────────────────────────────────────

import { SENSORS } from '../../utils/constants.js';
import { formatNumber } from '../../utils/formatters.js';

/** min/avg/max/latest over one sensor's currently-loaded series points. */
function summarize(points) {
  const values = (points || [])
    .map((p) => p.v)
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { min, max, avg, latest: values[values.length - 1] };
}

export default function MetricSummaryStrip({ series }) {
  return (
    <div className="metric-strip" id="analytics-metric-strip">
      {SENSORS.map((sensor) => {
        const stats = summarize(series?.[sensor.key]);
        const range = stats ? stats.max - stats.min : 0;
        const fillPct = stats && range > 0 ? ((stats.avg - stats.min) / range) * 100 : 50;
        return (
          <div key={sensor.key} className={`metric-strip__card metric-strip__card--${sensor.accent}`}>
            <span className="metric-strip__label">{sensor.shortLabel}</span>
            <div className="metric-strip__value">
              {stats ? formatNumber(stats.latest, sensor.prec) : '--'}
              <span className="metric-strip__unit"> {sensor.unit}</span>
            </div>
            <div className="metric-strip__bar">
              <div className="metric-strip__bar-fill" style={{ width: `${fillPct}%` }} />
            </div>
            <div className="metric-strip__minmax">
              <span>MIN {stats ? formatNumber(stats.min, sensor.prec) : '--'}</span>
              <span>AVG {stats ? formatNumber(stats.avg, sensor.prec) : '--'}</span>
              <span>MAX {stats ? formatNumber(stats.max, sensor.prec) : '--'}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
