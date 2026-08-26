import Card, { CardLabel } from './Card.jsx';
import { METRICS, SC, fmt } from '../utils/constants.js';

// ─────────────────────────────────────────────────────────────────────────
// ProcessSchematic — engine sensor status panel.
//
// This replaces a pump-domain P&ID diagram (supply tank, impeller, valves,
// pipe routing) that had no engine analogue — see docs/plan/2026-08-26-
// pump-to-engine-migration.md §12 Q8. A specific engine physical layout
// (oil pump position, coolant loop routing, fuel rail geometry) is not
// something this migration has any verified basis for, so rather than
// invent one, this renders a plain, honest per-sensor status grid using
// the same status-color/glyph vocabulary the old schematic's Tag component
// used. If a real engine layout diagram becomes available later, this is
// the natural place to reintroduce one.
//
// Status is never conveyed by color alone: warn/alarm/no-data tiles also
// carry a glyph, and every tile exposes its status as text to assistive tech.
// ─────────────────────────────────────────────────────────────────────────

const STATUS_GLYPH = { warn: '!', crit: '!', unknown: '?' };

function SensorTile({ metric, value, status, running }) {
  const sc = SC[status] || SC.unknown;
  const glyph = STATUS_GLYPH[status];
  return (
    <div
      role="img"
      aria-label={`${metric.label} ${metric.short}: ${value}, ${sc.label}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: '14px 10px',
        borderRadius: 10,
        background: sc.bg,
        border: `1.6px solid ${sc.bd}`,
        position: 'relative',
        minWidth: 110,
      }}
    >
      {glyph && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', top: 8, right: 8,
            width: 16, height: 16, borderRadius: '50%',
            background: sc.c, color: '#ffffff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 9.5, fontWeight: 700,
          }}
        >
          {glyph}
        </span>
      )}
      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, fontWeight: 600, color: sc.c, letterSpacing: '0.03em' }}>
        {metric.short}
      </span>
      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 600, color: sc.c }}>
        {value}
      </span>
      <span style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10.5, color: '#5f6f7e', textAlign: 'center' }}>
        {metric.label}{metric.key === 'engineRpm' && running ? ' · running' : ''}
      </span>
    </div>
  );
}

export default function ProcessSchematic({ reading, statuses, stale }) {
  const st = (key) => statuses[key] || 'unknown';
  const running = !stale && reading?.status === 'RUNNING';

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <CardLabel>Sensor Status</CardLabel>
        <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: '#5f6f7e' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#177E4D' }} />Normal</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#B27400' }} />Warning <b style={{ fontWeight: 700 }}>!</b></span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#B3282D' }} />Alarm <b style={{ fontWeight: 700 }}>!</b></span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#5f6f7e' }} />No data <b style={{ fontWeight: 700 }}>?</b></span>
        </div>
      </div>
      <div
        style={{
          marginTop: 12,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
          gap: 10,
          opacity: stale ? 0.72 : 1,
        }}
      >
        {METRICS.map((metric) => (
          <SensorTile
            key={metric.key}
            metric={metric}
            status={st(metric.key)}
            running={running}
            value={`${fmt(reading?.[metric.key], metric.dec)} ${metric.unit}`}
          />
        ))}
      </div>
    </Card>
  );
}
