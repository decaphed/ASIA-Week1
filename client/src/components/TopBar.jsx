import { memo } from 'react';
import { useClock } from '../hooks/useClock.js';
import { buttonReset } from './Card.jsx';

const PAGE_TITLES = {
  overview: 'Operations Overview',
  analytics: 'Analytics & Trends',
  predictions: 'Predictions & Fault Review',
  reports: 'Reports & Audit',
  train: 'Train Model',
};

function TopBar({ page, live, pendingCount, onOpenReview }) {
  const now = useClock();

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'rgba(241,244,248,0.92)', backdropFilter: 'blur(6px)', borderBottom: '1px solid #e3e9ef', padding: '14px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{PAGE_TITLES[page]}</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#ffffff', border: '1px solid #dde4ea', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#5f6f7e', fontWeight: 500 }}>
        <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="7.4" stroke="#1F3A6E" strokeWidth="1.7" />
          <path d="M10 10 L10 4.4 M10 10 L14.9 12.8" stroke="#1F3A6E" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        P-101 · Cooling Water Pump
      </div>
      <div style={{ flex: 1 }} />
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#5f6f7e', fontWeight: 500 }}>
        <span
          aria-hidden="true"
          style={{ width: 7, height: 7, borderRadius: '50%', background: live ? '#177E4D' : '#B3282D', animation: live ? 'pulse 1.6s infinite' : 'none' }}
        />
        {live ? 'LIVE' : 'NO LIVE DATA'}{' '}
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: '#33475a' }}>{now.toTimeString().slice(0, 8)}</span>
      </div>
      {pendingCount > 0 && (
        <button
          type="button"
          className="hover-review-cta"
          onClick={onOpenReview}
          style={{ ...buttonReset, display: 'flex', alignItems: 'center', gap: 8, background: '#E9EEF6', border: '1px solid #C4D0E3', borderRadius: 6, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, color: '#132342' }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
            <path d="M2 8.6 L5 8.6 L6.4 12 L9.6 4 L11 8.6 L14 8.6" stroke="#1F3A6E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {pendingCount} detection{pendingCount === 1 ? '' : 's'} need{pendingCount === 1 ? 's' : ''} review
        </button>
      )}
    </div>
  );
}

// Memoised so App's 1 Hz live tick doesn't re-render the header; the clock
// inside re-renders on its own interval.
export default memo(TopBar);
