// ─────────────────────────────────────────────────────────────────────────
// Sidebar.jsx — fixed navigation rail.
// v3: pump-specific brand, industrial nav icons from Icons.jsx.
// ─────────────────────────────────────────────────────────────────────────

import {
  DashboardNavIcon, SensorsNavIcon, HistoryNavIcon,
  AnalyticsNavIcon, SettingsNavIcon,
} from '../ui/Icons.jsx';
import { PUMP_ID } from '../../utils/constants.js';

const NAV_ITEMS = [
  { label: 'Overview',  Icon: DashboardNavIcon, href: '#dashboard', active: true },
  { label: 'Live KPIs', Icon: SensorsNavIcon,   href: '#sensors' },
  { label: 'Trends',    Icon: AnalyticsNavIcon, href: '#analytics' },
  { label: 'Statistics',Icon: SettingsNavIcon,  href: '#settings' },
  { label: 'Data Log',  Icon: HistoryNavIcon,   href: '#history' },
];

export default function Sidebar() {
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
        {NAV_ITEMS.map(({ label, Icon, href, active }) => (
          <a
            key={label}
            href={href}
            className={`sidebar__link${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="sidebar__icon"><Icon /></span>
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__footer-dot" aria-hidden="true" />
        <span className="sidebar__footer-text">v3.0 · Pump Monitor</span>
      </div>
    </aside>
  );
}
