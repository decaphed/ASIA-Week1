// ─────────────────────────────────────────────────────────────────────────
// ProcessSchematic.jsx — interactive animated P&ID hero.
// Sump tank → suction pipe → centrifugal pump (spinning impeller) + motor →
// discharge pipe → check valve → outlet, with 6 live value tags.
// v5: every piece of equipment is a hover hotspot — pointing at the pump,
//     motor, valve, tank or either pipe run pops a data card with that
//     component's live metrics, status and a sparkline (design ref: the
//     "highlight the valve, see its data" inspection view).
// ─────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { SENSORS, getAlarmState } from '../../utils/constants.js';
import { formatNumber } from '../../utils/formatters.js';

const SENSOR_MAP = Object.fromEntries(SENSORS.map((s) => [s.key, s]));
const VIBRATION = SENSOR_MAP.vibration;

// ── Equipment hotspots ─────────────────────────────────────────────────────
// `zone`   → invisible SVG hover region (viewBox 720×300 coordinates)
// `metrics`→ sensor keys shown in the popover; first one drives the sparkline
// `pop`    → popover anchor as % of the stage box { left | right, top | bottom }
const HOTSPOTS = [
  {
    id: 'tank', name: 'Sump Tank', tag: 'TK-01',
    desc: 'Supply reservoir feeding the pump suction line',
    metrics: ['suctionPressure'],
    zone: { x: 10, y: 100, w: 90, h: 118 },
    pop: { left: '14%', top: '8%' },
  },
  {
    id: 'suction', name: 'Suction Line', tag: 'PL-S01',
    desc: 'Inlet piping, sump tank to pump flange',
    metrics: ['suctionPressure', 'flowRate'],
    zone: { x: 100, y: 132, w: 150, h: 36 },
    pop: { left: '24%', top: '58%' },
  },
  {
    id: 'pump', name: 'Centrifugal Pump', tag: 'P-01',
    desc: 'Single-stage centrifugal pump, closed impeller',
    metrics: ['flowRate', 'rpm', 'vibration'],
    zone: { x: 254, y: 92, w: 116, h: 116, round: true },
    pop: { left: '52%', top: '18%' },
  },
  {
    id: 'motor', name: 'Drive Motor', tag: 'M-01',
    desc: 'Direct-coupled induction motor',
    metrics: ['motorTemp', 'rpm'],
    zone: { x: 274, y: 54, w: 76, h: 50 },
    pop: { left: '50%', top: '2%' },
  },
  {
    id: 'discharge', name: 'Discharge Line', tag: 'PL-D01',
    desc: 'Outlet piping, pump flange to header',
    metrics: ['dischargePressure', 'flowRate'],
    zone: { x: 372, y: 130, w: 132, h: 38 },
    pop: { left: '55%', top: '62%' },
  },
  {
    id: 'valve', name: 'Check Valve', tag: 'CV-01',
    desc: 'Non-return valve on the discharge header',
    metrics: ['dischargePressure', 'flowRate'],
    zone: { x: 568, y: 52, w: 60, h: 60, round: true },
    pop: { right: '3%', top: '38%' },
  },
];

// Worst alarm state across a hotspot's metrics: alarm > warn > normal > nodata
function worstState(reading, keys) {
  const rank = { alarm: 3, warn: 2, normal: 1, nodata: 0 };
  return keys.reduce((worst, k) => {
    const s = getAlarmState(SENSOR_MAP[k], reading?.[k]);
    return rank[s] > rank[worst] ? s : worst;
  }, 'nodata');
}

// Locally-scaled sparkline polyline for the popover (same approach as
// SensorCard, wider canvas).
function sparkPoints(points) {
  const buf = (points || []).slice(-24).map((p) => p.v).filter((v) => v != null);
  if (buf.length < 2) return '';
  const mn = Math.min(...buf);
  const mx = Math.max(...buf);
  const pad = (mx - mn) * 0.2 || 1;
  const yMin = mn - pad;
  const range = (mx + pad) - yMin || 1;
  const w = 180, h = 34;
  return buf
    .map((v, i) => {
      const x = (i / (buf.length - 1)) * w;
      const y = h - ((v - yMin) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

const STATE_LABEL = { alarm: 'ALARM', warn: 'WARNING', normal: 'NORMAL', nodata: 'NO DATA' };

function HotspotPopover({ spot, reading, series }) {
  const state = worstState(reading, spot.metrics);
  const primary = SENSOR_MAP[spot.metrics[0]];
  const spark = sparkPoints(series?.[primary.key]);

  const style = {};
  for (const side of ['left', 'right', 'top', 'bottom']) {
    if (spot.pop[side] != null) style[side] = spot.pop[side];
  }

  return (
    <div className={`schematic__pop schematic__pop--${state}`} style={style} role="status">
      <div className="schematic__pop-head">
        <div>
          <div className="schematic__pop-name">{spot.name}</div>
          <div className="schematic__pop-tagid">{spot.tag} · {spot.desc}</div>
        </div>
        <span className={`schematic__pop-state schematic__pop-state--${state}`}>
          {STATE_LABEL[state]}
        </span>
      </div>

      <div className="schematic__pop-metrics">
        {spot.metrics.map((k) => {
          const s = SENSOR_MAP[k];
          const st = getAlarmState(s, reading?.[k]);
          return (
            <div key={k} className="schematic__pop-metric">
              <span className="schematic__pop-metric-label">{s.label}</span>
              <span className={`schematic__pop-metric-value schematic__pop-metric-value--${st}`}>
                {formatNumber(reading?.[k], s.prec)}
                <small> {s.unit}</small>
              </span>
            </div>
          );
        })}
      </div>

      {spark && (
        <div className="schematic__pop-spark-wrap">
          <svg viewBox="0 0 180 34" preserveAspectRatio="none" className="schematic__pop-spark" aria-hidden="true">
            <polyline points={spark} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <span className="schematic__pop-spark-label">{primary.label} · last 24 samples</span>
        </div>
      )}
    </div>
  );
}

export default function ProcessSchematic({ reading, series }) {
  const r = reading || {};
  const [active, setActive] = useState(null);
  const vibState = getAlarmState(VIBRATION, r.vibration);
  const vibAlarm = vibState === 'alarm' || vibState === 'warn';
  const activeSpot = HOTSPOTS.find((h) => h.id === active) || null;

  return (
    <div className="schematic">
      <div className="schematic__header">
        <span className="schematic__title">Process Schematic — P&amp;ID</span>
        <span className="schematic__hint">Hover equipment for details</span>
        <span className="schematic__live">
          <span className="schematic__live-dot" />Live · 1s poll
        </span>
      </div>

      <div className="schematic__body">
       <div className="schematic__stage">
        <svg viewBox="0 0 720 300" className="schematic__svg">
          <defs>
            <marker id="schematic-arrow-d" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
              <path d="M0 0l7 4.5-7 4.5z" fill="#818cf8" />
            </marker>
            <marker id="schematic-arrow-s" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
              <path d="M0 0l7 4.5-7 4.5z" fill="#38bdf8" />
            </marker>
          </defs>

          {/* sump tank */}
          <g className={`schematic__equip${active === 'tank' ? ' is-hot' : ''}`}>
            <rect x="16" y="108" width="76" height="104" rx="7" fill="var(--schem-node)" stroke="var(--schem-stroke)" strokeWidth="1.5" />
            <rect x="16" y="162" width="76" height="50" fill="rgba(0,180,216,.10)" />
            <path d="M16 162 Q35 156 54 162 T92 162" fill="none" stroke="rgba(0,180,216,.35)" strokeWidth="1.5" />
            <text x="54" y="232" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="var(--schem-text)">SUMP TANK</text>
          </g>

          {/* suction pipe */}
          <g className={`schematic__equip${active === 'suction' ? ' is-hot' : ''}`}>
            <line x1="92" y1="150" x2="256" y2="150" stroke="var(--schem-stroke)" strokeWidth="10" />
            <line x1="92" y1="150" x2="256" y2="150" stroke="#38bdf8" strokeWidth="2.5" strokeDasharray="8 10"
              className="schematic__flow" markerEnd="url(#schematic-arrow-s)" />
            <circle cx="174" cy="128" r="10" fill="var(--schem-node)" stroke="var(--schem-stroke)" strokeWidth="1.3" />
            <line x1="174" y1="128" x2="170" y2="122" stroke="#38bdf8" strokeWidth="1.4" />
            <line x1="174" y1="140" x2="174" y2="150" stroke="var(--schem-stroke)" strokeWidth="2" />
          </g>

          {/* pump body */}
          <g className={`schematic__equip${active === 'pump' ? ' is-hot' : ''}`}>
            <circle cx="312" cy="150" r="54" fill="var(--schem-node)" stroke="var(--accent)" strokeWidth="2.5" />
            <circle cx="312" cy="150" r="34" fill="none" stroke="var(--schem-stroke)" strokeWidth="1.5" />
            <g className="schematic__impeller">
              <g stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round">
                <path d="M312 150 L312 120" />
                <path d="M312 150 L338 165" />
                <path d="M312 150 L286 165" />
              </g>
            </g>
            <circle cx="312" cy="150" r="4.5" fill="var(--accent)" />
            <text x="312" y="222" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="var(--schem-text)">CENTRIFUGAL PUMP</text>
          </g>

          {/* motor */}
          <g className={`schematic__equip${active === 'motor' ? ' is-hot' : ''}`}>
            <rect x="280" y="62" width="64" height="34" rx="5" fill="var(--schem-node)" stroke="#f97316" strokeWidth="1.7" />
            <line x1="286" y1="70" x2="338" y2="70" stroke="var(--schem-stroke)" strokeWidth="1" />
            <line x1="286" y1="76" x2="338" y2="76" stroke="var(--schem-stroke)" strokeWidth="1" />
            <line x1="286" y1="82" x2="338" y2="82" stroke="var(--schem-stroke)" strokeWidth="1" />
            <text x="312" y="112" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="#f97316">MOTOR</text>
            <line x1="312" y1="96" x2="312" y2="98" stroke="var(--schem-stroke)" strokeWidth="7" />
          </g>

          {/* discharge pipe */}
          <g className={`schematic__equip${active === 'discharge' ? ' is-hot' : ''}`}>
            <path d="M366 150 L500 150 L500 74 L664 74" fill="none" stroke="var(--schem-stroke)" strokeWidth="10" />
            <path d="M366 150 L500 150 L500 74 L664 74" fill="none" stroke="#818cf8" strokeWidth="2.5"
              strokeDasharray="8 10" className="schematic__flow" markerEnd="url(#schematic-arrow-d)" />
            <circle cx="440" cy="128" r="10" fill="var(--schem-node)" stroke="var(--schem-stroke)" strokeWidth="1.3" />
            <line x1="440" y1="128" x2="444" y2="122" stroke="#818cf8" strokeWidth="1.4" />
            <line x1="440" y1="140" x2="440" y2="150" stroke="var(--schem-stroke)" strokeWidth="2" />
          </g>

          {/* check valve */}
          <g className={`schematic__equip${active === 'valve' ? ' is-hot' : ''}`}>
            <g transform="translate(590,74)">
              <circle r="14" fill="var(--schem-node)" stroke="var(--schem-stroke-2)" strokeWidth="1.5" />
              <path d="M-8 -8 L8 8 M8 -8 L-8 8" stroke="var(--schem-icon)" strokeWidth="2" />
            </g>
            <text x="590" y="104" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="var(--schem-text)">CV-01</text>
          </g>

          <text x="676" y="70" fontFamily="JetBrains Mono" fontSize="10" fill="var(--schem-text)">OUTLET</text>

          {/* hover zones — drawn last so they sit on top of the artwork */}
          {HOTSPOTS.map((h) => (
            <rect
              key={h.id}
              className="schematic__zone"
              x={h.zone.x} y={h.zone.y} width={h.zone.w} height={h.zone.h}
              rx={h.zone.round ? Math.min(h.zone.w, h.zone.h) / 2 : 8}
              onMouseEnter={() => setActive(h.id)}
              onMouseLeave={() => setActive((cur) => (cur === h.id ? null : cur))}
              onFocus={() => setActive(h.id)}
              onBlur={() => setActive((cur) => (cur === h.id ? null : cur))}
              tabIndex={0}
              role="button"
              aria-label={`${h.name} details`}
            />
          ))}
        </svg>

        <Tag position="suction"   label="SUCTION P"    value={formatNumber(r.suctionPressure, 2)}   unit="bar"   color="#38bdf8" />
        <Tag position="flow"     label="FLOW RATE"     value={formatNumber(r.flowRate, 1)}           unit="L/min" color="var(--accent)" />
        <Tag position="discharge" label="DISCHARGE P"  value={formatNumber(r.dischargePressure, 2)}  unit="bar"   color="#818cf8" />
        <Tag position="rpm"      label="SHAFT SPEED"   value={formatNumber(r.rpm, 0)}                unit="rpm"   color="#f59e0b" />
        <Tag
          position="vibration"
          label="VIBRATION"
          value={formatNumber(r.vibration, 2)}
          unit="mm/s"
          color={vibState === 'alarm' ? 'var(--danger-bright)' : vibState === 'warn' ? 'var(--warn-bright)' : 'var(--danger-bright)'}
          className={vibAlarm ? `schematic__tag--${vibState}` : ''}
        />
        <Tag position="temp"     label="MOTOR TEMP"    value={formatNumber(r.motorTemp, 1)}          unit="°C"    color="#f97316" />

        {activeSpot && <HotspotPopover spot={activeSpot} reading={r} series={series} />}
       </div>
      </div>
    </div>
  );
}

function Tag({ position, label, value, unit, color, className }) {
  return (
    <div className={`schematic__tag schematic__tag--${position}${className ? ` ${className}` : ''}`}>
      <div className="schematic__tag-label">{label}</div>
      <div className="schematic__tag-value" style={{ color }}>
        {value}<span className="schematic__tag-unit"> {unit}</span>
      </div>
    </div>
  );
}
