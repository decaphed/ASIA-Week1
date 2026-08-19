import Card, { CardLabel } from './Card.jsx';
import { SC, fmt } from '../utils/constants.js';

// ─────────────────────────────────────────────────────────────────────────
// ProcessSchematic — P&ID-style view of the cooling water circuit with live
// instrument bubbles. Tag colors follow each metric's current warn/alarm
// status; the impeller and flow dashes animate while the pump is RUNNING.
//
// Status is never conveyed by color alone: warn/alarm/no-data tags also
// carry a glyph, and every tag exposes its status as text to assistive tech.
// ─────────────────────────────────────────────────────────────────────────

const STATUS_GLYPH = { warn: '!', crit: '!', unknown: '?' };

function Tag({ x, y, prefix, num, status, label, labelX, labelY, labelAnchor, value, pulse }) {
  const sc = SC[status] || SC.unknown;
  const glyph = STATUS_GLYPH[status];
  return (
    <g role="img" aria-label={`${label} ${prefix}-${num}: ${value}, ${sc.label}`}>
      {pulse && (
        <circle cx={x} cy={y} r="23" fill="none" stroke="#B3282D" strokeWidth="1" opacity="0.5" style={{ animation: 'pulse 1.6s infinite' }} />
      )}
      <circle cx={x} cy={y} r="17" fill={sc.bg} stroke={sc.c} strokeWidth={pulse ? 1.8 : 1.6} />
      <text x={x} y={y - 2} textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 8.5, fontWeight: 600, fill: sc.c }}>{prefix}</text>
      <text x={x} y={y + 8} textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 8, fill: sc.c }}>{num}</text>
      {glyph && (
        // Non-color status cue, so warn/alarm/no-data stay distinguishable
        // without relying on hue.
        <>
          <circle cx={x + 13} cy={y - 13} r="7" fill={sc.c} stroke="#ffffff" strokeWidth="1.4" />
          <text x={x + 13} y={y - 9.6} textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 9.5, fontWeight: 700, fill: '#ffffff' }}>{glyph}</text>
        </>
      )}
      <text x={labelX} y={labelY} textAnchor={labelAnchor || 'middle'} style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, fontWeight: 600, fill: sc.c }}>{value}</text>
    </g>
  );
}

export default function ProcessSchematic({ reading, statuses, stale }) {
  const st = (key) => statuses[key] || 'unknown';
  const running = !stale && reading?.status === 'RUNNING';

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <CardLabel>Process Schematic · Cooling Water Circuit</CardLabel>
        <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: '#5f6f7e' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#177E4D' }} />Normal</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#B27400' }} />Warning <b style={{ fontWeight: 700 }}>!</b></span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#B3282D' }} />Alarm <b style={{ fontWeight: 700 }}>!</b></span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: '#5f6f7e' }} />No data <b style={{ fontWeight: 700 }}>?</b></span>
        </div>
      </div>
      <svg width="100%" viewBox="0 0 1040 236" style={{ marginTop: 8, display: 'block', opacity: stale ? 0.72 : 1 }}>
        <defs>
          <linearGradient id="tankw" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e9f1f7" />
            <stop offset="100%" stopColor="#cfdfec" />
          </linearGradient>
        </defs>

        {/* Supply tank T-01 */}
        <rect x="30" y="82" width="112" height="92" rx="8" fill="#fbfcfd" stroke="#8a99a8" strokeWidth="1.6" />
        <rect x="34" y="118" width="104" height="52" rx="5" fill="url(#tankw)" />
        <path d="M34 118 Q46 113 58 118 T82 118 T106 118 T130 118 T138 118" stroke="#a9c3d8" strokeWidth="1.5" fill="none" />
        <text x="86" y="104" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 11.5, fontWeight: 600, fill: '#33475a' }}>T-01</text>
        <text x="86" y="190" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10, fill: '#8a99a8' }}>Supply Tank</text>

        {/* Pipework + animated flow */}
        <path d="M142 138 L468 138" stroke="#aebdc9" strokeWidth="6" strokeLinecap="round" />
        <path d="M532 138 L956 138" stroke="#aebdc9" strokeWidth="6" strokeLinecap="round" />
        {running && (
          <>
            <path d="M142 138 L468 138" stroke="#4A6B8A" strokeWidth="2.2" strokeDasharray="7 13" fill="none" style={{ animation: 'flow 1.1s linear infinite' }} />
            <path d="M532 138 L956 138" stroke="#4A6B8A" strokeWidth="2.2" strokeDasharray="7 13" fill="none" style={{ animation: 'flow 1.1s linear infinite' }} />
          </>
        )}

        {/* Manual valve MV-101 */}
        <path d="M288 128 L288 148 L300 138 Z M312 128 L312 148 L300 138 Z" fill="#ffffff" stroke="#5f6f7e" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M300 138 L300 118 M292 118 L308 118" stroke="#5f6f7e" strokeWidth="1.6" />
        <text x="300" y="168" textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, fill: '#5f6f7e' }}>MV-101</text>

        {/* Pump P-101 with rotating impeller */}
        <circle cx="500" cy="138" r="32" fill="#EFF3FA" stroke="#1F3A6E" strokeWidth="2.2" />
        <g style={running ? { transformOrigin: '500px 138px', animation: 'spin 1.6s linear infinite' } : undefined}>
          <path d="M500 138 L500 113 M500 138 L521.6 150.5 M500 138 L478.4 150.5" stroke="#1F3A6E" strokeWidth="2.4" strokeLinecap="round" />
        </g>
        <circle cx="500" cy="138" r="4.5" fill="#1F3A6E" />
        <text x="500" y="192" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 11.5, fontWeight: 600, fill: '#33475a' }}>P-101</text>
        <text x="500" y="207" textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, fill: '#8a99a8' }}>
          {fmt(reading?.rpm, 0)} rpm
        </text>

        {/* Motor */}
        <rect x="546" y="70" width="48" height="36" rx="6" fill="#f6f8fa" stroke="#5f6f7e" strokeWidth="1.6" />
        <text x="570" y="93" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 13, fontWeight: 600, fill: '#33475a' }}>M</text>
        <path d="M532 138 L570 138 L570 106" stroke="#5f6f7e" strokeWidth="1.6" fill="none" />

        {/* Check valve CV-102 + outlet */}
        <path d="M700 126 L722 138 L700 150 Z" fill="#ffffff" stroke="#5f6f7e" strokeWidth="1.6" />
        <path d="M722 126 L722 150" stroke="#5f6f7e" strokeWidth="1.6" />
        <text x="711" y="168" textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, fill: '#5f6f7e' }}>CV-102</text>
        <path d="M956 130 L972 138 L956 146 Z" fill="#9fb0bf" />
        <text x="964" y="118" textAnchor="end" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 10.5, fill: '#8a99a8' }}>To process header</text>

        {/* Instrument leads */}
        <path d="M220 132 L220 82" stroke="#c9d2dc" strokeWidth="1.2" strokeDasharray="3 3" />
        <path d="M478 116 L448 76" stroke="#c9d2dc" strokeWidth="1.2" strokeDasharray="3 3" />
        <path d="M570 70 L570 47" stroke="#c9d2dc" strokeWidth="1.2" strokeDasharray="3 3" />
        <path d="M640 132 L640 82" stroke="#c9d2dc" strokeWidth="1.2" strokeDasharray="3 3" />
        <path d="M820 132 L820 82" stroke="#c9d2dc" strokeWidth="1.2" strokeDasharray="3 3" />

        <Tag x={220} y={64} prefix="PT" num="101" status={st('suctionPressure')} label="Suction pressure"
          labelX={220} labelY={36} value={`${fmt(reading?.suctionPressure, 2)} bar`} />
        <Tag x={434} y={58} prefix="VT" num="101" status={st('vibration')} label="Vibration"
          labelX={434} labelY={28} value={`${fmt(reading?.vibration, 2)} mm/s`} pulse={statuses.vibration === 'crit'} />
        {/* Motor temperature reads to the LEFT of its bubble: right of it
            would collide with PT-102's value at the same height. */}
        <Tag x={570} y={29} prefix="TT" num="101" status={st('motorTemp')} label="Motor temperature"
          labelX={546} labelY={33} labelAnchor="end" value={`${fmt(reading?.motorTemp, 1)} °C`} />
        <Tag x={640} y={64} prefix="PT" num="102" status={st('dischargePressure')} label="Discharge pressure"
          labelX={640} labelY={36} value={`${fmt(reading?.dischargePressure, 2)} bar`} />
        <Tag x={820} y={64} prefix="FT" num="101" status={st('flowRate')} label="Flow rate"
          labelX={820} labelY={36} value={`${fmt(reading?.flowRate, 0)} m³/h`} />
      </svg>
    </Card>
  );
}
