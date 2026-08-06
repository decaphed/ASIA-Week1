// ─────────────────────────────────────────────────────────────────────────
// FaultReviewPage.jsx — Fault Review Queue (Phase 1: list view, read-only).
// Detail/review-form view lands in Phase 2 at #/review/:id.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import Card from '../components/ui/Card.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import ErrorBanner from '../components/ui/ErrorBanner.jsx';
import FaultQueueTable from '../components/pdm/FaultQueueTable.jsx';
import FaultReviewDetailPage from './FaultReviewDetailPage.jsx';
import { useFaultEvents } from '../hooks/useFaultEvents.js';

const FILTERS = [
  { label: 'Pending', value: 'PENDING_REVIEW' },
  { label: 'Confirmed', value: 'CONFIRMED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'All', value: undefined },
];

export default function FaultReviewPage({ param }) {
  const [statusFilter, setStatusFilter] = useState('PENDING_REVIEW');
  const { data: events, error, loading, refresh } = useFaultEvents(statusFilter, undefined, !param);

  const rows = useMemo(() => {
    if (!events) return [];
    // "All" fetches the unfiltered set, which includes NEGATIVE_SAMPLE rows
    // (ML training data, status N/A, never need human review) — those are
    // never shown in this UI, even under "All".
    if (statusFilter !== undefined) return events;
    return events.filter((e) => e.eventType !== 'NEGATIVE_SAMPLE');
  }, [events, statusFilter]);

  const hiddenCount = statusFilter === undefined && events ? events.length - rows.length : 0;

  if (param) {
    return <FaultReviewDetailPage id={param} />;
  }

  return (
    <div className="dashboard" id="review">
      <Card title="Fault Review Queue" subtitle="Flagged events awaiting a human decision">
        <div className="review-filters" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              aria-pressed={statusFilter === f.value}
              className={`review-filters__tab${statusFilter === f.value ? ' is-active' : ''}`}
              onClick={() => setStatusFilter(f.value)}
            >
              {f.label}
              {loading && statusFilter === f.value && (
                <span className="review-updating-tag">…</span>
              )}
            </button>
          ))}
        </div>

        {error && rows.length === 0 ? (
          <ErrorBanner title="Could not load the review queue" onRetry={refresh} />
        ) : !events ? (
          <Spinner label="Loading review queue…" />
        ) : rows.length === 0 && !loading ? (
          <div className="dashboard__empty">
            {statusFilter === 'PENDING_REVIEW'
              ? 'Nothing to review — no flagged events are waiting.'
              : 'No events match this filter.'}
          </div>
        ) : (
          <div className={loading ? 'review-table--loading' : undefined}>
            {error && (
              <div className="review-stale-warning">Showing last known data — retrying…</div>
            )}
            {/* key={statusFilter} remounts the table on filter change, so its
                internal search/sort/page state (and the stale-filter rows it
                was rendering) don't leak across tabs while a new fetch is
                in flight. */}
            <FaultQueueTable key={statusFilter ?? 'all'} events={rows} />
          </div>
        )}

        {statusFilter === undefined && hiddenCount > 0 && (
          <p className="review-footnote">{hiddenCount} negative training samples hidden</p>
        )}
      </Card>
    </div>
  );
}
