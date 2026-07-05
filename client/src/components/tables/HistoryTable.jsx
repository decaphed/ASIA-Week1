// ─────────────────────────────────────────────────────────────────────────
// HistoryTable.jsx — searchable, sortable, paginated table of past readings.
//
// The backend hands us the latest 100 rows every 5 seconds; searching,
// sorting and paginating happen CLIENT-SIDE here. That gives instant
// interaction (no extra requests) and is plenty for 100 rows. useMemo caches
// the filtered+sorted result so we only recompute when inputs actually change.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import { formatDateTime, formatNumber } from '../../utils/formatters.js';

const COLUMNS = [
  { key: 'timestamp',         label: 'Timestamp' },
  { key: 'flowRate',          label: 'Flow (L/min)' },
  { key: 'rpm',               label: 'RPM' },
  { key: 'vibration',         label: 'Vib (mm/s)' },
  { key: 'suctionPressure',   label: 'Suction (bar)' },
  { key: 'dischargePressure', label: 'Discharge (bar)' },
  { key: 'motorTemp',         label: 'Motor Temp (°C)' },
  { key: 'status',            label: 'Status' },
];

const PAGE_SIZE = 10;

export default function HistoryTable({ rows }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('timestamp');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    const matched = q
      ? rows.filter((r) =>
          [
            r.timestamp,
            r.flowRate,
            r.rpm,
            r.vibration,
            r.suctionPressure,
            r.dischargePressure,
            r.motorTemp,
            r.status,
          ]
            .join(' ')
            .toLowerCase()
            .includes(q)
        )
      : rows;

    const sorted = [...matched].sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (sortKey === 'timestamp') {
        av = new Date(a.timestamp).getTime();
        bv = new Date(b.timestamp).getTime();
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [rows, search, sortKey, sortDir]);

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
    <div className="history">
      <div className="history__controls">
        <input
          className="history__search"
          placeholder="Search readings…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <span className="history__count">{filtered.length} rows</span>
      </div>

      <div className="history__table-wrap">
        <table className="history__table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} onClick={() => toggleSort(c.key)}>
                  {c.label}
                  {sortKey === c.key && (
                    <span className="history__arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="history__empty">
                  No readings match your search.
                </td>
              </tr>
            ) : (
              pageRows.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.timestamp)}</td>
                  <td>{formatNumber(r.flowRate)}</td>
                  <td>{formatNumber(r.rpm, 0)}</td>
                  <td>{formatNumber(r.vibration)}</td>
                  <td>{formatNumber(r.suctionPressure)}</td>
                  <td>{formatNumber(r.dischargePressure)}</td>
                  <td>{formatNumber(r.motorTemp)}</td>
                  <td>
                    <span className={`pill pill--${(r.status ?? 'unknown').toLowerCase()}`}>
                      {r.status ?? '--'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="history__pagination">
        <button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
          Prev
        </button>
        <span>
          Page {currentPage} / {totalPages}
        </span>
        <button disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
