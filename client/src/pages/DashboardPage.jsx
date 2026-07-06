// ─────────────────────────────────────────────────────────────────────────
// DashboardPage.jsx — pump monitoring dashboard.
// v4 (V2 Handoff Spec): health strip, process schematic hero + alarms/system
//     health rail sit above the KPI cards; live reading now comes from App
//     (single shared /api/live poll) instead of its own hook call.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { useHistory, useStats, useForecast } from '../hooks/useSensorData.js';
import Card from '../components/ui/Card.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import ErrorBanner from '../components/ui/ErrorBanner.jsx';
import HealthStrip from '../components/dashboard/HealthStrip.jsx';
import ProcessSchematic from '../components/dashboard/ProcessSchematic.jsx';
import AlarmsPanel from '../components/dashboard/AlarmsPanel.jsx';
import SystemHealthPanel from '../components/dashboard/SystemHealthPanel.jsx';
import SensorCardGrid from '../components/dashboard/SensorCardGrid.jsx';
import StatsPanel from '../components/dashboard/StatsPanel.jsx';
import LiveChart from '../components/charts/LiveChart.jsx';
import HistoryTable from '../components/tables/HistoryTable.jsx';
import ManualReadingForm from '../components/dashboard/ManualReadingForm.jsx';
import { CHART_WINDOW, SENSORS } from '../utils/constants.js';
import { formatTime } from '../utils/formatters.js';

// Build chart defs from SENSORS so thresholds stay in one place (constants.js)
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

function ChartGroup({ title, subtitle, defs, series, forecast, id }) {
  return (
    <div className="chart-group" id={id}>
      <div className="chart-group__header">
        <h3 className="chart-group__title">{title}</h3>
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
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DashboardPage({ reading, liveError, liveLoading, refresh, health, healthError }) {
  const { data: history, error: historyError } = useHistory(5000);
  const { data: stats } = useStats(5000);
  const { data: forecast } = useForecast();

  const [series, setSeries] = useState(
    Object.fromEntries(SENSORS.map((s) => [s.key, []]))
  );
  const lastTsRef = useRef(null);

  useEffect(() => {
    if (!reading?.timestamp) return;
    if (lastTsRef.current === reading.timestamp) return;
    lastTsRef.current = reading.timestamp;

    const t = formatTime(reading.timestamp);
    setSeries((prev) => {
      const next = {};
      for (const s of SENSORS) {
        next[s.key] = [...prev[s.key], { t, v: reading[s.key] }].slice(-CHART_WINDOW);
      }
      return next;
    });
  }, [reading]);

  const backendOffline = Boolean(liveError);
  const rows = history?.data ?? [];

  return (
    <div className="dashboard" id="dashboard">

      {backendOffline && (
        <ErrorBanner
          title="Connection lost — Backend unreachable"
          message="Cannot reach the API on port 3000. Displaying last known values."
          onRetry={refresh}
        />
      )}

      {/* ── 1. Health Strip ────────────────────────────────────────────── */}
      <section className="dashboard__section" id="health">
        <HealthStrip reading={reading} uptimeSeconds={health?.uptimeSeconds} />
      </section>

      {/* ── 2. Process Schematic + Alarms/System Health rail ──────────── */}
      <section className="dashboard__section hero-row" id="schematic">
        <ProcessSchematic reading={reading} />
        <div className="hero-row__rail">
          <AlarmsPanel reading={reading} />
          <SystemHealthPanel health={health} healthError={healthError} stats={stats} />
        </div>
      </section>

      {/* ── 3. KPI Cards ───────────────────────────────────────────────── */}
      <section className="dashboard__section" id="sensors">
        <div className="dashboard__section-header">
          <span className="dashboard__section-title">Live Machine Telemetry</span>
          <span className="dashboard__section-hint">6 channels · updated {reading?.timestamp ? formatTime(reading.timestamp) : '--'}</span>
        </div>
        <SensorCardGrid reading={reading} series={series} />
      </section>

      {/* ── 4. Trend Charts — Hydraulic Performance ───────────────────── */}
      <section className="dashboard__section" id="analytics">
        <ChartGroup
          id="analytics-hydraulic"
          title="Hydraulic Performance"
          subtitle="Flow · Suction · Discharge"
          defs={HYDRAULIC_CHARTS}
          series={series}
          forecast={forecast}
        />

        {/* ── 5. Trend Charts — Mechanical Condition ───────────────────── */}
        <ChartGroup
          id="analytics-mechanical"
          title="Mechanical Condition"
          subtitle="Speed · Vibration · Temperature"
          defs={MECHANICAL_CHARTS}
          series={series}
          forecast={forecast}
        />
      </section>

      {/* ── 6. Manual Test Reading ───────────────────────────────────── */}
      <Card
        id="manual-entry"
        title="Manual Test Reading"
        subtitle="Submit one reading directly to POST /api/data — bypasses Node-RED"
      >
        <ManualReadingForm onSubmitted={refresh} />
      </Card>

      {/* ── 7. Aggregate Statistics ───────────────────────────────────── */}
      <Card id="settings" title="Operating Statistics" subtitle="Session averages across all stored readings">
        <StatsPanel stats={stats} />
      </Card>

      {/* ── 8. Event / Data Log ───────────────────────────────────────── */}
      <Card
        id="history"
        title="Data Log"
        subtitle="Latest 100 readings · search &amp; sort · refreshes every 5 s"
      >
        {historyError && rows.length === 0 ? (
          <ErrorBanner title="Could not load data log" message="Retrying automatically…" />
        ) : rows.length === 0 ? (
          <div className="dashboard__empty">
            {liveLoading
              ? <Spinner label="Awaiting first reading…" />
              : 'No data yet. Start the Node-RED flow to begin.'}
          </div>
        ) : (
          <HistoryTable rows={rows} />
        )}
      </Card>

    </div>
  );
}
