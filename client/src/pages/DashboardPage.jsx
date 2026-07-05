// ─────────────────────────────────────────────────────────────────────────
// DashboardPage.jsx — the main screen; wires the data hooks to the widgets.
//
// It runs three polls:
//   • useLiveData(1000) → newest reading → cards + feeds the chart windows.
//   • useStats(5000)    → aggregate stats panel.
//   • useHistory(5000)  → latest 100 rows → history table.
//
// It also maintains a rolling window of recent points per metric (temperature,
// humidity, pressure) so the live charts scroll. We de-duplicate by timestamp
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
  { key: 'temperature', label: 'Temperature', unit: '°C', color: '#f97316' },
  { key: 'humidity', label: 'Humidity', unit: '%', color: '#38bdf8' },
  { key: 'pressure', label: 'Pressure', unit: 'hPa', color: '#a78bfa' },
];

export default function DashboardPage() {
  const { data: reading, error: liveError, loading: liveLoading, refresh } = useLiveData(1000);
  const { data: history, error: historyError } = useHistory(5000);
  const { data: stats } = useStats(5000);

  // Rolling chart windows: { temperature: [{t,v}], humidity: [...], pressure: [...] }
  const [series, setSeries] = useState({ temperature: [], humidity: [], pressure: [] });
  const lastTsRef = useRef(null);

  useEffect(() => {
    if (!reading || !reading.timestamp) return;
    if (lastTsRef.current === reading.timestamp) return; // same reading → skip
    lastTsRef.current = reading.timestamp;

    const t = formatTime(reading.timestamp);
    setSeries((prev) => {
      const next = {};
      for (const key of ['temperature', 'humidity', 'pressure']) {
        next[key] = [...prev[key], { t, v: reading[key] }].slice(-CHART_WINDOW);
      }
      return next;
    });
  }, [reading]);

  const backendOffline = Boolean(liveError);
  const rows = history?.data ?? [];

  return (
    <div className="dashboard">
      {backendOffline && (
        <ErrorBanner
          title="Backend offline"
          message="Cannot reach the API. Make sure the server is running on port 3000."
          onRetry={refresh}
        />
      )}

      {/* Live sensor cards */}
      <section className="dashboard__section">
        <SensorCardGrid reading={reading} />
      </section>

      {/* Aggregate statistics */}
      <Card title="System Statistics" subtitle="Aggregated across all stored readings">
        <StatsPanel stats={stats} />
      </Card>

      {/* Live charts */}
      <section className="dashboard__charts">
        {CHART_DEFS.map((c) => (
          <Card key={c.key} title={`${c.label} — live`}>
            <LiveChart label={c.label} unit={c.unit} color={c.color} points={series[c.key]} />
          </Card>
        ))}
      </section>

      {/* Historical table */}
      <Card
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
