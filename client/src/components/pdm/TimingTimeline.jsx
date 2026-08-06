// ─────────────────────────────────────────────────────────────────────────
// TimingTimeline.jsx — bufferStart → faultStart → [fault band] → faultEnd →
// bufferEnd bar, plus the exact values as a definition list.
// ─────────────────────────────────────────────────────────────────────────

import { formatDateTime } from '../../utils/formatters.js';

function Row({ label, value }) {
  return (
    <div className="timing-dl__row">
      <dt>{label}</dt>
      <dd>{value ?? '--'}</dd>
    </div>
  );
}

export default function TimingTimeline({ event }) {
  const {
    detectedAt, triggerWindowEnd, lastSeenWindowEnd,
    faultStart, faultEnd, bufferStart, bufferEnd,
    thresholdsVersion, processedTelemetryId, bufferSampleCount,
  } = event;

  const start = Date.parse(bufferStart);
  const end = bufferEnd ? Date.parse(bufferEnd) : Date.parse(lastSeenWindowEnd);
  const fs = Date.parse(faultStart);
  const fe = faultEnd ? Date.parse(faultEnd) : Date.parse(lastSeenWindowEnd);
  const span = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null;
  const pct = (t) => (span ? Math.min(100, Math.max(0, ((t - start) / span) * 100)) : 0);

  return (
    <div className="timing-timeline">
      {span && (
        <div className="timing-timeline__bar">
          <div
            className="timing-timeline__band"
            style={{ left: `${pct(fs)}%`, width: `${Math.max(0.5, pct(fe) - pct(fs))}%` }}
          />
        </div>
      )}
      <dl className="timing-dl">
        <Row label="Detected at" value={formatDateTime(detectedAt)} />
        <Row label="Trigger window end" value={formatDateTime(triggerWindowEnd)} />
        <Row label="Last seen window end" value={formatDateTime(lastSeenWindowEnd)} />
        <Row label="Fault start" value={formatDateTime(faultStart)} />
        <Row label="Fault end" value={formatDateTime(faultEnd)} />
        <Row label="Buffer start" value={formatDateTime(bufferStart)} />
        <Row
          label="Buffer end"
          value={bufferEnd ? formatDateTime(bufferEnd) : 'decided when you confirm (faultEnd + 1 hour)'}
        />
        <Row label="Thresholds version" value={thresholdsVersion ?? '--'} />
        <Row label="Processed telemetry id" value={processedTelemetryId ?? '--'} />
        <Row label="Buffer sample count" value={bufferSampleCount ?? '--'} />
      </dl>
    </div>
  );
}
