// ─────────────────────────────────────────────────────────────────────────
// OverviewPage.jsx — management landing page.
// Health strip up top, then the interactive process schematic (hover any
// component for its live data) with the alarms / system-health rail.
// ─────────────────────────────────────────────────────────────────────────

import { useStats, useDrift, useProcessedLive } from '../hooks/useSensorData.js';
import HealthStrip from '../components/dashboard/HealthStrip.jsx';
import ProcessSchematic from '../components/dashboard/ProcessSchematic.jsx';
import AlarmsPanel from '../components/dashboard/AlarmsPanel.jsx';
import SystemHealthPanel from '../components/dashboard/SystemHealthPanel.jsx';

export default function OverviewPage({ reading, series, health, healthError }) {
  const { data: stats } = useStats(5000);
  const { data: drift } = useDrift();
  const { data: processed } = useProcessedLive();

  return (
    <div className="dashboard" id="dashboard">
      <section className="dashboard__section" id="health">
        <HealthStrip reading={reading} uptimeSeconds={health?.uptimeSeconds} />
      </section>

      <section className="dashboard__section hero-row" id="schematic">
        <ProcessSchematic reading={reading} series={series} />
        <div className="hero-row__rail">
          <AlarmsPanel reading={reading} />
          <SystemHealthPanel
            health={health}
            healthError={healthError}
            stats={stats}
            drift={drift}
            processed={processed}
          />
        </div>
      </section>
    </div>
  );
}
