// ─────────────────────────────────────────────────────────────────────────
// App.jsx — the application shell.
//
// Lays out the fixed Sidebar + (Topbar over the scrolling page area) and
// routes between the four pages via the URL hash (useHashRoute). It owns:
//   • the single /api/health poll and the single /api/live poll — shared by
//     the Topbar and every page;
//   • the rolling `series` buffer built from live readings — lifted here so
//     the chart history survives page switches (pages unmount on navigate);
//   • the light/dark theme state.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/layout/Sidebar.jsx';
import Topbar from './components/layout/Topbar.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import TelemetryPage from './pages/TelemetryPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import ErrorBanner from './components/ui/ErrorBanner.jsx';
import { useHealth, useLiveData } from './hooks/useSensorData.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { useTheme } from './hooks/useTheme.js';
import { countAlarms } from './utils/health.js';
import { CHART_WINDOW, SENSORS } from './utils/constants.js';
import { formatTime } from './utils/formatters.js';

const PAGES = {
  overview:  OverviewPage,
  telemetry: TelemetryPage,
  analytics: AnalyticsPage,
  reports:   ReportsPage,
};

export default function App() {
  const route = useHashRoute();
  const { theme, toggle: toggleTheme } = useTheme();
  const { data: health, error: healthError } = useHealth(5000);
  const { data: reading, error: liveError, loading: liveLoading, refresh } = useLiveData(1000);

  // Rolling per-metric series for sparklines & trend charts. Lives here (not
  // in a page) so navigating between pages doesn't reset chart history.
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

  const { alarms, warns } = countAlarms(reading);
  const Page = PAGES[route];

  return (
    <div className="app">
      <Sidebar route={route} />
      <div className="app__main">
        <Topbar
          health={health}
          healthError={healthError}
          alarmCount={alarms + warns}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <main className="app__content">
          {liveError && (
            <ErrorBanner
              title="Connection lost — Backend unreachable"
              message="Cannot reach the API on port 3000. Displaying last known values."
              onRetry={refresh}
            />
          )}
          <Page
            reading={reading}
            series={series}
            liveLoading={liveLoading}
            refresh={refresh}
            health={health}
            healthError={healthError}
          />
        </main>
      </div>
    </div>
  );
}
