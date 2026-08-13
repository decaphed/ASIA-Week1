import { useMemo, useState } from 'react';
import Card, { CardLabel, buttonReset } from '../components/Card.jsx';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { METRICS, METRIC_BY_KEY, pillFor, fmt, AUTO_LABEL_BADGE } from '../utils/constants.js';
import { eventId, eventTitle, faultTypeLabel, dotStamp, severityOf, metricsLabel } from '../utils/faultEvents.js';

const RANGES = [
  { id: '1h', label: 'Last hour' },
  { id: '8h', label: 'Last 8 hours' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
];

const METRIC_GROUPS = [
  { id: 'all', label: 'All channels', keys: METRICS.map((m) => m.key) },
  { id: 'vibration', label: 'Vibration only', keys: ['vibration'] },
  { id: 'pressures', label: 'Pressures', keys: ['suctionPressure', 'dischargePressure'] },
  { id: 'temps', label: 'Temperatures', keys: ['motorTemp'] },
];

const FORMATS = ['CSV', 'Excel', 'PDF'];

function download(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function buildRows(points, keys) {
  return {
    header: ['timestamp', ...keys],
    body: points.map((p) => [p.t, ...keys.map((k) => (p[k] == null ? '' : p[k]))]),
  };
}

// RFC 4180: quote any field containing a comma, quote or newline, and double
// embedded quotes. Today's columns are numeric/ISO-timestamp only, but an
// unquoted writer silently corrupts the file the moment a text column is added.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv({ header, body }) {
  return [header.map(csvCell).join(','), ...body.map((r) => r.map(csvCell).join(','))].join('\r\n');
}

// SpreadsheetML 2003 — a single XML file Excel opens natively, so a real
// spreadsheet export needs no zip/xlsx dependency in the bundle.
function toSpreadsheetXml({ header, body }, sheetName) {
  const cell = (v) => {
    const isNum = v !== '' && v != null && !Number.isNaN(Number(v));
    return isNum
      ? `<Cell><Data ss:Type="Number">${escapeXml(v)}</Data></Cell>`
      : `<Cell><Data ss:Type="String">${escapeXml(v ?? '')}</Data></Cell>`;
  };
  const rows = [
    `<Row>${header.map((h) => `<Cell><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join('')}</Row>`,
    ...body.map((r) => `<Row>${r.map(cell).join('')}</Row>`),
  ].join('');
  return `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="${escapeXml(sheetName)}"><Table>${rows}</Table></Worksheet>
</Workbook>`;
}

// PDF export goes through the browser's own print-to-PDF: a standalone print
// window keeps the export real and paginated without pulling a PDF renderer
// into the bundle.
function openPrintView({ header, body }, title) {
  // noopener: the print window has no need for a handle back to the
  // dashboard, so don't hand it window.opener.
  const win = window.open('', '_blank', 'width=900,height=700,noopener');
  if (!win) return false;
  const rows = body.map((r) => `<tr>${r.map((c) => `<td>${escapeXml(c ?? '')}</td>`).join('')}</tr>`).join('');
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(title)}</title>
    <style>
      body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:#1a2530;padding:24px}
      h1{font-size:17px;margin:0 0 4px}
      .sub{font-size:12px;color:#5f6f7e;margin-bottom:16px}
      table{border-collapse:collapse;width:100%;font-size:11px}
      th{text-align:left;text-transform:uppercase;letter-spacing:.05em;font-size:9px;color:#5f6f7e;border-bottom:1px solid #999;padding:6px 4px}
      td{padding:4px;border-bottom:1px solid #eee;font-variant-numeric:tabular-nums}
    </style></head><body>
    <h1>${escapeXml(title)}</h1>
    <div class="sub">P-101 · Cooling Water Pump · generated ${escapeXml(new Date().toLocaleString())}</div>
    <table><thead><tr>${header.map((h) => `<th>${escapeXml(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    </body></html>`);
  win.document.close();
  win.focus();
  win.print();
  return true;
}

function ExportCard({ showToast }) {
  const [rangeId, setRangeId] = useState('24h');
  const [groupId, setGroupId] = useState('all');
  const [format, setFormat] = useState('CSV');
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await api.series(rangeId);
      const points = data?.points ?? [];
      if (!points.length) {
        showToast('No readings in the selected range', '#e0b880');
        return;
      }
      const group = METRIC_GROUPS.find((g) => g.id === groupId);
      const rangeLabel = RANGES.find((r) => r.id === rangeId).label;
      const rows = buildRows(points, group.keys);
      const stem = `pump-telemetry-${rangeId}-${groupId}`;
      const title = `Pump telemetry · ${rangeLabel} · ${group.label}`;

      if (format === 'CSV') {
        download(`${stem}.csv`, 'text/csv;charset=utf-8', toCsv(rows));
      } else if (format === 'Excel') {
        download(`${stem}.xls`, 'application/vnd.ms-excel', toSpreadsheetXml(rows, 'Telemetry'));
      } else if (!openPrintView(rows, title)) {
        showToast('Allow pop-ups for this site to produce a PDF', '#e0b880');
        return;
      }
      showToast(`Export ready: ${format}, ${rangeLabel.toLowerCase()}, ${points.length} rows`);
    } catch (err) {
      showToast(`Export failed: ${err.message}`, '#e08a80');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '20px 22px' }}>
      <CardLabel>Historical data export</CardLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}>
          Range
          <select value={rangeId} onChange={(e) => setRangeId(e.target.value)} style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, background: '#ffffff', color: '#1a2530' }}>
            {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}>
          Metrics
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, background: '#ffffff', color: '#1a2530' }}>
            {METRIC_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <div role="group" aria-label="Export format" style={{ display: 'flex', border: '1px solid #d3dbe2', borderRadius: 6, overflow: 'hidden' }}>
          {FORMATS.map((f, i) => (
            <button
              key={f}
              type="button"
              className="hover-seg"
              onClick={() => setFormat(f)}
              aria-pressed={format === f}
              style={{
                ...buttonReset,
                padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
                borderLeft: i === 0 ? 'none' : '1px solid #d3dbe2',
                background: format === f ? '#33475a' : 'transparent',
                color: format === f ? '#ffffff' : '#5f6f7e',
              }}
            >
              {f}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="hover-primary"
          onClick={generate}
          disabled={busy}
          style={{ background: '#1F3A6E', color: '#ffffff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', boxShadow: '0 1px 2px rgba(22,41,79,0.3)', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Preparing…' : 'Generate export'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: '#8a99a8', marginTop: 12 }}>
        Rows come from the downsampled history series. CSV and Excel download directly; PDF opens a print view.
      </div>
    </Card>
  );
}

function ManualReadingCard({ latest, showToast, onRecorded }) {
  const [metricKey, setMetricKey] = useState('vibration');
  const [value, setValue] = useState('');
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [busy, setBusy] = useState(false);

  const metric = METRIC_BY_KEY[metricKey];

  async function submit() {
    const numeric = Number(value);
    if (value === '' || Number.isNaN(numeric)) {
      showToast('Enter a numeric value for the reading', '#e0b880');
      return;
    }
    if (!latest) {
      showToast('No live reading yet to base a manual entry on', '#e0b880');
      return;
    }
    setBusy(true);
    try {
      // POST /api/data validates all six numeric channels, so the untouched
      // ones carry over from the newest live reading and only the selected
      // channel takes the hand-recorded value.
      const body = {
        flowRate: latest.flowRate,
        rpm: latest.rpm,
        vibration: latest.vibration,
        suctionPressure: latest.suctionPressure,
        dischargePressure: latest.dischargePressure,
        motorTemp: latest.motorTemp,
        status: latest.status || 'RUNNING',
        timestamp: new Date(observedAt).toISOString(),
        [metricKey]: numeric,
      };
      await api.postReading(body);
      showToast(`Manual reading recorded: ${metric.label} = ${numeric} ${metric.unit}`);
      onRecorded({ metricKey, value: numeric, at: body.timestamp });
      setValue('');
    } catch (err) {
      const detail = Array.isArray(err.details) ? ` (${err.details.join('; ')})` : '';
      showToast(`Could not record reading: ${err.message}${detail}`, '#e08a80');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '20px 22px' }}>
      <CardLabel>Manual test reading</CardLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr', gap: 12, marginTop: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}>
          Channel
          <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)} style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, background: '#ffffff', color: '#1a2530' }}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label} ({m.unit})</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}>
          Value
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" inputMode="decimal" style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#1a2530' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}>
          Observed at
          <input type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '7px 10px', fontSize: 12.5, color: '#1a2530' }} />
        </label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button
          type="button"
          className="hover-dark"
          onClick={submit}
          disabled={busy}
          style={{ background: '#33475a', color: '#ffffff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Recording…' : 'Add reading'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: '#8a99a8', marginTop: 12 }}>
        The five channels you do not edit carry over from the newest live reading, since the ingestion endpoint stores a complete sample.
      </div>
    </Card>
  );
}

function AuditTrail({ audit }) {
  const rows = [...audit].sort(
    (a, b) => (Date.parse(b.reviewedAt || b.detectedAt) || 0) - (Date.parse(a.reviewedAt || a.detectedAt) || 0)
  );
  return (
    <Card style={{ padding: '20px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Fault review audit trail</h2>
          <div style={{ fontSize: 12.5, color: '#8a99a8', marginTop: 3 }}>A record of who reviewed each detection, when, and the outcome.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '3px 10px', background: '#E4F3EB', color: '#177E4D', border: '1px solid #bfe0cd' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#177E4D' }} />Confirmed
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '3px 10px', background: '#eef1f4', color: '#5f6f7e', border: '1px solid #dde4ea' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8a99a8' }} />Rejected
          </span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 175px 1.2fr 1.4fr 1.4fr 130px 120px', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#8a99a8', padding: '10px 2px', borderBottom: '1px solid #eef2f5', marginTop: 8 }}>
        <span>Event</span><span>Outcome</span><span>Fault type</span><span>Root cause</span><span>Resolution</span><span>Reviewed by</span><span>Reviewed at</span>
      </div>
      {rows.length === 0 && <div style={{ padding: '36px 0', textAlign: 'center', color: '#8a99a8', fontSize: 13 }}>No reviews recorded yet.</div>}
      {rows.map((a) => {
        const pill = pillFor(a.status);
        return (
          <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '90px 175px 1.2fr 1.4fr 1.4fr 130px 120px', fontSize: 13, padding: '12px 2px', borderBottom: '1px solid #f4f7f9', alignItems: 'center' }}>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: '#33475a' }}>{eventId(a)}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 600, borderRadius: 99, padding: '3px 9px', background: pill.bg, color: pill.color, border: `1px solid ${pill.border}` }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: pill.color }} />{pill.label}
              </span>
              {a.autoLabeled && (
                <span
                  title={`Auto-labeled from fault event #${a.autoLabeledFromEventId}`}
                  style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 99, padding: '3px 9px', background: AUTO_LABEL_BADGE.bg, color: AUTO_LABEL_BADGE.color, border: `1px solid ${AUTO_LABEL_BADGE.border}` }}
                >
                  {AUTO_LABEL_BADGE.label}
                </span>
              )}
            </span>
            <span style={{ fontWeight: 500 }}>{faultTypeLabel(a)}</span>
            <span style={{ color: '#5f6f7e', fontSize: 12.5, paddingRight: 10 }}>{a.rootCause || '—'}</span>
            <span style={{ color: '#5f6f7e', fontSize: 12.5, paddingRight: 10 }}>{a.resolution || '—'}</span>
            <span style={{ fontWeight: 500, fontSize: 12.5 }} title={a.autoLabeled ? `Source: fault event #${a.autoLabeledFromEventId}` : undefined}>
              {a.autoLabeled ? 'Auto-labeled' : (a.reviewedBy || '—')}
            </span>
            <span style={{ color: '#5f6f7e', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{dotStamp(a.reviewedAt)}</span>
          </div>
        );
      })}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// System event log — the design shows one unified feed. The backend has no
// dedicated event-log endpoint, so the feed is composed from what the
// services do publish: fault-event detections and reviews, drift-service
// structural breaks, and manual entries recorded during this session.
// ─────────────────────────────────────────────────────────────────────────
function useEventLog(queue, audit, drift, manualEntries) {
  return useMemo(() => {
    const events = [];

    for (const e of [...queue, ...audit]) {
      const critical = severityOf(e) === 'CRITICAL';
      events.push({
        id: `det-${e.id}`,
        at: e.detectedAt,
        type: critical ? 'ALARM' : 'DETECT',
        bg: critical ? '#FBEAE8' : '#E9EEF6',
        color: critical ? '#B3282D' : '#1F3A6E',
        msg: `${eventTitle(e)} on ${metricsLabel(e)}, ${eventId(e)} raised for review`,
      });
      if (e.reviewedAt) {
        events.push({
          id: `rev-${e.id}`,
          at: e.reviewedAt,
          type: 'REVIEW',
          bg: e.status === 'CONFIRMED' ? '#E4F3EB' : '#eef1f4',
          color: e.status === 'CONFIRMED' ? '#177E4D' : '#5f6f7e',
          msg: `${eventId(e)} ${String(e.status).toLowerCase()}${e.faultType ? ` as ${faultTypeLabel(e)}` : ''} by ${e.reviewedBy || 'an engineer'}`,
        });
      }
    }

    for (const [key, entry] of Object.entries(drift || {})) {
      if (!entry || entry.direction === 'stable' || !METRIC_BY_KEY[key]) continue;
      events.push({
        id: `drift-${key}`,
        at: null,
        type: 'WARN',
        bg: '#FBF3E0',
        color: '#8a5f00',
        msg: `${METRIC_BY_KEY[key].label} shifted to a new operating level (${entry.direction}, z = ${fmt(entry.z, 2)}); reference ${fmt(entry.referenceMean, 2)} → recent ${fmt(entry.recentMean, 2)}`,
      });
    }

    for (const m of manualEntries) {
      const metric = METRIC_BY_KEY[m.metricKey];
      events.push({
        id: `man-${m.at}-${m.metricKey}`,
        at: m.at,
        type: 'MANUAL',
        bg: '#eef1f4',
        color: '#5f6f7e',
        msg: `Hand-recorded ${metric.label} of ${m.value} ${metric.unit} submitted to ingestion`,
      });
    }

    return events.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, 20);
  }, [queue, audit, drift, manualEntries]);
}

export default function ReportsPage({ live, queue, audit, showToast }) {
  const [manualEntries, setManualEntries] = useState([]);
  const { data: driftRes } = usePolling(() => api.drift(), 60000, []);
  const { data: statsRes } = usePolling(() => api.stats(), 30000, []);

  const events = useEventLog(queue, audit, driftRes?.data, manualEntries);
  const stats = statsRes?.data;

  return (
    <div style={{ padding: '26px 32px 44px', display: 'flex', flexDirection: 'column', gap: 20, animation: 'fadeUp .3s ease' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
        <ExportCard showToast={showToast} />
        <ManualReadingCard
          latest={live.latest}
          showToast={showToast}
          onRecorded={(entry) => setManualEntries((prev) => [entry, ...prev].slice(0, 10))}
        />
      </div>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 20 }}>
          {[
            { k: 'Stored readings', v: fmt(stats.totalRecords, 0), sub: 'rows in raw telemetry' },
            { k: 'Newest reading', v: stats.latestTimestamp ? new Date(stats.latestTimestamp).toTimeString().slice(0, 8) : '—', sub: 'ingestion timestamp' },
            { k: 'Mean vibration', v: `${fmt(stats.averageVibration, 2)} mm/s`, sub: 'across all stored rows' },
            { k: 'API latency', v: stats.apiLatencyMs == null ? '—' : `${fmt(stats.apiLatencyMs, 0)} ms`, sub: 'last request round trip' },
          ].map((s) => (
            <Card key={s.k} style={{ padding: '16px 18px' }}>
              <CardLabel>{s.k}</CardLabel>
              <div style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 8 }}>{s.v}</div>
              <div style={{ fontSize: 11.5, color: '#8a99a8', marginTop: 4 }}>{s.sub}</div>
            </Card>
          ))}
        </div>
      )}

      <AuditTrail audit={audit} />

      <Card style={{ padding: '20px 22px' }}>
        <CardLabel style={{ marginBottom: 6 }}>System event log</CardLabel>
        {events.length === 0 && <div style={{ padding: '28px 0', textAlign: 'center', color: '#8a99a8', fontSize: 13 }}>Nothing logged yet.</div>}
        {events.map((e) => (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 13, padding: '10px 2px', borderBottom: '1px solid #f4f7f9' }}>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: '#8a99a8', width: 130, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {e.at ? dotStamp(e.at) : 'continuous'}
            </span>
            <span style={{ width: 70, flexShrink: 0 }}>
              <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', borderRadius: 4, padding: '2px 7px', background: e.bg, color: e.color }}>{e.type}</span>
            </span>
            <span style={{ color: '#33475a' }}>{e.msg}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
