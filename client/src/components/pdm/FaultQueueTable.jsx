// ─────────────────────────────────────────────────────────────────────────
// FaultQueueTable.jsx — searchable, sortable, paginated fault_events queue.
// Modelled on components/tables/HistoryTable.jsx.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import RuleChip from './RuleChip.jsx';
import { formatDayTime, formatRelativeTime, formatDuration } from '../../utils/formatters.js';
import { ONGOING_WINDOW_SECONDS } from '../../utils/constants.js';
import { parseTriggeredRules } from '../../utils/faultRules.js';

const PAGE_SIZE = 15;

function statusPillClass(status) {
  if (status === 'PENDING_REVIEW') return 'pill--pending';
  if (status === 'CONFIRMED') return 'pill--confirmed';
  if (status === 'REJECTED') return 'pill--rejected';
  return 'pill--off';
}

function SortChevron({ dir }) {
  return dir === 'asc' ? (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ marginLeft: 4, verticalAlign: 'middle' }}>
      <path d="M2 7l3-4 3 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ) : (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ marginLeft: 4, verticalAlign: 'middle' }}>
      <path d="M2 3l3 4 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// The API returns `confidence` on every fault_events row (it flows through
// untouched on `event` below), but it is deliberately never rendered
// anywhere in this review UI. docs/plan/2026-08-05-pdm-implementation.md
// §3.2 (risk-register line 665) says not to surface confidence
// *prominently*; this plan hardens that guidance further — never, anywhere
// in the review UI, not even collapsed behind a disclosure. If you're here
// to add a "Confidence" column, don't — see the finalized plan §6.
const COLUMNS = [
  { key: 'id', label: 'Event', sortable: true },
  { key: 'detectedAt', label: 'Detected', sortable: true },
  { key: 'window', label: 'Window', sortable: false },
  { key: 'duration', label: 'Duration', sortable: true },
  { key: 'whatTripped', label: 'What tripped', sortable: false },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'reviewedBy', label: 'Reviewed by', sortable: false },
];

export default function FaultQueueTable({ events }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('id');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

  // Precompute derived, render-only fields once per events change so search/
  // sort don't re-parse triggeredRules on every keystroke.
  const enriched = useMemo(() => {
    return events.map((event) => {
      const rules = parseTriggeredRules(event.triggeredRules);
      const durationSeconds =
        event.faultStart && event.lastSeenWindowEnd
          ? (Date.parse(event.lastSeenWindowEnd) - Date.parse(event.faultStart)) / 1000
          : null;
      const isOngoing =
        event.status === 'PENDING_REVIEW' &&
        event.lastSeenWindowEnd &&
        (Date.now() - Date.parse(event.lastSeenWindowEnd)) / 1000 <= ONGOING_WINDOW_SECONDS;
      return { event, rules, durationSeconds, isOngoing };
    });
  }, [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? enriched.filter(({ event }) =>
          [event.id, event.faultType, event.triggeredRules, event.reviewedBy]
            .join(' ')
            .toLowerCase()
            .includes(q)
        )
      : enriched;

    const sorted = [...matched].sort((a, b) => {
      let av, bv;
      switch (sortKey) {
        case 'detectedAt':
          av = Date.parse(a.event.detectedAt) || 0;
          bv = Date.parse(b.event.detectedAt) || 0;
          break;
        case 'duration':
          av = a.durationSeconds ?? -1;
          bv = b.durationSeconds ?? -1;
          break;
        case 'status':
          av = a.event.status ?? '';
          bv = b.event.status ?? '';
          break;
        default:
          av = a.event.id;
          bv = b.event.id;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [enriched, search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(1);
  }

  return (
    <div className="history review-table">
      <div className="history__controls">
        <input
          className="history__search"
          placeholder="Filter by event #, fault type, rule, or reviewer…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search fault events"
        />
        <span className="history__count">{filtered.length} events</span>
      </div>

      <div className="history__table-wrap">
        <table className="history__table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  aria-sort={c.sortable ? (sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      className="history__sort-btn"
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      {sortKey === c.key && <SortChevron dir={sortDir} />}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="history__empty">
                  No events match your search.
                </td>
              </tr>
            ) : (
              pageRows.map(({ event, rules, durationSeconds, isOngoing }) => (
                <tr key={event.id}>
                  <td>
                    <a href={`#/review/${event.id}`} style={{ fontFamily: 'var(--mono)' }}>
                      #{event.id}
                    </a>
                  </td>
                  <td>
                    {formatDayTime(event.detectedAt)}
                    {' '}
                    <span className="review-footnote" style={{ marginTop: 0 }}>
                      {formatRelativeTime(event.detectedAt)}
                    </span>
                  </td>
                  <td>
                    {formatDayTime(event.faultStart)} → {formatDayTime(event.lastSeenWindowEnd)}
                  </td>
                  <td
                    title="This event covers consecutive 60-second windows merged into one row."
                  >
                    {formatDuration(durationSeconds)}
                    {isOngoing && (
                      <span
                        className="pill pill--ongoing"
                        title="Still re-triggering — reviewing now closes it; later windows open a new event."
                      >
                        ONGOING
                      </span>
                    )}
                  </td>
                  <td className="review-table__tripped">
                    {rules.slice(0, 3).map((rule) => {
                      const [metric, ruleType] = rule.split('.');
                      return <RuleChip key={rule} metric={metric} ruleType={ruleType} />;
                    })}
                    {rules.length > 3 && (
                      <span className="rule-chip-more">+{rules.length - 3}</span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${statusPillClass(event.status)}`}>
                      {event.status}
                    </span>
                  </td>
                  <td>{event.reviewedBy || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="history__pagination">
        <button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}
          aria-label="Previous page">
          ← Prev
        </button>
        <span>
          {currentPage} / {totalPages}
        </span>
        <button disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}
          aria-label="Next page">
          Next →
        </button>
      </div>
    </div>
  );
}
