// ─────────────────────────────────────────────────────────────────────────
// TelemetryPage.jsx — live KPI cards for all six sensor channels, plus the
// manual test-reading form (operator input lives with the live values).
// ─────────────────────────────────────────────────────────────────────────

import Card from '../components/ui/Card.jsx';
import SensorCardGrid from '../components/dashboard/SensorCardGrid.jsx';
import ManualReadingForm from '../components/dashboard/ManualReadingForm.jsx';
import { formatTime } from '../utils/formatters.js';

export default function TelemetryPage({ reading, series, refresh }) {
  return (
    <div className="dashboard" id="telemetry">
      <section className="dashboard__section" id="sensors">
        <div className="dashboard__section-header">
          <span className="dashboard__section-title">Live Machine Telemetry</span>
          <span className="dashboard__section-hint">
            6 channels · updated {reading?.timestamp ? formatTime(reading.timestamp) : '--'}
          </span>
        </div>
        <SensorCardGrid reading={reading} series={series} />
      </section>

      <Card
        id="manual-entry"
        title="Manual Test Reading"
        subtitle="For testing only — records a one-off reading outside the normal sensor feed"
      >
        <ManualReadingForm onSubmitted={refresh} />
      </Card>
    </div>
  );
}
