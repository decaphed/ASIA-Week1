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

// Dashed vertical "now" divider where history ends and the forecast begins
// (the Graph_Idea reference's crosshair line). Reads the anchor index from
// options.nowLine; skipped when there is no forecast segment.
const nowLinePlugin = {
  id: 'nowLine',
  afterDatasetsDraw(chart) {
    const cfg = chart.config.options.nowLine;
    if (!cfg || cfg.index == null) return;
    const x = chart.scales.x.getPixelForValue(cfg.index);
    const { top, bottom } = chart.chartArea;
    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = cfg.color || 'rgba(148,163,184,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};
ChartJS.register(nowLinePlugin);

// Theme-aware chart chrome colours. Chart.js needs concrete values (it can't
// resolve CSS variables), so read the current theme off <html data-theme>;
// the chart re-renders every second with the live poll, so a theme switch
// takes effect within a tick.
function chartChrome() {
  const light = document.documentElement.dataset.theme === 'light';
  return light
    ? {
        grid: 'rgba(148,163,184,0.35)',
        tick: '#94a3b8',
        tooltipBg: 'rgba(255,255,255,0.97)',
        tooltipBorder: 'rgba(203,213,225,0.9)',
        tooltipTitle: '#64748b',
        tooltipBody: '#1e293b',
      }
    : {
        grid: 'rgba(26,45,62,0.7)',
        tick: '#2c3f4e',
        tooltipBg: 'rgba(7,12,16,0.96)',
        tooltipBorder: 'rgba(26,45,62,0.9)',
        tooltipTitle: '#435a6a',
        tooltipBody: '#d8e4ee',
      };
}

// Clamp a value to [0,100] percent within [yMin, yMax]
function toPct(v, yMin, yMax) {
  return Math.max(0, Math.min(100, ((v - yMin) / (yMax - yMin)) * 100));
}

// Shared "up/down/stable" direction → arrow/CSS-modifier mapping, used for
// both the trend badge (server direction: 'up'|'down'|'stable') and the
// forecast badge (derived from the sign of forecast.trend below).
function directionClass(direction) {
  return direction === 'up' ? 'up' : direction === 'down' ? 'down' : 'flat';
}
function directionArrow(direction) {
  return direction === 'up' ? '▲' : direction === 'down' ? '▼' : '—';
}

// Plain-language rendering of the trend service's {direction, magnitude}
// pair — "Rising steadily" instead of the server's "Moderate Increasing".
const TREND_PACE = { slight: 'slowly', moderate: 'steadily', sharp: 'quickly' };
function plainTrendText(trend) {
  if (trend.direction === 'stable') return 'Holding steady';
  const verb = trend.direction === 'up' ? 'Rising' : 'Falling';
  const pace = TREND_PACE[trend.magnitude];
  return pace ? `${verb} ${pace}` : verb;
}

// Qualitative badge for where the forecast is heading relative to this
// metric's caution/critical limits — the business framing of the number.
function forecastTone(forecast, warnHigh, alarmHigh) {
  if (alarmHigh != null && forecast.forecast >= alarmHigh) return 'danger';
  if (warnHigh != null && forecast.forecast >= warnHigh) return 'warn';
  if (warnHigh != null && forecast.upperBound >= warnHigh) return 'watch';
  return 'ok';
}
function forecastToneText(forecast, warnHigh, alarmHigh) {
  const tone = forecastTone(forecast, warnHigh, alarmHigh);
  return tone === 'danger' ? 'heading past critical'
    : tone === 'warn' ? 'nearing caution level'
      : tone === 'watch' ? 'could touch caution'
        : 'in normal range';
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
    // Graph_Idea treatment: a vertical gradient wash under the line instead
    // of a flat tint — strong at the line, fading to transparent.
    backgroundColor: (context) => {
      const { ctx, chartArea } = context.chart;
      if (!chartArea) return `${color}12`;
      const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      g.addColorStop(0, `${color}4d`);
      g.addColorStop(0.65, `${color}14`);
      g.addColorStop(1, `${color}00`);
      return g;
    },
    fill: true,
    tension: 0.4,
    // Emphasize the latest real reading with a ringed dot (the reference's
    // crosshair point); all other points stay hidden.
    pointRadius: (ctx) => (ctx.dataIndex === anchorIdx ? 3.5 : 0),
    pointBackgroundColor: color,
    pointBorderColor: '#fff',
    pointBorderWidth: 1.5,
    pointHitRadius: 16,
    borderWidth: 2,
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
  const chrome = chartChrome();

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    // Dashed divider where history ends and the forecast begins.
    nowLine: forecast ? { index: anchorIdx, color: chrome.tick } : null,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: chrome.tooltipBg,
        borderColor: chrome.tooltipBorder,
        borderWidth: 1,
        titleColor: chrome.tooltipTitle,
        bodyColor: chrome.tooltipBody,
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
      // Sparse time labels along the bottom (Graph_Idea shows its axis —
      // it's a big part of why that chart reads so clearly).
      x: {
        display: true,
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: chrome.tick,
          maxTicksLimit: 5,
          maxRotation: 0,
          font: { family: "'Consolas',monospace", size: 9 },
        },
      },
      y: {
        position: 'right',
        min: yMin, max: yMax,
        grid: { color: chrome.grid, drawBorder: false },
        border: { display: false },
        ticks: {
          color: chrome.tick,
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
  const forecastDirection = forecast ? (forecast.trend > 0 ? 'up' : forecast.trend < 0 ? 'down' : 'stable') : null;

  return (
    <div className="live-chart">
      <div className="live-chart__header">
        <span className="live-chart__label" style={{ color }}>{label}</span>
        <span className="live-chart__latest" style={{ color: latestColor }}>
          {latest.toFixed(latest < 10 ? 2 : latest < 100 ? 1 : 0)}
          <span className="live-chart__unit">{unit}</span>
        </span>
      </div>

      {/* Short-horizon graded trend classification (Mann-Kendall + Sen's
          slope server-side) — rendered here in plain language rather than
          the raw label, so a manager reads "Rising steadily", never a
          statistics term. */}
      {trend && (
        <div className="live-chart__forecast-row">
          <span className={`live-chart__forecast-trend live-chart__forecast-trend--${directionClass(trend.direction)}`}>
            {directionArrow(trend.direction)}
          </span>
          <span className="live-chart__forecast-text">{plainTrendText(trend)}</span>
        </div>
      )}

      {/* ETS forecast summary — the ± interval is deliberately kept out of
          the visible text (it reads as statistics jargon); it lives in the
          title tooltip for anyone who hovers, and the shaded band on the
          chart already shows the same uncertainty visually. */}
      {forecast && (
        <div
          className="live-chart__forecast-row"
          title={`Prediction range: ${decimals(forecast.lowerBound)} – ${decimals(forecast.upperBound)} ${unit}`}
        >
          <span className={`live-chart__forecast-trend live-chart__forecast-trend--${directionClass(forecastDirection)}`}>
            {directionArrow(forecastDirection)}
          </span>
          <span className="live-chart__forecast-text">
            Expected next: {decimals(forecast.forecast)} <span className="live-chart__unit">{unit}</span>
            <span className={`live-chart__forecast-badge live-chart__forecast-badge--${forecastTone(forecast, warnHigh, alarmHigh)}`}>
              {forecastToneText(forecast, warnHigh, alarmHigh)}
            </span>
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
