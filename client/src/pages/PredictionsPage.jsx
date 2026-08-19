import { memo, useCallback, useMemo, useState } from 'react';
import Card, { CardLabel, buttonReset } from '../components/Card.jsx';
import ReviewDrawer from '../components/ReviewDrawer.jsx';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { METRICS, METRIC_BY_KEY, THRESHOLDS, pillFor, fmt, AUTO_LABEL_BADGE } from '../utils/constants.js';
import { pts, line, bandPath, range } from '../utils/geometry.js';
import {
  eventId, eventTitle, metricsLabel, modelLine, severityOf, sevPill,
  confidenceLabel, shortStamp, filterEvents, RECENCY_OPTIONS, DEFAULT_FILTERS,
} from '../utils/faultEvents.js';

const X0 = 52;
const FW = 834;
const Y0 = 20;
const FH = 252;
const HORIZON_STEPS = 4; // 4 × 15 min = a 1-hour horizon
const STEP_HOURS = 0.25;

// ─────────────────────────────────────────────────────────────────────────
// projectForecast — /api/forecast publishes one damped-trend step ahead per
// metric (level, trend, phi, forecast, lower/upperBound). entry.trend is the
// ETS model's per-MINUTE rate, decayed each minute by entry.phi
// (forecastService.js advances level/trend once per minute, on every new
// processed record — see that file's header). The design asks for a 1-hour
// fan plotted in HORIZON_STEPS of STEP_HOURS each, so each step is
// STEP_HOURS*60 minutes ahead — extrapolating with the *same* phi the model
// fit (rather than a flat per-step trend) is what makes a heavily-damped
// metric's line visibly flatten out instead of running straight to the edge
// of the chart forever: Holt's damped-trend forecast h steps ahead adds
// trend * (phi + phi^2 + ... + phi^h), not trend * h.
//
// anchorValue pins the very first point (h=0) to the last actually-observed
// reading rather than entry.forecast — the model's own smoothed "now" belief
// — because they come from two different aggregations of the signal
// (processed_telemetry per-minute means vs. the raw_telemetry series this
// chart plots) and rarely land on the same number. Without this the dashed
// line would visibly jump away from where the solid observed line ends.
// ─────────────────────────────────────────────────────────────────────────
function projectForecast(entry, anchorValue) {
  if (!entry || entry.forecast == null) return null;
  const halfWidth = entry.upperBound != null ? entry.upperBound - entry.forecast : 0;
  const minutesPerStep = STEP_HOURS * 60;
  const trend = entry.trend ?? 0;
  const phi = entry.phi ?? 1;
  const base = anchorValue ?? entry.forecast;
  const median = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i <= HORIZON_STEPS; i++) {
    const h = i * minutesPerStep; // minutes ahead — trend is a per-minute rate
    const damped = phi >= 1 ? trend * h : (trend * phi * (1 - phi ** h)) / (1 - phi);
    const value = base + damped;
    const w = halfWidth * Math.sqrt(i + 1);
    median.push(value);
    upper.push(value + w);
    lower.push(value - w);
  }
  return { median, upper, lower };
}

/** First horizon step whose median crosses the alarm limit, or -1. */
function crossingIndex(median, alarmHigh) {
  if (alarmHigh == null) return -1;
  return median.findIndex((v) => v >= alarmHigh);
}

// "+30 min" / "+1 h" — the forecast horizon is HORIZON_STEPS * STEP_HOURS,
// currently 1 hour, so axis labels must be derived from that rather than
// hardcoded, or a future horizon change would silently mislabel the chart.
function forecastLabel(minutes) {
  return minutes < 60 ? `+${Math.round(minutes)} min` : `+${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} h`;
}

function Tabs({ tab, setTab, pendingCount }) {
  const item = (id, label, badge) => {
    const active = tab === id;
    return (
      <button
        key={id}
        type="button"
        role="tab"
        id={`tab-${id}`}
        aria-selected={active}
        aria-controls={`tabpanel-${id}`}
        tabIndex={active ? 0 : -1}
        onClick={() => setTab(id)}
        style={{
          ...buttonReset,
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', fontSize: 13.5, fontWeight: 600,
          color: active ? '#1F3A6E' : '#8a99a8',
          borderBottom: `2px solid ${active ? '#1F3A6E' : 'transparent'}`, marginBottom: -1,
        }}
      >
        {label}
        {badge > 0 && (
          <span style={{ background: '#B3282D', color: '#ffffff', fontSize: 11, fontWeight: 600, borderRadius: 9, padding: '1px 7px', fontVariantNumeric: 'tabular-nums' }}>
            {badge}
            <span className="sr-only"> pending review</span>
          </span>
        )}
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="Predictions views" style={{ display: 'flex', gap: 2, borderBottom: '1px solid #dde4ea' }}>
      {item('forecast', 'Forecast')}
      {item('detect', 'Fault Detection')}
      {item('review', 'Needs Review', pendingCount)}
    </div>
  );
}

function ForecastTab({ forecast, points, bucketSeconds, metricKey, setMetricKey, goReview }) {
  const metric = METRIC_BY_KEY[metricKey];
  const th = THRESHOLDS[metricKey];

  const hero = useMemo(() => {
    const history = points.map((p) => p[metricKey]).filter((v) => v != null).slice(-48);
    if (history.length < 2) return null;
    // Anchor the projection to the last actually-observed reading (not the
    // model's own smoothed belief) so the dashed line starts exactly where
    // the solid observed line ends — see projectForecast()'s comment.
    const projection = projectForecast(forecast?.[metricKey], history[history.length - 1]);
    if (!projection) return null;
    const all = [...history, ...projection.upper, ...projection.lower];
    let [mn, mx] = range(all, 0.12);
    if (th?.alarmHigh != null && th.alarmHigh < mx * 1.35) mx = Math.max(mx, th.alarmHigh * 1.04);

    // Both segments must get width proportional to the real time they span,
    // not their point count — history points are bucketSeconds apart (5 min
    // for the 8h series this tab polls) while forecast steps are
    // STEP_HOURS*60 minutes apart, so an equal-count split would badly
    // misrepresent which segment covers more real time.
    const bucketMinutes = (bucketSeconds ?? 300) / 60;
    const histMinutes = history.length * bucketMinutes;
    const forecastMinutes = HORIZON_STEPS * STEP_HOURS * 60;
    const histW = FW * (histMinutes / (histMinutes + forecastMinutes));
    const hp = pts(history, X0, Y0, histW, FH, mn, mx);
    const fp = pts(projection.median, X0 + histW, Y0, FW - histW, FH, mn, mx);
    const up = pts(projection.upper, X0 + histW, Y0, FW - histW, FH, mn, mx);
    const lo = pts(projection.lower, X0 + histW, Y0, FW - histW, FH, mn, mx);

    const ci = crossingIndex(projection.median, th?.alarmHigh);
    const nowValue = history[history.length - 1];
    const hasThresh = th?.alarmHigh != null && th.alarmHigh <= mx && th.alarmHigh >= mn;
    const spanHours = histMinutes / 60;
    return {
      histPath: line(hp),
      medPath: line(fp),
      band: bandPath(up, lo),
      nowX: X0 + histW,
      grid: [0, 1, 2, 3, 4].map((i) => {
        const y = Y0 + FH - (i * FH) / 4;
        return { y, label: fmt(mn + ((mx - mn) * i) / 4, Math.max(metric.dec, 1)) };
      }),
      xTicks: [
        { x: X0 + 60, label: `−${spanHours.toFixed(0)} h` },
        { x: X0 + histW * 0.55, label: `−${(spanHours / 2).toFixed(0)} h` },
        { x: X0 + histW, label: 'now' },
        { x: X0 + histW + (FW - histW) * 0.5, label: forecastLabel(forecastMinutes / 2) },
        { x: X0 + FW - 20, label: forecastLabel(forecastMinutes) },
      ],
      hasThresh,
      threshY: hasThresh ? Y0 + FH - ((th.alarmHigh - mn) / (mx - mn)) * FH : null,
      // ci === 0 means the very first forecast step already crosses; that is
      // still a crossing and must be marked, not silently dropped.
      crosses: ci >= 0 && nowValue < th.alarmHigh,
      crossPoint: ci >= 0 ? fp[ci] : null,
    };
  }, [points, bucketSeconds, metricKey, metric, th, forecast]);

  // Per-channel outlook cards plus the alert copy shown beside the hero chart.
  const outlook = useMemo(() => METRICS.map((m) => {
    const history = points.map((p) => p[m.key]).filter((v) => v != null).slice(-8);
    const nowValue = history.length ? history[history.length - 1] : null;
    // Anchor here too, for the same reason as the hero chart above.
    const proj = projectForecast(forecast?.[m.key], nowValue);
    const limit = THRESHOLDS[m.key]?.alarmHigh;

    let chip = 'stable';
    let chipBg = '#E4F3EB';
    let chipC = '#177E4D';
    let alert = null;

    if (!proj) {
      chip = 'no forecast';
      chipBg = '#eef1f4';
      chipC = '#5f6f7e';
    } else if (limit == null) {
      chip = 'in range';
      chipBg = '#eef1f4';
      chipC = '#5f6f7e';
    } else if (nowValue != null && nowValue >= limit) {
      chip = 'above limit';
      chipBg = '#FBEAE8';
      chipC = '#B3282D';
      alert = `${m.label} is above its alarm limit (${fmt(limit, m.dec)} ${m.unit}) and forecast to stay elevated`;
    } else {
      const ci = crossingIndex(proj.median, limit);
      if (ci >= 0) {
        const hrs = ci * STEP_HOURS;
        chip = ci === 0 ? 'crosses imminently' : `crosses ~${hrs.toFixed(1)} h`;
        chipBg = '#FBF3E0';
        chipC = '#8a5f00';
        alert = ci === 0
          ? `${m.label} median forecast crosses ${fmt(limit, m.dec)} ${m.unit} within the next step`
          : `${m.label} median forecast crosses ${fmt(limit, m.dec)} ${m.unit} in ~${hrs.toFixed(1)} h`;
      }
    }

    let paths = null;
    if (proj && history.length >= 2) {
      const [omn, omx] = range([...history, ...proj.upper, ...proj.lower], 0.15);
      paths = {
        hist: line(pts(history, 2, 4, 71, 44, omn, omx)),
        med: line(pts(proj.median, 73, 4, 145, 44, omn, omx)),
        band: bandPath(
          pts(proj.upper, 73, 4, 145, 44, omn, omx),
          pts(proj.lower, 73, 4, 145, 44, omn, omx)
        ),
      };
    }

    return {
      key: m.key,
      label: m.label,
      unit: m.unit,
      chip, chipBg, chipC, alert, paths,
      now: fmt(nowValue, m.dec),
      proj: proj ? fmt(proj.median[proj.median.length - 1], m.dec) : '—',
    };
  }), [forecast, points]);

  const alerts = outlook.map((o) => o.alert).filter(Boolean);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div role="group" aria-label="Forecast metric" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 20, alignItems: 'start' }}>
        <Card style={{ padding: '22px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{metric.label} forecast, next 1 hour</h2>
              <div style={{ fontSize: 12, color: '#8a99a8', marginTop: 3 }}>
                Projection from recent readings · shaded area shows where the reading will most likely stay · {metric.unit}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 11.5, color: '#5f6f7e', fontWeight: 500 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 16, height: 2.5, background: '#1F3A6E', borderRadius: 2 }} />Observed</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 16, borderTop: '2.5px dashed #4A6B8A' }} />Forecast</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 16, height: 9, background: 'rgba(74,107,138,0.16)', borderRadius: 2 }} />Likely range</span>
            </div>
          </div>

          {!hero ? (
            <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a99a8', fontSize: 13, textAlign: 'center', padding: '0 40px' }}>
              The forecast model needs more processed minutes before it can project this channel.
            </div>
          ) : (
            <svg width="100%" viewBox="0 0 900 300" style={{ marginTop: 14, display: 'block' }}>
              {hero.grid.map((g, i) => (
                <g key={i}>
                  <line x1={X0} x2={886} y1={g.y} y2={g.y} stroke="#eef2f5" strokeWidth="1" />
                  <text x="44" y={g.y + 3.5} textAnchor="end" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10.5, fill: '#8a99a8', fontVariantNumeric: 'tabular-nums' }}>{g.label}</text>
                </g>
              ))}
              {hero.xTicks.map((x, i) => (
                <text key={i} x={x.x} y="290" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10.5, fill: '#8a99a8' }}>{x.label}</text>
              ))}
              {hero.hasThresh && (
                <g>
                  <rect x={X0} y={Y0} width={FW} height={Math.max(0, hero.threshY - Y0)} fill="rgba(179,40,45,0.05)" />
                  <line x1={X0} x2={886} y1={hero.threshY} y2={hero.threshY} stroke="#B3282D" strokeWidth="1.2" strokeDasharray="5 4" opacity="0.7" />
                  <text x="58" y={hero.threshY - 6} textAnchor="start" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10, fontWeight: 600, fill: '#B3282D' }}>
                    Alarm limit · {fmt(th.alarmHigh, metric.dec)} {metric.unit}
                  </text>
                </g>
              )}
              <path d={hero.band} fill="rgba(31,58,110,0.12)" />
              <line x1={hero.nowX} x2={hero.nowX} y1="20" y2="272" stroke="#c9d2dc" strokeWidth="1.2" strokeDasharray="3 3" />
              <text x={hero.nowX} y="14" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10, fontWeight: 600, fill: '#8a99a8' }}>NOW</text>
              <path d={hero.histPath} stroke="#1F3A6E" strokeWidth="2.2" fill="none" strokeLinejoin="round" />
              <path d={hero.medPath} stroke="#4A6B8A" strokeWidth="2.2" fill="none" strokeDasharray="6 5" strokeLinejoin="round" />
              {hero.crosses && hero.crossPoint && (
                <circle cx={hero.crossPoint[0]} cy={hero.crossPoint[1]} r="4.5" fill="#B3282D" stroke="#ffffff" strokeWidth="2" />
              )}
            </svg>
          )}
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {alerts.length > 0 ? (
            <div style={{ background: '#FBF3E0', border: '1px solid #ecd9a8', borderRadius: 8, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#8a5f00' }}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.8 L15 13.8 L1 13.8 Z" stroke="#B27400" strokeWidth="1.6" strokeLinejoin="round" />
                  <path d="M8 6.5 L8 9.8" stroke="#B27400" strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx="8" cy="11.9" r="0.9" fill="#B27400" />
                </svg>
                Forecast attention
              </div>
              <div style={{ fontSize: 12.5, color: '#7a5c14', lineHeight: 1.55, marginTop: 8 }}>{alerts.slice(0, 2).join('. ')}.</div>
              <button type="button" className="hover-underline" onClick={goReview} style={{ ...buttonReset, fontSize: 12.5, fontWeight: 600, color: '#1F3A6E', marginTop: 10 }}>
                Open review queue →
              </button>
            </div>
          ) : (
            <div style={{ background: '#E4F3EB', border: '1px solid #bfe0cd', borderRadius: 8, padding: '18px 20px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#177E4D' }}>No crossings predicted</div>
              <div style={{ fontSize: 12.5, color: '#2c6e4c', lineHeight: 1.55, marginTop: 8 }}>
                No channel&apos;s median forecast crosses an alarm limit within the 1-hour horizon.
              </div>
            </div>
          )}
        </div>
      </div>

      <Card style={{ padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <CardLabel>1-hour outlook · all channels</CardLabel>
          <div style={{ fontSize: 11.5, color: '#8a99a8' }}>shaded = likely range · dashed = expected path</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
          {outlook.map((o) => (
            <button
              key={o.key}
              type="button"
              className="hover-chip"
              onClick={() => setMetricKey(o.key)}
              aria-pressed={metricKey === o.key}
              aria-label={`${o.label}: ${o.chip}. Now ${o.now}, in 1 hour ${o.proj} ${o.unit}`}
              style={{
                ...buttonReset,
                display: 'block', width: '100%',
                border: '1px solid', borderRadius: 8, padding: '12px 14px',
                borderColor: metricKey === o.key ? '#1F3A6E' : '#e3e9ef',
                background: metricKey === o.key ? '#F5F8FC' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: '#33475a' }}>{o.label}</span>
                <span style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 99, padding: '2px 8px', background: o.chipBg, color: o.chipC }}>{o.chip}</span>
              </div>
              <svg width="100%" height="52" viewBox="0 0 220 52" preserveAspectRatio="none" style={{ marginTop: 8, display: 'block' }}>
                {o.paths && (
                  <>
                    <path d={o.paths.band} fill="rgba(31,58,110,0.12)" />
                    <line x1="73" x2="73" y1="2" y2="50" stroke="#dde4ea" strokeWidth="1" />
                    <path d={o.paths.hist} stroke="#1F3A6E" strokeWidth="1.8" fill="none" />
                    <path d={o.paths.med} stroke="#4A6B8A" strokeWidth="1.8" strokeDasharray="4 4" fill="none" />
                  </>
                )}
              </svg>
              <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#8a99a8', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                <span>now {o.now}</span><span>{forecastLabel(HORIZON_STEPS * STEP_HOURS * 60)} {o.proj} {o.unit}</span>
              </div>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

// Shared by ReviewTab and DetectTab — same three axes filter either list.
function FilterBar({ filters, setFilters, resultCount, totalCount }) {
  const selectStyle = { border: '1px solid #d3dbe2', borderRadius: 6, padding: '6px 10px', fontSize: 12.5, background: '#ffffff', color: '#1a2530' };
  const isDefault = filters.severity === 'ALL' && filters.metric === 'ALL' && filters.recency === 'all';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
      <select
        aria-label="Filter by severity"
        value={filters.severity}
        onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value }))}
        style={selectStyle}
      >
        <option value="ALL">All severities</option>
        <option value="CRITICAL">Critical</option>
        <option value="WARNING">Warning</option>
      </select>
      <select
        aria-label="Filter by metric"
        value={filters.metric}
        onChange={(e) => setFilters((f) => ({ ...f, metric: e.target.value }))}
        style={selectStyle}
      >
        <option value="ALL">All metrics</option>
        {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
      </select>
      <select
        aria-label="Filter by recency"
        value={filters.recency}
        onChange={(e) => setFilters((f) => ({ ...f, recency: e.target.value }))}
        style={selectStyle}
      >
        {RECENCY_OPTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      {!isDefault && (
        <button
          type="button"
          className="hover-underline"
          onClick={() => setFilters(DEFAULT_FILTERS)}
          style={{ ...buttonReset, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}
        >
          Clear filters
        </button>
      )}
      <span style={{ fontSize: 11.5, color: '#8a99a8', marginLeft: 'auto' }}>
        Showing {resultCount} of {totalCount}
      </span>
    </div>
  );
}

function DetectTab({ queue, audit, stats }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const all = [...queue, ...audit].sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  const filtered = filterEvents(all, filters);
  const confirmed = audit.filter((a) => a.status === 'CONFIRMED').length;
  const rejected = audit.filter((a) => a.status === 'REJECTED').length;
  const reviewed = confirmed + rejected;
  const confirmRate = reviewed ? Math.round((100 * confirmed) / reviewed) : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
      <Card>
        <CardLabel>Detection model</CardLabel>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, marginTop: 10 }}>Automated fault detection</h3>
        <div style={{ fontSize: 12.5, color: '#5f6f7e', lineHeight: 1.55, marginTop: 6 }}>
          Watches vibration, temperature and pressure for abnormal behavior. Every detection waits for engineer review before it enters the record.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10, marginTop: 16 }}>
          {[
            { v: all.length, label: 'detections', color: '#1a2530' },
            { v: confirmed, label: 'confirmed', color: '#177E4D' },
            { v: rejected, label: 'rejected', color: '#5f6f7e' },
            { v: queue.length, label: 'pending', color: '#B27400' },
          ].map((s) => (
            <div key={s.label} style={{ background: '#f6f8fa', borderRadius: 6, padding: '10px 12px' }}>
              <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: s.color }}>{s.v}</div>
              <div style={{ fontSize: 11, color: '#8a99a8', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #eef2f5', fontSize: 11.5, color: '#8a99a8', lineHeight: 1.5 }}>
          {confirmRate == null
            ? 'No detections have been reviewed yet. Each review makes future detections more accurate.'
            : `${confirmRate}% of reviewed detections are confirmed by engineers. Each review makes future detections more accurate.`}
        </div>
        {stats && Object.keys(stats).length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #eef2f5' }}>
            <CardLabel style={{ marginBottom: 8 }}>Agreement by confidence</CardLabel>
            {Object.entries(stats).map(([confidence, byStatus]) => (
              <div key={confidence} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: '#5f6f7e', width: 64 }}>{confidence}</span>
                <span style={{ color: '#33475a' }}>
                  {Object.entries(byStatus).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <CardLabel>All detections</CardLabel>
          <a
            href={api.faultEventBufferCsvUrl()}
            download
            className="hover-underline"
            style={{ fontSize: 12, fontWeight: 600, color: '#1F3A6E' }}
            title="Every reviewed event's buffer window (1h before, the fault, 1h after), tagged per-row with its event id and phase — for training-data export"
          >
            Export training data (CSV) →
          </a>
        </div>
        <FilterBar filters={filters} setFilters={setFilters} resultCount={filtered.length} totalCount={all.length} />
        <div style={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1.8fr) minmax(0, 1fr) 130px 130px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#8a99a8', padding: '8px 2px', borderBottom: '1px solid #eef2f5' }}>
          <span>Event</span><span>Detection</span><span>Metric(s)</span><span>Detected</span><span>Status</span>
        </div>
        {all.length === 0 && <div style={{ padding: '36px 0', textAlign: 'center', color: '#8a99a8', fontSize: 13 }}>No detections recorded yet.</div>}
        {all.length > 0 && filtered.length === 0 && (
          <div style={{ padding: '36px 0', textAlign: 'center', color: '#8a99a8', fontSize: 13 }}>No detections match these filters.</div>
        )}
        {filtered.map((d) => {
          const pill = pillFor(d.status);
          return (
            <div key={d.id} style={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1.8fr) minmax(0, 1fr) 130px 130px', fontSize: 13, padding: '11px 2px', borderBottom: '1px solid #f4f7f9', alignItems: 'center' }}>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: '#33475a' }}>{eventId(d)}</span>
              <span style={{ fontWeight: 500, paddingRight: 10 }}>
                {d.status === 'PENDING_REVIEW' ? eventTitle(d) : (d.rootCause || eventTitle(d))}
              </span>
              <span style={{ color: '#5f6f7e', fontSize: 12 }}>{metricsLabel(d)}</span>
              <span style={{ color: '#5f6f7e', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{shortStamp(d.detectedAt)}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '3px 10px', background: pill.bg, color: pill.color, border: `1px solid ${pill.border}` }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: pill.color }} />{pill.label}
                </span>
                {d.autoLabeled && (
                  <span
                    title={`Auto-labeled from fault event #${d.autoLabeledFromEventId}`}
                    style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 99, padding: '3px 9px', background: AUTO_LABEL_BADGE.bg, color: AUTO_LABEL_BADGE.color, border: `1px solid ${AUTO_LABEL_BADGE.border}` }}
                  >
                    {AUTO_LABEL_BADGE.label}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function ReviewTab({ queue, onOpen, onDismissOne, onDismissMany, dismissingIds }) {
  const [selected, setSelected] = useState(() => new Set());
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const sorted = filterEvents(queue, filters).sort((a, b) => {
    const rank = (e) => (severityOf(e) === 'CRITICAL' ? 0 : 1);
    return rank(a) - rank(b) || Date.parse(a.detectedAt) - Date.parse(b.detectedAt);
  });

  const allSelected = sorted.length > 0 && sorted.every((q) => selected.has(q.id));
  const someSelected = sorted.some((q) => selected.has(q.id));
  const selectAllRef = (node) => {
    if (node) node.indeterminate = someSelected && !allSelected;
  };

  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(sorted.map((q) => q.id)));

  const dismissSelected = () => {
    const events = sorted.filter((q) => selected.has(q.id));
    setSelected(new Set());
    onDismissMany(events);
  };
  const dismissAll = () => {
    setSelected(new Set());
    onDismissMany(sorted);
  };

  return (
    <Card style={{ padding: '20px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Fault events awaiting review</h2>
          <div style={{ fontSize: 12.5, color: '#8a99a8', marginTop: 3 }}>
            Nothing enters the maintenance record until an engineer confirms or rejects it. Most urgent first.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {someSelected && (
            <button
              type="button"
              className="hover-ghost"
              onClick={dismissSelected}
              style={{ ...buttonReset, color: '#8a99a8', borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 600 }}
            >
              Dismiss selected ({selected.size})
            </button>
          )}
          {sorted.length > 0 && (
            <button
              type="button"
              className="hover-ghost"
              onClick={dismissAll}
              title="Dismiss every event currently shown — each stays on record as DISMISSED, not deleted"
              style={{ ...buttonReset, color: '#8a99a8', borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 600 }}
            >
              {sorted.length === queue.length ? 'Dismiss all' : `Dismiss all shown (${sorted.length})`}
            </button>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '4px 11px', background: '#FBF3E0', color: '#8a5f00', border: '1px solid #ecd9a8' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#B27400' }} />{queue.length} Pending Review
          </span>
        </div>
      </div>
      <FilterBar filters={filters} setFilters={setFilters} resultCount={sorted.length} totalCount={queue.length} />
      <div style={{ display: 'grid', gridTemplateColumns: '28px 96px minmax(0, 1.9fr) minmax(0, 1fr) 120px 100px 190px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#8a99a8', padding: '10px 2px', borderBottom: '1px solid #eef2f5', alignItems: 'center' }}>
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={allSelected}
          onChange={toggleAll}
          aria-label="Select all pending events"
          disabled={sorted.length === 0}
        />
        <span>Event</span><span>Detection</span><span>Metric(s)</span><span>Detected</span><span>Severity</span><span />
      </div>
      {sorted.map((q) => {
        const sev = severityOf(q);
        const sp = sevPill(sev);
        const dismissing = dismissingIds.has(q.id);
        return (
          <div key={q.id} className="hover-row" style={{ display: 'grid', gridTemplateColumns: '28px 96px minmax(0, 1.9fr) minmax(0, 1fr) 120px 100px 190px', fontSize: 13.5, padding: '14px 2px', borderBottom: '1px solid #f4f7f9', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={selected.has(q.id)}
              onChange={() => toggleOne(q.id)}
              aria-label={`Select ${eventId(q)}: ${eventTitle(q)}`}
            />
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12.5, color: '#33475a' }}>{eventId(q)}</span>
            <span style={{ paddingRight: 12 }}>
              <span style={{ fontWeight: 600 }}>{eventTitle(q)}</span>
              <span style={{ display: 'block', fontSize: 12, color: '#8a99a8', marginTop: 2 }}>{modelLine(q)} · confidence: {confidenceLabel(q)}</span>
            </span>
            <span style={{ color: '#5f6f7e', fontSize: 12.5 }}>{metricsLabel(q)}</span>
            <span style={{ color: '#5f6f7e', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{shortStamp(q.detectedAt)}</span>
            <span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, borderRadius: 4, padding: '3px 9px', background: sp.bg, color: sp.color }}>{sev}</span>
            </span>
            <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="hover-ghost"
                disabled={dismissing}
                onClick={() => onDismissOne(q)}
                aria-label={`Dismiss ${eventId(q)}: ${eventTitle(q)}`}
                title="Remove from the review queue without a full review — stays on record as DISMISSED"
                style={{ ...buttonReset, display: 'inline-block', color: '#8a99a8', borderRadius: 6, padding: '6px 10px', fontSize: 12.5, fontWeight: 600, opacity: dismissing ? 0.5 : 1, cursor: dismissing ? 'not-allowed' : 'pointer' }}
              >
                {dismissing ? '…' : 'Dismiss'}
              </button>
              <button
                type="button"
                className="hover-outline-btn"
                onClick={() => onOpen(q)}
                aria-label={`Review ${eventId(q)}: ${eventTitle(q)}`}
                style={{ ...buttonReset, display: 'inline-block', border: '1px solid #1F3A6E', color: '#1F3A6E', background: '#ffffff', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600 }}
              >
                Review
              </button>
            </span>
          </div>
        );
      })}
      {queue.length === 0 && (
        <div style={{ padding: '36px 0', textAlign: 'center', color: '#8a99a8', fontSize: 13 }}>
          Queue clear. Every detection has been reviewed. <span style={{ color: '#177E4D', fontWeight: 600 }}>✓</span>
        </div>
      )}
      {queue.length > 0 && sorted.length === 0 && (
        <div style={{ padding: '36px 0', textAlign: 'center', color: '#8a99a8', fontSize: 13 }}>
          No pending events match these filters.
        </div>
      )}
    </Card>
  );
}

function PredictionsPage({ tab, setTab, queue, audit, reviewer, showToast, goReview, refreshEvents }) {
  const [metricKey, setMetricKey] = useState('vibration');
  const [drawerId, setDrawerId] = useState(null);
  const [dismissingIds, setDismissingIds] = useState(() => new Set());

  const { data: forecastRes } = usePolling(() => api.forecast(), 30000, []);
  const { data: seriesRes } = usePolling(() => api.series('8h'), 60000, []);
  const { data: statsRes } = usePolling(() => api.faultEventStats(), 60000, []);

  const points = seriesRes?.data?.points ?? [];
  const drawerEvent = queue.find((q) => q.id === drawerId) || null;

  // Soft-dismiss (single or bulk): pulls junk/false-positive detections out
  // of the review queue without a full confirm/reject per event. Rows are
  // kept (status=DISMISSED), not deleted, so the record and the CSV export
  // stay complete. Runs one PATCH per event in parallel — no separate bulk
  // API endpoint, since the existing per-event route already does the
  // group-gated write and a queue this size (a handful to dozens of pending
  // detections) doesn't need one.
  const dismissEvents = useCallback(async (events) => {
    if (!events.length) return;
    setDismissingIds(new Set(events.map((e) => e.id)));
    const results = await Promise.allSettled(
      events.map((e) => api.reviewFaultEvent(e.id, { status: 'DISMISSED', reviewedBy: reviewer }))
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    const ok = results.length - failed;
    if (ok && !failed) {
      showToast(`${ok} event${ok === 1 ? '' : 's'} dismissed`, '#9fb0bf');
    } else if (ok) {
      showToast(`${ok} dismissed, ${failed} failed`, '#e08a80');
    } else {
      showToast(`Dismiss failed for all ${failed} event${failed === 1 ? '' : 's'}`, '#e08a80');
    }
    refreshEvents();
    setDismissingIds(new Set());
  }, [reviewer, showToast, refreshEvents]);

  const dismissOne = useCallback((event) => {
    if (!window.confirm(`Dismiss ${eventId(event)}? It leaves the review queue but stays on record as DISMISSED.`)) return;
    dismissEvents([event]);
  }, [dismissEvents]);

  const dismissMany = useCallback((events) => {
    if (!events.length) return;
    const n = events.length;
    if (!window.confirm(`Dismiss ${n} pending event${n === 1 ? '' : 's'}? They'll leave the review queue but stay on record as DISMISSED.`)) return;
    dismissEvents(events);
  }, [dismissEvents]);

  return (
    <div style={{ padding: '26px 32px 44px', display: 'flex', flexDirection: 'column', gap: 20, animation: 'fadeUp .3s ease' }}>
      <Tabs tab={tab} setTab={setTab} pendingCount={queue.length} />

      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'forecast' && (
          <ForecastTab
            forecast={forecastRes?.data}
            points={points}
            bucketSeconds={seriesRes?.data?.bucketSeconds}
            metricKey={metricKey}
            setMetricKey={setMetricKey}
            goReview={goReview}
          />
        )}
        {tab === 'detect' && <DetectTab queue={queue} audit={audit} stats={statsRes?.data} />}
        {tab === 'review' && (
          <ReviewTab
            queue={queue}
            onOpen={(q) => setDrawerId(q.id)}
            onDismissOne={dismissOne}
            onDismissMany={dismissMany}
            dismissingIds={dismissingIds}
          />
        )}
      </div>

      <ReviewDrawer
        event={drawerEvent}
        points={points}
        reviewer={reviewer}
        onClose={() => setDrawerId(null)}
        onReviewed={refreshEvents}
        showToast={showToast}
      />
    </div>
  );
}

// Memoised: App re-renders at 1 Hz from the live telemetry feed, which this
// page never displays. Every prop it receives is stable between the 15 s
// fault-event poll and user interaction.
export default memo(PredictionsPage);
