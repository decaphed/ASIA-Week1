// ─────────────────────────────────────────────────────────────────────────
// LiveChart.jsx — pump metric trend chart.
// v3: warn/alarm threshold reference lines (CSS overlay, no extra dep),
//     value-coloured latest reading, industrial tooltip.
// ─────────────────────────────────────────────────────────────────────────

import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
} from 'chart.js';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Filler);

// Clamp a value to [0,100] percent within [yMin, yMax]
function toPct(v, yMin, yMax) {
  return Math.max(0, Math.min(100, ((v - yMin) / (yMax - yMin)) * 100));
}

export default function LiveChart({ label, color, unit, points, warnHigh, alarmHigh, forecast: rawForecast, trend }) {
  // The forecast API always returns an object per metric (never bare null),
  // but its numeric fields can individually be null — either "not enough
  // data yet" or a NaN on the server silently turned into null by
  // JSON.stringify. Either way, treat it the same as "no forecast" rather
  // than trusting the object's mere presence (see forecastService.js's
  // computeForecastEntry for the server-side half of this guard).
  const forecast = rawForecast
    && Number.isFinite(rawForecast.forecast)
    && Number.isFinite(rawForecast.lowerBound)
    && Number.isFinite(rawForecast.upperBound)
    ? rawForecast
    : null;

  if (!points || points.length === 0) {
    return (
      <div className="live-chart">
        <div className="live-chart__header">
          <span className="live-chart__label" style={{ color }}>{label}</span>
          <span className="live-chart__latest" style={{ color: 'var(--text-faint)' }}>--</span>
        </div>
        <div className="live-chart__empty">NO DATA</div>
      </div>
    );
  }

  const latest  = points[points.length - 1].v;
  const allVals = points.map((p) => p.v);
  const dataMin = Math.min(...allVals);
  const dataMax = Math.max(...allVals);
  const pad     = Math.max((dataMax - dataMin) * 0.30, 1);

  // Y axis bounds — ensure thresholds + forecast are visible if within range
  const candidates = [dataMin - pad, dataMax + pad];
  if (warnHigh  != null) candidates.push(warnHigh  + pad * 0.5);
  if (alarmHigh != null) candidates.push(alarmHigh + pad * 0.5);
  if (forecast) candidates.push(forecast.upperBound + pad * 0.5, forecast.lowerBound - pad * 0.5);
  const yMin = Math.min(dataMin - pad, forecast ? forecast.lowerBound - pad * 0.5 : dataMin - pad);
  const yMax = Math.max(...candidates);

  // CSS overlay positions (percent from bottom) — thresholds only; the
  // forecast is drawn as a continuation of the line itself (see datasets
  // below), not a static horizontal marker like a threshold.
  const warnPct  = warnHigh  != null ? toPct(warnHigh,  yMin, yMax) : null;
  const alarmPct = alarmHigh != null ? toPct(alarmHigh, yMin, yMax) : null;

  const labels = points.map((p) => p.t);
  const values = points.map((p) => p.v);
  const anchorIdx = values.length - 1; // last real reading — where the forecast segment starts

  const datasets = [{
    label,
    data: forecast ? [...values, null] : values,
    borderColor: color,
    backgroundColor: `${color}12`,
    fill: true,
    tension: 0.35,
    pointRadius: 0,
    pointHitRadius: 16,
    borderWidth: 1.5,
  }];

  if (forecast) {
    labels.push('Forecast');
    // Nulls up to the anchor, then the shared last-real-value point, so the
    // dashed forecast segment visually picks up exactly where history ends.
    const bridge = new Array(anchorIdx).fill(null);
    datasets.push(
      {
        data: [...bridge, latest, forecast.lowerBound],
        borderWidth: 0, pointRadius: 0, fill: false, tension: 0,
        skipTooltip: true,
      },
      {
        data: [...bridge, latest, forecast.upperBound],
        borderWidth: 0, pointRadius: 0, tension: 0,
        fill: '-1', backgroundColor: 'rgba(167,139,250,0.14)',
        skipTooltip: true,
      },
      {
        data: [...bridge, latest, forecast.forecast],
        borderColor: 'rgba(167,139,250,0.9)',
        borderDash: [4, 3], borderWidth: 1.5, tension: 0, fill: false,
        pointRadius: (ctx) => (ctx.dataIndex === anchorIdx + 1 ? 3 : 0),
        pointBackgroundColor: 'rgba(167,139,250,0.9)',
        isForecastLine: true,
      },
    );
  }

  const data = { labels, datasets };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(7,12,16,0.96)',
        borderColor: 'rgba(26,45,62,0.9)',
        borderWidth: 1,
        titleColor: '#435a6a',
        bodyColor: '#d8e4ee',
        titleFont: { family: "'Consolas',monospace", size: 10 },
        bodyFont: { family: "'Consolas',monospace", size: 13, weight: '700' },
        padding: { x: 12, y: 8 },
        displayColors: false,
        filter: (item) => {
          if (item.dataset.skipTooltip) return false;
          // Skip the forecast line's anchor point — it duplicates the
          // history dataset's last real reading at the same index.
          if (item.dataset.isForecastLine && item.dataIndex === anchorIdx) return false;
          return true;
        },
        callbacks: {
          title: (items) => items[0]?.label ?? '',
          label: (ctx) => {
            const prefix = ctx.dataset.isForecastLine ? 'Predicted ' : '';
            return `${prefix}${ctx.parsed.y.toFixed(ctx.parsed.y < 10 ? 2 : 1)} ${unit}`;
          },
        },
      },
    },
    scales: {
      x: { display: false, grid: { display: false } },
      y: {
        position: 'right',
        min: yMin, max: yMax,
        grid: { color: 'rgba(26,45,62,0.7)', drawBorder: false },
        border: { display: false },
        ticks: {
          color: '#2c3f4e',
          maxTicksLimit: 4,
          font: { family: "'Consolas',monospace", size: 10 },
          callback: (v) => v.toFixed(v < 10 ? 1 : 0),
          padding: 6,
        },
      },
    },
  };

  // Determine latest value colour by alarm state
  const latestColor = alarmHigh != null && latest >= alarmHigh
    ? 'var(--danger-bright)'
    : warnHigh != null && latest >= warnHigh
      ? 'var(--warn-bright)'
      : color;

  const decimals = (v) => v.toFixed(Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0);

  return (
    <div className="live-chart">
      <div className="live-chart__header">
        <span className="live-chart__label" style={{ color }}>{label}</span>
        <span className="live-chart__latest" style={{ color: latestColor }}>
          {latest.toFixed(latest < 10 ? 2 : latest < 100 ? 1 : 0)}
          <span className="live-chart__unit">{unit}</span>
        </span>
      </div>

      {/* Short-horizon graded trend classification (Mann-Kendall + Sen's slope) */}
      {trend && (
        <div className="live-chart__forecast-row">
          <span className={`live-chart__forecast-trend live-chart__forecast-trend--${trend.direction === 'up' ? 'up' : trend.direction === 'down' ? 'down' : 'flat'}`}>
            {trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '—'}
          </span>
          <span className="live-chart__forecast-text">{trend.label}</span>
        </div>
      )}

      {/* ETS forecast summary — next predicted value ± 95% interval */}
      {forecast && (
        <div className="live-chart__forecast-row">
          <span className={`live-chart__forecast-trend live-chart__forecast-trend--${forecast.trend > 0 ? 'up' : forecast.trend < 0 ? 'down' : 'flat'}`}>
            {forecast.trend > 0 ? '▲' : forecast.trend < 0 ? '▼' : '—'}
          </span>
          <span className="live-chart__forecast-text">
            Next: {decimals(forecast.forecast)} <span className="live-chart__unit">{unit}</span>
            {' '}(±{decimals((forecast.upperBound - forecast.lowerBound) / 2)})
          </span>
        </div>
      )}

      {/* Canvas + threshold overlay */}
      <div className="live-chart__canvas-wrap" style={{ position: 'relative', height: '150px' }}>
        <div className="live-chart__canvas" style={{ height: '100%' }}>
          <Line data={data} options={options} />
        </div>
        {/* Threshold / forecast reference lines — CSS positioned from bottom */}
        {warnPct !== null && (
          <div className="live-chart__threshold live-chart__threshold--warn"
            style={{ bottom: `${warnPct}%` }}
            aria-hidden="true">
            <span className="live-chart__threshold-label">W</span>
          </div>
        )}
        {alarmPct !== null && (
          <div className="live-chart__threshold live-chart__threshold--alarm"
            style={{ bottom: `${alarmPct}%` }}
            aria-hidden="true">
            <span className="live-chart__threshold-label">A</span>
          </div>
        )}
      </div>
    </div>
  );
}
