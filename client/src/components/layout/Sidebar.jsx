// ─────────────────────────────────────────────────────────────────────────
// Sidebar.jsx — fixed left navigation rail.
// SVG icons replace the old Unicode glyphs for consistent cross-platform
// rendering. Active state is still static (Dashboard) — scroll tracking
// is a future enhancement noted in the architecture report.
// ─────────────────────────────────────────────────────────────────────────

const base = {
  width: 16, height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

function DashboardIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SensorsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M12 20V10" />
      <path d="M18 20V4" />
      <path d="M6 20v-4" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <polyline points="12 8 12 12 14 14" />
      <path d="M3.05 11a9 9 0 1 0 .5-3M3 4v4h4" />
    </svg>
  );
}

function AnalyticsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

const NAV_ITEMS = [
  { label: 'Dashboard', Icon: DashboardIcon, href: '#dashboard', active: true },
  { label: 'Sensors',   Icon: SensorsIcon,   href: '#sensors' },
  { label: 'History',   Icon: HistoryIcon,   href: '#history' },
  { label: 'Analytics', Icon: AnalyticsIcon, href: '#analytics' },
  { label: 'Settings',  Icon: SettingsIcon,  href: '#settings' },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__logo" aria-hidden="true">IO</div>
        <div className="sidebar__brand-text">
          <strong>IoTScada</strong>
          <span>Control Room</span>
        </div>
      </div>

      <span className="sidebar__section-label">Navigation</span>

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
        <span className="sidebar__footer-text">v2.0 · Live Data Dashboard</span>
      </div>
    </aside>
  );
}
