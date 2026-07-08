// ─────────────────────────────────────────────────────────────────────────
// PeriodSummary.jsx — the top card of the Reports page: availability, run
// time and excursions for a chosen window (24h / 7d), a per-sensor
// min/avg/max table, and a client-side CSV export.
//
// Every figure here names its window explicitly (in the card subtitle and
// the toggle) so a manager never quotes a number without knowing the period
// it covers. availabilityPct / runHours can be null early on — shown as '--'.
// ─────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import Card from '../ui/Card.jsx';
import { useSummary } from '../../hooks/useSensorData.js';
import { SENSORS, PUMP_ID } from '../../utils/constants.js';
import { formatNumber, formatDateTime } from '../../utils/formatters.js';

const RANGES = [
  { id: '24h', label: '24h' },
  { id: '7d',  label: '7d' },
];
const RANGE_WORDS = { '24h': 'last 24 hours', '7d': 'last 7 days' };

// Escape a single CSV field: wrap in quotes when it contains a comma, quote
// or newline, and double any embedded quotes.
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(summary, range) {
  const rows = [
    ['Pump', PUMP_ID],
    ['Period', range],
    ['From', summary.from ?? ''],
    ['To', summary.to ?? ''],
    ['Availability %', summary.availabilityPct ?? ''],
    ['Run Hours', summary.runHours ?? ''],
    ['Caution excursions', summary.excursions?.warn ?? ''],
    ['Critical excursions', summary.excursions?.alarm ?? ''],
    ['Samples', summary.sampleCount ?? ''],
    [],
    ['Sensor', 'Unit', 'Min', 'Avg', 'Max'],
  ];
  for (const s of SENSORS) {
    const p = summary.perSensor?.[s.key];
    rows.push([s.label, s.unit, p?.min ?? '', p?.avg ?? '', p?.max ?? '']);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function downloadCsv(summary, range) {
  const csv = buildCsv(summary, range);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pump01-summary-${range}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function Stat({ label, value, unit, accent }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={`stat__value${accent ? ` stat__value--${accent}` : ''}`}>
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

export default function PeriodSummary() {
  const [range, setRange] = useState('24h');
  const { data: summary } = useSummary(range);
  const s = summary;

  const actions = (
    <div className="period-summary__actions">
      {/* Toggle-button group, not role="tablist" — we don't implement the
          arrow-key/panel wiring the ARIA tabs pattern promises. */}
      <div className="range-tabs" role="group" aria-label="Summary period">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button" aria-pressed={range === r.id}
            className={`range-tabs__tab${range === r.id ? ' is-active' : ''}`}
            onClick={() => setRange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn-download"
        onClick={() => s && downloadCsv(s, range)}
        disabled={!s}
      >
        Download CSV
      </button>
    </div>
  );

  const excWarn = s?.excursions?.warn;
  const excAlarm = s?.excursions?.alarm;

  return (
    <Card
      id="period-summary"
      title="Period Summary"
      subtitle={`Availability, run time and excursions · ${RANGE_WORDS[range]}`}
      actions={actions}
    >
      <div className="stats-panel period-summary__stats">
        <Stat
          label="Availability"
          value={s && s.availabilityPct != null ? formatNumber(s.availabilityPct, 1) : '--'}
          unit="%"
          accent={s && s.availabilityPct != null && s.availabilityPct >= 95 ? 'ok' : s && s.availabilityPct != null && s.availabilityPct < 80 ? 'warn' : null}
        />
        <Stat
          label="Run Hours"
          value={s && s.runHours != null ? formatNumber(s.runHours, 1) : '--'}
          unit="h"
        />
        <Stat
          label="Caution Excursions"
          value={s && excWarn != null ? excWarn : '--'}
          accent={excWarn > 0 ? 'warn' : null}
        />
        <Stat
          label="Critical Excursions"
          value={s && excAlarm != null ? excAlarm : '--'}
          accent={excAlarm > 0 ? 'warn' : null}
        />
        <Stat
          label="Samples"
          value={s && s.sampleCount != null ? s.sampleCount : '--'}
        />
      </div>

      <div className="period-table-wrap">
        <table className="period-table">
          <thead>
            <tr>
              <th>Sensor</th>
              <th className="period-table__num">Min</th>
              <th className="period-table__num">Avg</th>
              <th className="period-table__num">Max</th>
            </tr>
          </thead>
          <tbody>
            {SENSORS.map((sensor) => {
              const p = s?.perSensor?.[sensor.key];
              return (
                <tr key={sensor.key}>
                  <td>
                    <span className="period-table__label">{sensor.label}</span>
                    <span className="period-table__unit">{sensor.unit}</span>
                  </td>
                  <td className="period-table__num">{p ? formatNumber(p.min, sensor.prec) : '--'}</td>
                  <td className="period-table__num">{p ? formatNumber(p.avg, sensor.prec) : '--'}</td>
                  <td className="period-table__num">{p ? formatNumber(p.max, sensor.prec) : '--'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="period-summary__footnote">
        {s
          ? `Window: ${formatDateTime(s.from)} → ${formatDateTime(s.to)}`
          : 'Loading period data…'}
      </p>
    </Card>
  );
}
