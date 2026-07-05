// ─────────────────────────────────────────────────────────────────────────
// DashboardPage.jsx — the main screen; wires the data hooks to the widgets.
//
// It runs three polls:
//   • useLiveData(1000) → newest reading → cards + feeds the chart windows.
//   • useStats(5000)    → aggregate stats panel.
//   • useHistory(5000)  → latest 100 rows → history table.
//
// It also maintains a rolling window of recent points per pump metric (flowRate,
// rpm, vibration, suctionPressure, dischargePressure, motorTemp) so the live
// charts scroll. We de-duplicate by timestamp
// so a repeated poll (same reading) doesn't add a duplicate chart point.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { useLiveData, useHistory, useStats } from '../hooks/useSensorData.js';
import Card from '../components/ui/Card.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import ErrorBanner from '../components/ui/ErrorBanner.jsx';
import SensorCardGrid from '../components/dashboard/SensorCardGrid.jsx';
import StatsPanel from '../components/dashboard/StatsPanel.jsx';
import LiveChart from '../components/charts/LiveChart.jsx';
import HistoryTable from '../components/tables/HistoryTable.jsx';
import { CHART_WINDOW } from '../utils/constants.js';
import { formatTime } from '../utils/formatters.js';

const CHART_DEFS = [
  { key: 'flowRate',          label: 'Flow Rate',          unit: 'L/min', color: '#34d399' },
  { key: 'rpm',               label: 'RPM',                unit: 'rpm',   color: '#f97316' },
  { key: 'vibration',         label: 'Vibration',          unit: 'mm/s',  color: '#f43f5e' },
  { key: 'suctionPressure',   label: 'Suction Pressure',   unit: 'bar',   color: '#38bdf8' },
  { key: 'dischargePressure', label: 'Discharge Pressure', unit: 'bar',   color: '#a78bfa' },
  { key: 'motorTemp',         label: 'Motor Temp',         unit: '°C',    color: '#fb923c' },
];

export default function DashboardPage() {
  const { data: reading, error: liveError, loading: liveLoading, refresh } = useLiveData(1000);
  const { data: history, error: historyError } = useHistory(5000);
  const { data: stats } = useStats(5000);

  // Rolling chart windows: one array per metric key
  const [series, setSeries] = useState({
    flowRate: [], rpm: [], vibration: [],
    suctionPressure: [], dischargePressure: [], motorTemp: [],
  });
  const lastTsRef = useRef(null);

  useEffect(() => {
    if (!reading || !reading.timestamp) return;
    if (lastTsRef.current === reading.timestamp) return; // same reading → skip
    lastTsRef.current = reading.timestamp;

    const t = formatTime(reading.timestamp);
    setSeries((prev) => {
      const next = {};
      for (const key of ['flowRate', 'rpm', 'vibration', 'suctionPressure', 'dischargePressure', 'motorTemp']) {
        next[key] = [...prev[key], { t, v: reading[key] }].slice(-CHART_WINDOW);
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
          title="Backend offline"
          message="Cannot reach the API. Make sure the server is running on port 3000."
          onRetry={refresh}
        />
      )}

      {/* Live sensor cards */}
      <section className="dashboard__section" id="sensors">
        <SensorCardGrid reading={reading} />
      </section>

      {/* Aggregate statistics (also the "Settings" nav target — the closest thing to a system/config view) */}
      <Card id="settings" title="System Statistics" subtitle="Aggregated across all stored readings">
        <StatsPanel stats={stats} />
      </Card>

      {/* Live charts */}
      <section className="dashboard__charts" id="analytics">
        {CHART_DEFS.map((c) => (
          <Card key={c.key} title={`${c.label} — live`}>
            <LiveChart label={c.label} unit={c.unit} color={c.color} points={series[c.key]} />
          </Card>
        ))}
      </section>

      {/* Historical table */}
      <Card
        id="history"
        title="Historical Readings"
        subtitle="Latest 100 stored readings · auto-refreshes every 5s"
      >
        {historyError && rows.length === 0 ? (
          <ErrorBanner title="Could not load history" message="Retrying automatically…" />
        ) : rows.length === 0 ? (
          <div className="dashboard__empty">
            {liveLoading ? (
              <Spinner label="Waiting for data…" />
            ) : (
              'No readings yet. Start the Node-RED flow to begin ingesting data.'
            )}
          </div>
        ) : (
          <HistoryTable rows={rows} />
        )}
      </Card>
    </div>
  );
}
