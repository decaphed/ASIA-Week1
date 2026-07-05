// ─────────────────────────────────────────────────────────────────────────
// App.jsx — the application shell.
//
// Lays out the fixed Sidebar + (Topbar over the scrolling Dashboard). It owns
// the single /api/health poll and passes the result down to the Topbar so the
// three connection indicators stay in sync. All sensor data lives further down
// in DashboardPage.
// ─────────────────────────────────────────────────────────────────────────

import Sidebar from './components/layout/Sidebar.jsx';
import Topbar from './components/layout/Topbar.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import { useHealth } from './hooks/useSensorData.js';

export default function App() {
  const { data: health, error: healthError } = useHealth(5000);

  return (
    <div className="app">
      <Sidebar />
      <div className="app__main">
        <Topbar health={health} healthError={healthError} />
        <main className="app__content">
          <DashboardPage />
        </main>
      </div>
    </div>
  );
}
