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

export default function LiveChart({ label, color, unit, points, warnHigh, alarmHigh }) {
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

  // Y axis bounds — ensure thresholds are visible if within range
  const candidates = [dataMin - pad, dataMax + pad];
  if (warnHigh  != null) candidates.push(warnHigh  + pad * 0.5);
  if (alarmHigh != null) candidates.push(alarmHigh + pad * 0.5);
  const yMin = dataMin - pad;
  const yMax = Math.max(...candidates);

  // CSS overlay positions (percent from bottom)
  const warnPct  = warnHigh  != null ? toPct(warnHigh,  yMin, yMax) : null;
  const alarmPct = alarmHigh != null ? toPct(alarmHigh, yMin, yMax) : null;

  const data = {
    labels: points.map((p) => p.t),
    datasets: [{
      label,
      data: points.map((p) => p.v),
      borderColor: color,
      backgroundColor: `${color}12`,
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHitRadius: 16,
      borderWidth: 1.5,
    }],
  };

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
        callbacks: {
          title: (items) => items[0]?.label ?? '',
          label: (ctx) => `${ctx.parsed.y.toFixed(ctx.parsed.y < 10 ? 2 : 1)} ${unit}`,
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

  return (
    <div className="live-chart">
      <div className="live-chart__header">
        <span className="live-chart__label" style={{ color }}>{label}</span>
        <span className="live-chart__latest" style={{ color: latestColor }}>
          {latest.toFixed(latest < 10 ? 2 : latest < 100 ? 1 : 0)}
          <span className="live-chart__unit">{unit}</span>
        </span>
      </div>

      {/* Canvas + threshold overlay */}
      <div className="live-chart__canvas-wrap">
        <div className="live-chart__canvas">
          <Line data={data} options={options} />
        </div>
        {/* Threshold reference lines — CSS positioned from bottom */}
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
