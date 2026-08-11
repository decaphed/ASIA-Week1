// ─────────────────────────────────────────────────────────────────────────
// Sidebar.jsx — fixed navigation rail.
// v4: hash-route navigation between the four pages; active state comes
//     from the current route instead of being hardcoded.
// ─────────────────────────────────────────────────────────────────────────

import { Signal, Server, Database } from 'lucide-react';
import {
  DashboardNavIcon, AnalyticsNavIcon, PredictNavIcon, ReviewNavIcon, ReportsNavIcon, LogOutIcon,
} from '../ui/Icons.jsx';
import { PUMP_ID } from '../../utils/constants.js';
import { computeServiceStatus } from '../../utils/health.js';

// Telemetry was retired as a destination: its KPI cards moved to Overview
// (the at-a-glance layer management wants on landing) and its manual test
// form to Reports' engineering-tools disclosure. Predictions is the new
// fourth mode — "what's coming" — and the future home of the AI/ML
// failure-prediction model.
const NAV_ITEMS = [
  { label: 'Overview',     Icon: DashboardNavIcon, route: 'overview' },
  { label: 'Analytics',    Icon: AnalyticsNavIcon, route: 'analytics' },
  { label: 'Predictions',  Icon: PredictNavIcon,   route: 'predict' },
  { label: 'Fault Review', Icon: ReviewNavIcon,    route: 'review' },
  { label: 'Reports',      Icon: ReportsNavIcon,   route: 'reports' },
];

const STATUS_ITEMS = [
  { key: 'backend', label: 'API', Icon: Signal },
  { key: 'nodeRed', label: 'Network', Icon: Server },
  { key: 'database', label: 'Data Feed', Icon: Database },
];

export default function Sidebar({ route, health, healthError }) {
  const serviceStatus = computeServiceStatus(health, healthError);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
          </svg>
        </div>
        <div className="sidebar__brand-text">
          <strong>PumpScada</strong>
          <span>{PUMP_ID}</span>
        </div>
      </div>

      <div className="sidebar__section-label">Monitor</div>

      <nav className="sidebar__nav" aria-label="Main navigation">
        {NAV_ITEMS.map(({ label, Icon, route: r }) => {
          const active = route === r;
          return (
            <a
              key={r}
              href={`#/${r}`}
              className={`sidebar__link${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <span className="sidebar__icon"><Icon /></span>
              <span>{label}</span>
            </a>
          );
        })}
      </nav>

      <div className="sidebar__section-label">System Status</div>
      <div className="sidebar__status" aria-live="polite">
        {STATUS_ITEMS.map(({ key, label, Icon }) => (
          <div key={key} className="sidebar__status-row">
            <span className="sidebar__status-label">
              <Icon width={12} height={12} /> {label}
            </span>
            <span
              className={`sidebar__status-dot sidebar__status-dot--${serviceStatus[key]}`}
              role="status"
              aria-label={`${label}: ${serviceStatus[key]}`}
            />
          </div>
        ))}
      </div>

      <div className="sidebar__logout-section">
        <a href="/outpost.goauthentik.io/sign_out?rd=/" className="sidebar__link">
          <span className="sidebar__icon"><LogOutIcon /></span>
          <span>Log Out</span>
        </a>
      </div>

      <div className="sidebar__footer">
        <div className="sidebar__footer-dot" aria-hidden="true" />
        <span className="sidebar__footer-text">v4.0 · Pump Monitor</span>
      </div>
    </aside>
  );
}
