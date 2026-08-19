import { memo, useMemo, useState } from 'react';
import Card, { CardLabel, buttonReset } from '../components/Card.jsx';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { METRICS, METRIC_BY_KEY, SC, THRESHOLDS, statusOf, fmt } from '../utils/constants.js';
import { ptsByTime, line, area, range } from '../utils/geometry.js';

const RANGES = [
  { id: '1h', label: 'Last hour' },
  { id: '8h', label: 'Last 8 hours' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
];

// Matches the backend's SERIES_RANGES window (summaryService.js) — anchors
// the chart's time axis to the actual requested window, not to whatever
// span the returned points happen to cover.
const RANGE_MS = { '1h': 3600e3, '8h': 8 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3 };

const X0 = 52;
const W = 834;
const Y0 = 20;
const H = 252;

// Map the trend service's direction/label into the design's arrow + palette.
function trendChip(entry, metricKey) {
  if (!entry) return { arrow: '→', label: 'no data', c: '#5f6f7e', bg: '#eef1f4' };
  const label = entry.label || 'Stable';
  const dir = entry.direction || 'stable';
  if (dir === 'stable' || !entry.significant) {
    return { arrow: '→', label: label.toLowerCase(), c: '#5f6f7e', bg: '#eef1f4' };
  }
  const up = dir === 'increasing' || dir === 'rising' || dir === 'up';
  const sharp = /sharp/i.test(label);
  const arrow = up ? (sharp ? '↑' : '↗') : sharp ? '↓' : '↘';
  // Rising is the bad direction for every channel except suction pressure,
  // where a falling reading is what signals trouble (loss of NPSH).
  const bad = metricKey === 'suctionPressure' ? !up : up;
  if (!bad) return { arrow, label: label.toLowerCase(), c: '#177E4D', bg: '#E4F3EB' };
  return sharp
    ? { arrow, label: label.toLowerCase(), c: '#B3282D', bg: '#FBEAE8' }
    : { arrow, label: label.toLowerCase(), c: '#8a5f00', bg: '#FBF3E0' };
}

function statsOf(values) {
  const clean = values.filter((v) => v != null && !Number.isNaN(v));
  if (!clean.length) return null;
  const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
  const sd = Math.sqrt(clean.reduce((a, b) => a + (b - avg) ** 2, 0) / clean.length);
  return { min: Math.min(...clean), max: Math.max(...clean), avg, sd };
}

function EmptyChart({ message }) {
  return (
    <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a99a8', fontSize: 13 }}>
      {message}
    </div>
  );
}

function AnalyticsPage() {
  const [metricKey, setMetricKey] = useState('vibration');
  const [rangeId, setRangeId] = useState('24h');

  const { data: seriesRes, loading: seriesLoading, error: seriesError } = usePolling(
    () => api.series(rangeId),
    60000,
    [rangeId]
  );
  // /api/summary only accepts 24h and 7d, so the shorter chart ranges roll up
  // against the 24-hour window.
  const summaryRange = rangeId === '7d' ? '7d' : '24h';
  const { data: summary24Res } = usePolling(() => api.summary('24h'), 60000, []);
  const { data: summary7Res } = usePolling(() => api.summary('7d'), 300000, []);
  const { data: trendRes } = usePolling(() => api.trend(), 30000, []);

  const points = seriesRes?.data?.points ?? [];
  const metric = METRIC_BY_KEY[metricKey];
  const rangeLabel = RANGES.find((r) => r.id === rangeId).label.toLowerCase();
  const trend = trendRes?.data?.[metricKey];
  const chip = trendChip(trend, metricKey);

  const chart = useMemo(() => {
    const rows = points.filter((p) => p[metricKey] != null);
    if (rows.length < 2) return null;
    const values = rows.map((p) => p[metricKey]);
    const times = rows.map((p) => Date.parse(p.t));
    const th = THRESHOLDS[metricKey];
    let [mn, mx] = range(values, 0.15);
    if (th?.alarmHigh != null && th.alarmHigh > mn && th.alarmHigh < mx * 1.3) {
      mx = Math.max(mx, th.alarmHigh * 1.04);
    }
    // Anchor to the actual requested window (now − rangeMs .. now), not to
    // the span the returned points happen to cover — a gap in ingestion
    // (or simply a young dataset) must show as empty space, not stretch the
    // real readings across the full width and imply they span the window.
    const tMax = Math.max(Date.now(), times[times.length - 1]);
    const tMin = tMax - RANGE_MS[rangeId];
    const p = ptsByTime(values, times, X0, Y0, W, H, mn, mx, tMin, tMax);
    const grid = [0, 1, 2, 3, 4].map((i) => {
      const y = Y0 + H - (i * H) / 4;
      return { y, label: fmt(mn + ((mx - mn) * i) / 4, metric.dec) };
    });
    const xTicks = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const frac = i / 6;
      const d = new Date(tMin + frac * (tMax - tMin));
      const label = rangeId === '7d'
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : d.toTimeString().slice(0, 5);
      return { x: X0 + frac * W, label };
    });
    const hasThresh = th?.alarmHigh != null && th.alarmHigh <= mx && th.alarmHigh >= mn;
    const threshY = hasThresh ? Y0 + H - ((th.alarmHigh - mn) / (mx - mn)) * H : null;
    return {
      values,
      linePath: line(p),
      areaPath: area(p, Y0 + H),
      last: p[p.length - 1],
      grid,
      xTicks,
      hasThresh,
      threshY,
      threshVal: hasThresh ? `${fmt(th.alarmHigh, metric.dec)} ${metric.unit}` : '',
    };
  }, [points, metricKey, metric, rangeId]);

  const selStats = chart ? statsOf(chart.values) : null;
  const currentStatus = statusOf(metricKey, points.length ? points[points.length - 1][metricKey] : null);
  const statusClause = currentStatus === 'crit'
    ? 'It is currently above its alarm limit and needs attention.'
    : currentStatus === 'warn'
      ? 'It is currently above its warning level and worth watching.'
      : 'It is currently within normal operating limits.';

  const insight = selStats
    ? `${metric.label} averaged ${fmt(selStats.avg, metric.dec)} ${metric.unit} over the ${rangeLabel} and is ${chip.label}. ${statusClause}`
    : 'Waiting for enough readings to summarise this channel.';

  const rollup = (summaryRes, withTrend) => {
    const perSensor = summaryRes?.data?.perSensor;
    if (!perSensor) return [];
    return METRICS.map((m) => {
      const s = perSensor[m.key] || {};
      const maxStatus = statusOf(m.key, s.max);
      const c = withTrend ? trendChip(trendRes?.data?.[m.key], m.key) : null;
      return {
        key: m.key,
        label: m.label,
        unit: m.unit,
        min: fmt(s.min, m.dec),
        avg: fmt(s.avg, m.dec),
        max: fmt(s.max, m.dec),
        maxColor: maxStatus === 'ok' ? '#33475a' : SC[maxStatus].c,
        trendArrow: c?.arrow,
        trend: c?.label,
        trendC: c?.c,
      };
    });
  };

  const roll24 = rollup(summary24Res, true);
  const roll7 = rollup(summary7Res, false);
  const summaryHead = (summaryRange === '7d' ? summary7Res : summary24Res)?.data;

  return (
    <div style={{ padding: '26px 32px 44px', display: 'flex', flexDirection: 'column', gap: 20, animation: 'fadeUp .3s ease' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div role="group" aria-label="Metric" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              className="hover-chip"
              onClick={() => setMetricKey(m.key)}
              aria-pressed={metricKey === m.key}
              style={{
                ...buttonReset,
                border: '1px solid', borderRadius: 99, padding: '6px 14px', fontSize: 12.5, fontWeight: 600,
                background: metricKey === m.key ? '#1F3A6E' : '#ffffff',
                color: metricKey === m.key ? '#ffffff' : '#5f6f7e',
                borderColor: metricKey === m.key ? '#1F3A6E' : '#dde4ea',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div role="group" aria-label="Time range" style={{ display: 'flex', border: '1px solid #d3dbe2', borderRadius: 6, overflow: 'hidden', background: '#ffffff' }}>
          {RANGES.map((r, i) => (
            <button
              key={r.id}
              type="button"
              className="hover-seg"
              onClick={() => setRangeId(r.id)}
              aria-pressed={rangeId === r.id}
              style={{
                ...buttonReset,
                padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
                borderLeft: i === 0 ? 'none' : '1px solid #d3dbe2',
                background: rangeId === r.id ? '#33475a' : 'transparent',
                color: rangeId === r.id ? '#ffffff' : '#5f6f7e',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <Card style={{ padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{metric.label}, {rangeLabel}</h2>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '3px 10px', background: chip.bg, color: chip.c }}>
                {chip.arrow} {chip.label}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: '#5f6f7e', marginTop: 4, maxWidth: 560 }}>{insight}</div>
          </div>
          {selStats && (
            <div style={{ display: 'flex', gap: 20 }}>
              {[
                { k: 'Min', v: fmt(selStats.min, metric.dec) },
                { k: 'Avg', v: fmt(selStats.avg, metric.dec) },
                { k: 'Max', v: fmt(selStats.max, metric.dec) },
                { k: 'Typical swing', v: `±${fmt(selStats.sd, Math.max(metric.dec, 1))}` },
              ].map((s) => (
                <div key={s.k} style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#8a99a8' }}>{s.k}</div>
                  <div style={{ fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 1 }}>{s.v}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {!chart ? (
          <EmptyChart
            message={
              seriesError
                ? `Could not load history: ${seriesError.message}`
                : seriesLoading
                  ? 'Loading history…'
                  : 'Not enough readings in this window yet.'
            }
          />
        ) : (
          <svg width="100%" viewBox="0 0 900 300" style={{ marginTop: 14, display: 'block' }}>
            <defs>
              <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1F3A6E" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#1F3A6E" stopOpacity="0.01" />
              </linearGradient>
            </defs>
            {chart.grid.map((g, i) => (
              <g key={i}>
                <line x1={X0} x2={886} y1={g.y} y2={g.y} stroke="#eef2f5" strokeWidth="1" />
                <text x="44" y={g.y + 3.5} textAnchor="end" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10.5, fill: '#8a99a8', fontVariantNumeric: 'tabular-nums' }}>{g.label}</text>
              </g>
            ))}
            {chart.xTicks.map((x, i) => (
              <text key={i} x={x.x} y="290" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10.5, fill: '#8a99a8', fontVariantNumeric: 'tabular-nums' }}>{x.label}</text>
            ))}
            {chart.hasThresh && (
              <g>
                <rect x={X0} y={Y0} width={W} height={Math.max(0, chart.threshY - Y0)} fill="rgba(179,40,45,0.05)" />
                <line x1={X0} x2={886} y1={chart.threshY} y2={chart.threshY} stroke="#B3282D" strokeWidth="1.2" strokeDasharray="5 4" opacity="0.7" />
                <text x="58" y={chart.threshY - 6} textAnchor="start" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10, fontWeight: 600, fill: '#B3282D' }}>
                  Alarm limit: {chart.threshVal}. Readings in the red zone trigger an alarm.
                </text>
              </g>
            )}
            <path d={chart.areaPath} fill="url(#ga)" />
            <path d={chart.linePath} stroke="#1F3A6E" strokeWidth="2.2" fill="none" strokeLinejoin="round" />
            <circle cx={chart.last[0]} cy={chart.last[1]} r="4" fill="#1F3A6E" stroke="#ffffff" strokeWidth="2" />
          </svg>
        )}
      </Card>

      {summaryHead && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 20 }}>
          {[
            { k: 'Availability', v: summaryHead.availabilityPct == null ? '—' : `${fmt(summaryHead.availabilityPct, 1)} %`, sub: `over the last ${summaryRange === '7d' ? '7 days' : '24 hours'}` },
            { k: 'Run time', v: summaryHead.runHours == null ? '—' : `${fmt(summaryHead.runHours, 2)} h`, sub: 'pump in RUNNING state' },
            { k: 'Warning excursions', v: fmt(summaryHead.excursions?.warn, 0), sub: 'distinct periods above a warning level' },
            { k: 'Alarm excursions', v: fmt(summaryHead.excursions?.alarm, 0), sub: 'distinct periods above an alarm limit' },
          ].map((s) => (
            <Card key={s.k} style={{ padding: '16px 18px' }}>
              <CardLabel>{s.k}</CardLabel>
              <div style={{ fontSize: 26, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 8 }}>{s.v}</div>
              <div style={{ fontSize: 11.5, color: '#8a99a8', marginTop: 4 }}>{s.sub}</div>
            </Card>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 20 }}>
        <Card>
          <CardLabel style={{ marginBottom: 6 }}>24-hour rollup · all metrics</CardLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 1.3fr)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#8a99a8', padding: '8px 2px', borderBottom: '1px solid #eef2f5' }}>
            <span>Metric</span><span style={{ textAlign: 'right' }}>Min</span><span style={{ textAlign: 'right' }}>Avg</span><span style={{ textAlign: 'right' }}>Max</span><span style={{ textAlign: 'right' }}>Trend</span>
          </div>
          {roll24.length === 0 && <div style={{ padding: '20px 0', color: '#8a99a8', fontSize: 12.5 }}>No summary available yet.</div>}
          {roll24.map((r) => (
            <div key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 1.3fr)', fontSize: 13, padding: '9px 2px', borderBottom: '1px solid #f4f7f9', alignItems: 'center' }}>
              <span style={{ fontWeight: 500, color: '#33475a' }}>{r.label} <span style={{ color: '#a7b3bf', fontSize: 11 }}>{r.unit}</span></span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#5f6f7e' }}>{r.min}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.avg}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.maxColor }}>{r.max}</span>
              <span style={{ textAlign: 'right', fontSize: 11.5, fontWeight: 600, color: r.trendC }}>{r.trendArrow} {r.trend}</span>
            </div>
          ))}
        </Card>

        <Card>
          <CardLabel style={{ marginBottom: 6 }}>7-day rollup · all metrics</CardLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#8a99a8', padding: '8px 2px', borderBottom: '1px solid #eef2f5' }}>
            <span>Metric</span><span style={{ textAlign: 'right' }}>Min</span><span style={{ textAlign: 'right' }}>Avg</span><span style={{ textAlign: 'right' }}>Max</span>
          </div>
          {roll7.length === 0 && <div style={{ padding: '20px 0', color: '#8a99a8', fontSize: 12.5 }}>No summary available yet.</div>}
          {roll7.map((r) => (
            <div key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', fontSize: 13, padding: '9px 2px', borderBottom: '1px solid #f4f7f9', alignItems: 'center' }}>
              <span style={{ fontWeight: 500, color: '#33475a' }}>{r.label} <span style={{ color: '#a7b3bf', fontSize: 11 }}>{r.unit}</span></span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#5f6f7e' }}>{r.min}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.avg}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.maxColor }}>{r.max}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// Memoised: App re-renders at 1 Hz from the live telemetry feed, which this
// page never displays — it runs entirely on its own slower polls.
export default memo(AnalyticsPage);
