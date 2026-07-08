// ─────────────────────────────────────────────────────────────────────────
// AnalyticsPage.jsx — trend charts grouped by subsystem (hydraulic /
// mechanical) with per-metric forecast and trend classification.
//
// Headline feature: a range selector (Live · 1h · 8h · 24h · 7d). "Live" is
// the original per-second in-memory buffer with its short-horizon forecast +
// trend rows. Any historical range instead pulls bucketed averages from
// /api/history/series and hides the forecast/trend rows — those describe the
// live model, not what already happened, so showing them over history would
// be dishonest.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { useForecast, useTrend, useSeries } from '../hooks/useSensorData.js';
import LiveChart from '../components/charts/LiveChart.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import { SENSORS, POLL_INTERVALS } from '../utils/constants.js';
import { formatClock, formatDayTime, describeBucket } from '../utils/formatters.js';

const SENSOR_MAP = Object.fromEntries(SENSORS.map((s) => [s.key, s]));

const HYDRAULIC_CHARTS = [
  { key: 'flowRate',          color: '#00b4d8' },
  { key: 'suctionPressure',   color: '#38bdf8' },
  { key: 'dischargePressure', color: '#818cf8' },
];

const MECHANICAL_CHARTS = [
  { key: 'rpm',               color: '#f59e0b' },
  { key: 'vibration',         color: '#ef4444' },
  { key: 'motorTemp',         color: '#f97316' },
];

// Selector options. `live` is the special in-memory mode; the rest map 1:1 to
// the /api/history/series `range` query values.
const RANGES = [
  { id: 'live', label: 'Live' },
  { id: '1h',   label: '1h' },
  { id: '8h',   label: '8h' },
  { id: '24h',  label: '24h' },
  { id: '7d',   label: '7d' },
];

// Turn the API's rows ([{ t, flowRate, rpm, … }]) into LiveChart's per-metric
// [{ t: label, v }] shape. 7-day labels carry the date; hour ranges just the
// clock.
function buildSeriesFromPoints(points, range) {
  const labelFor = range === '7d' ? formatDayTime : formatClock;
  const out = {};
  for (const sensor of SENSORS) {
    out[sensor.key] = (points || []).map((p) => ({ t: labelFor(p.t), v: p[sensor.key] }));
  }
  return out;
}

function ChartGroup({ title, subtitle, defs, series, forecast, trend, id }) {
  return (
    <div className="chart-group" id={id}>
      <div className="chart-group__header">
        {/* h2, not h3 — the Topbar owns the page's h1 and nothing else on
            this page emits an h2, so h3 here would skip a heading level. */}
        <h2 className="chart-group__title">{title}</h2>
        {subtitle && <span className="chart-group__subtitle">{subtitle}</span>}
      </div>
      <div className="chart-group__grid">
        {defs.map(({ key, color }) => {
          const sensor = SENSOR_MAP[key];
          return (
            <div key={key} className="chart-group__item">
              <LiveChart
                label={sensor.label}
                unit={sensor.unit}
                color={color}
                points={series[key]}
                warnHigh={sensor.warnHigh}
                alarmHigh={sensor.alarmHigh}
                forecast={forecast ? forecast[key] : null}
                trend={trend ? trend[key] : null}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Roll-up strip so a reader gets the page's story in one line before the
// six charts: how many readings are steady vs moving, and which one is
// moving fastest. Only meaningful in Live mode (the trend model is a
// short-horizon read of the live feed).
function TrendSummary({ trend }) {
  const entries = trend
    ? SENSORS.map((s) => ({ sensor: s, t: trend[s.key] })).filter((e) => e.t != null)
    : [];
  if (entries.length === 0) {
    return (
      <div className="trend-summary" id="analytics-summary">
        <span className="trend-summary__item trend-summary__item--muted">
          Building up enough history to read the direction of each measurement…
        </span>
      </div>
    );
  }

  const moving = entries.filter((e) => e.t.direction !== 'stable');
  const steady = entries.length - moving.length;
  // "Fastest mover" = the moving metric covering the most of its own
  // operating range over the window (rangePct), so different units compare
  // fairly.
  const fastest = moving.slice().sort((a, b) => (b.t.rangePct ?? 0) - (a.t.rangePct ?? 0))[0];

  return (
    <div className="trend-summary" id="analytics-summary">
      <span className="trend-summary__item trend-summary__item--ok">
        <strong>{steady}</strong>&nbsp;of {entries.length} readings holding steady
      </span>
      {moving.length > 0 && (
        <span className="trend-summary__item trend-summary__item--warn">
          <strong>{moving.length}</strong>&nbsp;on the move
        </span>
      )}
      {fastest && (
        <span className="trend-summary__item">
          Fastest mover: <strong>&nbsp;{fastest.sensor.label}</strong>&nbsp;
          ({fastest.t.direction === 'up' ? '▲ rising' : '▼ falling'})
        </span>
      )}
    </div>
  );
}

// Plain toggle-button group, NOT role="tablist" — the ARIA tabs pattern
// promises arrow-key navigation and panel wiring we don't implement, which
// would mislead screen-reader users. aria-pressed says everything needed.
function RangeSelector({ range, onSelect, hint }) {
  return (
    <div className="range-bar" id="analytics-range">
      <div className="range-tabs" role="group" aria-label="Trend time range">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button" aria-pressed={range === r.id}
            className={`range-tabs__tab${range === r.id ? ' is-active' : ''}`}
            onClick={() => onSelect(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {hint && <span className="range-bar__hint">{hint}</span>}
    </div>
  );
}

export default function AnalyticsPage({ series }) {
  const [range, setRange] = useState('live');
  const isLive = range === 'live';

  // Forecast + trend describe the live short-horizon model, not the recorded
  // past — pause their polls entirely while a historical range is shown.
  const { data: forecast } = useForecast(POLL_INTERVALS.forecast, isLive);
  const { data: trend } = useTrend(POLL_INTERVALS.trend, isLive);
  // Only fetches when a non-live range is selected (null pauses the poll);
  // `range` is the poll key, so switching refetches and drops stale responses.
  const { data: history, loading: historyLoading } = useSeries(isLive ? null : range);

  // Memoized: this page re-renders on every poll tick, but the mapped series
  // only changes when a new history payload (or range) arrives.
  const historicalSeries = useMemo(
    () => buildSeriesFromPoints(history?.points, range),
    [history, range],
  );
  const points = history?.points ?? [];
  const chartSeries = isLive ? series : historicalSeries;

  const hint = isLive
    ? 'Live feed · one point every second'
    : history
      ? describeBucket(history.bucketSeconds)
      : 'Loading…';

  const chartForecast = isLive ? forecast : null;
  const chartTrend = isLive ? trend : null;

  // While a NEW range is loading, show the spinner rather than the previous
  // range's data under the new label — a mislabeled chart is worse than a
  // brief wait.
  const historyPending = !isLive && historyLoading;
  const historyEmpty = !isLive && !historyLoading && points.length === 0;

  return (
    <div className="dashboard" id="analytics">
      <RangeSelector range={range} onSelect={setRange} hint={hint} />

      {isLive && <TrendSummary trend={trend} />}

      {historyPending ? (
        <div className="dashboard__empty">
          <Spinner label="Loading historical trend…" />
        </div>
      ) : historyEmpty ? (
        <div className="dashboard__empty">No data recorded in this period yet.</div>
      ) : (
        <>
          <ChartGroup
            id="analytics-hydraulic"
            title="Hydraulic Performance"
            subtitle="Flow · Suction · Discharge"
            defs={HYDRAULIC_CHARTS}
            series={chartSeries}
            forecast={chartForecast}
            trend={chartTrend}
          />
          <ChartGroup
            id="analytics-mechanical"
            title="Mechanical Condition"
            subtitle="Speed · Vibration · Temperature"
            defs={MECHANICAL_CHARTS}
            series={chartSeries}
            forecast={chartForecast}
            trend={chartTrend}
          />
        </>
      )}
    </div>
  );
}
