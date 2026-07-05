// ─────────────────────────────────────────────────────────────────────────
// LiveChart.jsx — a reusable Chart.js line chart (via react-chartjs-2).
//
// Chart.js is modular: you must register only the pieces you use (tree-shaking
// keeps the bundle small). We register line/point elements, the two scales, a
// tooltip and the Filler (for the soft area under the line) ONCE here.
//
// `points` is an array of { t: label, v: number }. We disable animation so the
// chart redraws instantly each second instead of easing (which would look
// laggy when new data arrives every 1s).
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
  const data = {
    labels: points.map((p) => p.t),
    datasets: [
      {
        label,
        data: points.map((p) => p.v),
        borderColor: color,
        backgroundColor: `${color}22`, // same colour, ~13% alpha for the fill
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: { intersect: false, mode: 'index' },
    },
    scales: {
      x: { display: false, grid: { display: false } },
      y: {
        grid: { color: 'rgba(148,163,184,0.12)' },
        ticks: {
          color: '#94a3b8',
          maxTicksLimit: 5,
          callback: (v) => `${v}${unit}`,
        },
      },
    },
  };

  const latest = points.length ? `${points[points.length - 1].v}${unit}` : '--';

  return (
    <div className="live-chart">
      <div className="live-chart__header">
        <span className="live-chart__label" style={{ color }}>{label}</span>
        <span className="live-chart__latest">{latest}</span>
      </div>
      <div className="live-chart__canvas">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}
