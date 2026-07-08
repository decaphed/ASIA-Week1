// ─────────────────────────────────────────────────────────────────────────
// ReportsPage.jsx — aggregate statistics, sensor data-quality report, and
// the searchable data log. The "management" page: no live-tuning controls,
// just the numbers.
// ─────────────────────────────────────────────────────────────────────────

import { useHistory, useStats, useProcessedLive } from '../hooks/useSensorData.js';
import Card from '../components/ui/Card.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import ErrorBanner from '../components/ui/ErrorBanner.jsx';
import StatsPanel from '../components/dashboard/StatsPanel.jsx';
import ViolationsPanel from '../components/dashboard/ViolationsPanel.jsx';
import HistoryTable from '../components/tables/HistoryTable.jsx';
import ManualReadingForm from '../components/dashboard/ManualReadingForm.jsx';

export default function ReportsPage({ liveLoading, refresh }) {
  const { data: history, error: historyError } = useHistory(5000);
  const { data: stats } = useStats(5000);
  const { data: processed } = useProcessedLive();

  const rows = history?.data ?? [];

  return (
    <div className="dashboard" id="reports">
      <Card id="settings" title="Operating Statistics" subtitle="Session averages across all stored readings">
        <StatsPanel stats={stats} />
      </Card>

      <Card
        id="violations"
        title="Data Confidence"
        subtitle="How trustworthy the numbers on this page are right now"
      >
        <ViolationsPanel processed={processed} />
      </Card>

      <Card
        id="history"
        title="Data Log"
        subtitle="Latest 100 readings · updates automatically — detail view for engineers"
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

      {/* Engineering tool, deliberately demoted behind a disclosure so it
          never competes with the management content above (formerly its own
          card on the retired Telemetry page). */}
      <details className="eng-tools" id="manual-entry">
        <summary>Engineering tools — record a manual test reading</summary>
        <ManualReadingForm onSubmitted={refresh} />
      </details>
    </div>
  );
}
