// ─────────────────────────────────────────────────────────────────────────
// LiveChart.jsx — reusable Chart.js line chart (react-chartjs-2).
// v2: tighter grid lines, improved tooltip, empty-state placeholder,
//     unit shown in tooltip callback.
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

export default function LiveChart({ label, color, unit, points }) {
  // Empty state — show a placeholder instead of a blank canvas
  if (!points || points.length === 0) {
    return (
      <div className="live-chart">
        <div className="live-chart__header">
          <span className="live-chart__label" style={{ color }}>{label}</span>
          <span className="live-chart__latest" style={{ color: 'var(--text-faint)' }}>--</span>
        </div>
        <div className="live-chart__empty">Waiting for data…</div>
      </div>
    );
  }

  const latest = points[points.length - 1].v;

  const data = {
    labels: points.map((p) => p.t),
    datasets: [
      {
        label,
        data: points.map((p) => p.v),
        borderColor: color,
        backgroundColor: `${color}18`,   // ~9% alpha fill
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHitRadius: 12,
        borderWidth: 1.5,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(13, 21, 32, 0.92)',
        borderColor: 'rgba(30, 45, 61, 0.8)',
        borderWidth: 1,
        titleColor: '#8ca0b4',
        bodyColor: '#dde6ee',
        titleFont: { family: "'Consolas', monospace", size: 11 },
        bodyFont: { family: "'Consolas', monospace", size: 13, weight: '700' },
        padding: 10,
        displayColors: false,
        callbacks: {
          label: (ctx) => `${ctx.parsed.y} ${unit}`,
        },
      },
    },
    scales: {
      x: {
        display: false,
        grid: { display: false },
      },
      y: {
        position: 'right',
        grid: {
          color: 'rgba(30, 45, 61, 0.8)',
          drawBorder: false,
        },
        border: { display: false },
        ticks: {
          color: '#526070',
          maxTicksLimit: 4,
          font: { family: "'Consolas', monospace", size: 11 },
          callback: (v) => `${v}`,
          padding: 6,
        },
      },
    },
  };

  return (
    <div className="live-chart">
      <div className="live-chart__header">
        <span className="live-chart__label" style={{ color }}>{label}</span>
        <span className="live-chart__latest" style={{ color }}>
          {latest}<span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '4px', fontFamily: 'var(--font)', fontWeight: 400 }}>{unit}</span>
        </span>
      </div>
      <div className="live-chart__canvas">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
