// ─────────────────────────────────────────────────────────────────────────
// OverviewPage.jsx — management landing page.
// Executive summary verdict → page-summary row (one card per dashboard
// section, each clickable) → health strip → hero asset view (3D model /
// P&ID toggle) with the alarms + system-health rail → live KPI cards.
// ─────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useStats, useDrift, useProcessedLive, useForecast, useTrend, useSummary } from '../hooks/useSensorData.js';
import { isReadingStale } from '../utils/health.js';
import ExecutiveSummary, { buildSummary } from '../components/dashboard/ExecutiveSummary.jsx';
import HealthStrip from '../components/dashboard/HealthStrip.jsx';
import ProcessSchematic from '../components/dashboard/ProcessSchematic.jsx';
import PumpModel3D from '../components/dashboard/PumpModel3D.jsx';
import AlarmsPanel from '../components/dashboard/AlarmsPanel.jsx';
import SystemHealthPanel from '../components/dashboard/SystemHealthPanel.jsx';
import SensorCardGrid from '../components/dashboard/SensorCardGrid.jsx';
import { SENSORS } from '../utils/constants.js';

// One card per dashboard section — the "summary of the other pages" a
// manager scans before deciding where to click. Each card links to its
// page. Values are derived from data Overview already polls; nothing is
// fetched twice.
function PageSummaryRow({ reading, trend, forecast, processed }) {
  const running = reading?.status === 'RUNNING';
  const trendEntries = trend ? SENSORS.map((s) => trend[s.key]).filter(Boolean) : [];
  const moving = trendEntries.filter((t) => t.direction !== 'stable').length;
  const { outlook } = buildSummary(reading, forecast, trend);
  const watchCount = outlook.filter((o) => o.severity === 2).length;
  const confidence = processed?.qualityLabel === 'GOOD' ? 'High'
    : processed?.qualityLabel === 'FAIR' ? 'Medium'
      : processed?.qualityLabel === 'POOR' ? 'Low' : '—';

  const cards = [
    {
      href: '#/overview', label: 'Pumps running',
      value: reading ? `${running ? 1 : 0} / 1` : '—',
      sub: reading ? (running ? 'All assets in service' : `Pump is ${(reading.status || 'offline').toLowerCase()}`) : 'Connecting…',
      tone: !reading ? 'muted' : running ? 'ok' : 'warn',
    },
    {
      href: '#/analytics', label: 'Trends',
      value: trendEntries.length ? `${trendEntries.length - moving} / ${trendEntries.length} steady` : '—',
      sub: moving > 0 ? `${moving} reading${moving > 1 ? 's' : ''} on the move` : 'No unusual movement',
      tone: moving > 0 ? 'warn' : 'ok',
    },
    {
      href: '#/predict', label: 'Predictions',
      value: watchCount > 0 ? `${watchCount} to watch` : 'Clear',
      sub: watchCount > 0 ? 'Forecast flags something ahead' : 'AI model in development',
      tone: watchCount > 0 ? 'warn' : 'muted',
    },
    {
      href: '#/reports', label: 'Data confidence',
      value: confidence,
      sub: confidence === '—' ? 'Collecting first minute…' : 'Quality of the numbers shown',
      tone: confidence === 'High' ? 'ok' : confidence === '—' ? 'muted' : 'warn',
    },
  ];

  return (
    <div className="page-summary" role="navigation" aria-label="Section summaries">
      {cards.map((c) => (
        <a key={c.href + c.label} href={c.href} className={`page-summary__card page-summary__card--${c.tone}`}>
          <span className="page-summary__label">{c.label}</span>
          <span className="page-summary__value">{c.value}</span>
          <span className="page-summary__sub">{c.sub}</span>
          <span className="page-summary__arrow" aria-hidden="true">→</span>
        </a>
      ))}
    </div>
  );
}

export default function OverviewPage({ reading, series, health, healthError }) {
  const { data: stats } = useStats(5000);
  const { data: drift } = useDrift();
  const { data: processed } = useProcessedLive();
  const { data: forecast } = useForecast();
  const { data: trend } = useTrend();
  const { data: summary } = useSummary('24h');
  const [view, setView] = useState('model'); // 'model' | 'pid'

  // A frozen number must never look live: if the newest reading is older than
  // 10 s the feed has stalled — gray the KPI cards so the values read as
  // "last known", not "now". Recomputed each render (the 1 s poll re-renders
  // even when it keeps returning the same reading).
  const stale = isReadingStale(reading, 10);

  return (
    <div className="dashboard" id="dashboard">
      <section className="dashboard__section" id="summary">
        <ExecutiveSummary reading={reading} forecast={forecast} trend={trend} />
      </section>

      <section className="dashboard__section" id="page-summary">
        <PageSummaryRow reading={reading} trend={trend} forecast={forecast} processed={processed} />
      </section>

      <section className="dashboard__section" id="health">
        <HealthStrip reading={reading} summary={summary} />
      </section>

      <section className="dashboard__section hero-row" id="schematic">
        <div className="hero-view">
          <div className="hero-view__tabs" role="tablist" aria-label="Asset view">
            <button
              type="button" role="tab" aria-selected={view === 'model'}
              className={`hero-view__tab${view === 'model' ? ' is-active' : ''}`}
              onClick={() => setView('model')}
            >
              3D Model
            </button>
            <button
              type="button" role="tab" aria-selected={view === 'pid'}
              className={`hero-view__tab${view === 'pid' ? ' is-active' : ''}`}
              onClick={() => setView('pid')}
            >
              P&amp;ID
            </button>
          </div>
          {view === 'model'
            ? <PumpModel3D reading={reading} />
            : <ProcessSchematic reading={reading} series={series} />}
        </div>
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

      {/* Per-sensor KPI cards (formerly the Telemetry page). */}
      <section className="dashboard__section" id="sensors">
        <div className="dashboard__section-header">
          <span className="dashboard__section-title">Live Readings</span>
          <span className="dashboard__section-hint">All six measurements · updates every second</span>
        </div>
        <SensorCardGrid reading={reading} series={series} stale={stale} />
      </section>
    </div>
  );
}
