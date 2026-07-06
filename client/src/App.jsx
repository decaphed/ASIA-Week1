// ─────────────────────────────────────────────────────────────────────────
// App.jsx — the application shell.
//
// Lays out the fixed Sidebar + (Topbar over the scrolling Dashboard). It owns
// the single /api/health poll AND the single /api/live poll — both the
// Topbar (status pills + notification bell) and DashboardPage need them, so
// they're fetched once here and passed down.
// ─────────────────────────────────────────────────────────────────────────

import Sidebar from './components/layout/Sidebar.jsx';
import Topbar from './components/layout/Topbar.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import { useHealth, useLiveData } from './hooks/useSensorData.js';
import { countAlarms } from './utils/health.js';

export default function App() {
  const { data: health, error: healthError } = useHealth(5000);
  const { data: reading, error: liveError, loading: liveLoading, refresh } = useLiveData(1000);

  const { alarms, warns } = countAlarms(reading);

  return (
    <div className="app">
      <Sidebar />
      <div className="app__main">
        <Topbar health={health} healthError={healthError} alarmCount={alarms + warns} />
        <main className="app__content">
          <DashboardPage
            reading={reading}
            liveError={liveError}
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
