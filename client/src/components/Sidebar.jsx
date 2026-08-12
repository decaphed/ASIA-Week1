import { memo } from 'react';
import logo from '../assets/logo.png';
import { buttonReset } from './Card.jsx';

const NAV_ICONS = {
  overview: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  analytics: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M1.8 13.5 L5.4 8.4 L8.6 10.8 L14.2 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.6 3 L14.2 3 L14.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  predictions: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M8 1.8 L14 5 L14 11 L8 14.2 L2 11 L2 5 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  reports: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 1.8 L10 1.8 L13 4.8 L13 14.2 L3 14.2 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.4 8 L10.6 8 M5.4 10.8 L10.6 10.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
};

const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'predictions', label: 'Predictions' },
  { id: 'reports', label: 'Reports' },
];

function Sidebar({ page, onNavigate, pendingCount, connected, reviewer, title, onLogout }) {
  const initials = reviewer
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <aside style={{ width: 230, flexShrink: 0, background: '#ffffff', borderRight: '1px solid #E2E8F0', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid #eef2f5', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <img src={logo} alt="ASIA" style={{ width: 158, display: 'block', objectFit: 'cover', objectPosition: 'center 30%', height: 50 }} />
        <div style={{ fontSize: 9.5, color: '#8a99a8', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, textAlign: 'center', lineHeight: 1.4 }}>
          Accelerated Services for<br />Instrument &amp; Automation
        </div>
      </div>

      <nav aria-label="Main" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 10px' }}>
        <h2 style={{ margin: 0, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a99a8', padding: '4px 12px 8px' }}>
          Monitor
        </h2>
        {PAGES.map((p) => {
          const active = page === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className="nav-item"
              onClick={() => onNavigate(p.id)}
              aria-current={active ? 'page' : undefined}
              style={{
                ...buttonReset,
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 6,
                fontSize: 13.5, fontWeight: active ? 600 : 500, width: '100%',
                color: active ? '#1F3A6E' : '#5f6f7e',
                background: active ? '#E9EEF6' : 'transparent',
              }}
            >
              {NAV_ICONS[p.id]}
              <span style={{ flex: 1, textAlign: 'left' }}>{p.label}</span>
              {p.id === 'predictions' && pendingCount > 0 && (
                <span style={{ background: '#B3282D', color: '#ffffff', fontSize: 11, fontWeight: 600, borderRadius: 9, padding: '1px 7px', fontVariantNumeric: 'tabular-nums' }}>
                  {pendingCount}
                  <span className="sr-only"> detections pending review</span>
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div style={{ marginTop: 'auto', padding: 14, borderTop: '1px solid #eef2f5', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5f6f7e', padding: '0 4px' }}>
          <span
            aria-hidden="true"
            style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? '#177E4D' : '#B3282D', animation: connected ? 'pulse 2.4s infinite' : 'none' }}
          />
          {connected ? 'Gateway connected · 1 s feed' : 'Gateway feed unavailable'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#f6f8fa', border: '1px solid #e6ebf0', borderRadius: 7, padding: '9px 10px' }}>
          <div aria-hidden="true" style={{ width: 28, height: 28, borderRadius: '50%', background: '#1F3A6E', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 600 }}>
            {initials || '–'}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reviewer}</div>
            <div style={{ fontSize: 11, color: '#8a99a8' }}>{title || 'Reliability Engineer'}</div>
          </div>
          <button
            type="button"
            className="hover-logout"
            onClick={onLogout}
            aria-label={`Log out ${reviewer}`}
            style={{ ...buttonReset, width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a99a8', flexShrink: 0 }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
              <path d="M6 2 L3 2 L3 14 L6 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10 5 L13 8 L10 11 M13 8 L6.5 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}

// Memoised: App re-renders at 1 Hz from the live feed, but this component's
// props only change on navigation or the 15 s fault-event poll.
export default memo(Sidebar);
