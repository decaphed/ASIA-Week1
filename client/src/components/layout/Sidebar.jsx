// ─────────────────────────────────────────────────────────────────────────
// Sidebar.jsx — the fixed left navigation rail (the "control room" chrome).
//
// The nav items are placeholders for a single-page dashboard; they show the
// intended structure of a larger SCADA app. "Dashboard" is marked active.
// ─────────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { label: 'Dashboard', icon: '▣', href: '#dashboard', active: true },
  { label: 'Sensors', icon: '◈', href: '#sensors' },
  { label: 'History', icon: '≡', href: '#history' },
  { label: 'Analytics', icon: '◉', href: '#analytics' },
  { label: 'Settings', icon: '⚙', href: '#settings' },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        {/* Company/logo placeholder */}
        <div className="sidebar__logo">IO</div>
        <div className="sidebar__brand-text">
          <strong>IoTScada</strong>
          <span>Control Room</span>
        </div>
      </div>

      <nav className="sidebar__nav">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className={`sidebar__link ${item.active ? 'is-active' : ''}`}
          >
            <span className="sidebar__icon">{item.icon}</span>
            <span>{item.label}</span>
          </a>
        ))}
      </nav>

      <div className="sidebar__footer">v1.0.0 · Live Data Dashboard</div>
    </aside>
  );
}
