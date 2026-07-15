// ─────────────────────────────────────────────────────────────────────────
// ProcessSchematic.jsx — interactive animated P&ID hero.
// Sump tank → suction pipe → centrifugal pump (spinning impeller) + motor →
// discharge pipe → check valve → outlet, with 6 live value tags.
// v5: every piece of equipment is a hover hotspot — pointing at the pump,
//     motor, valve, tank or either pipe run pops a data card with that
//     component's live metrics, status and a sparkline (design ref: the
//     "highlight the valve, see its data" inspection view).
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { animate } from 'animejs';
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
    zone: { x: 562, y: 26, w: 56, h: 66 },
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
  const popRef = useRef(null);

  // Fade + settle in whenever a new hotspot becomes active.
  useEffect(() => {
    if (!popRef.current) return;
    animate(popRef.current, {
      opacity: [0, 1],
      scale: [0.96, 1],
      duration: 180,
      ease: 'outQuad',
    });
  }, [spot.id]);

  const style = {};
  for (const side of ['left', 'right', 'top', 'bottom']) {
    if (spot.pop[side] != null) style[side] = spot.pop[side];
  }

  return (
    <div className={`schematic__pop schematic__pop--${state}`} style={style} role="status" ref={popRef}>
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

  // Digital-twin state: flow dashes and the impeller only move while the
  // pump is actually RUNNING, and the dash speed scales with real flow rate
  // (nominal ~175 L/min → 1.1s per cycle) so the pipe animation is a data
  // encoding, not decoration.
  const running = r.status === 'RUNNING';
  const flowSpeed = running && r.flowRate > 0
    ? `${Math.min(3, Math.max(0.55, 1.1 * (175 / r.flowRate))).toFixed(2)}s`
    : '1.1s';

  // Status pill tone: ok while running, warn while deliberately stopped,
  // alarm on an auto-trip fault, neutral before the first reading arrives.
  const statusTone = !r.status ? 'neutral'
    : r.status === 'RUNNING' ? 'ok'
      : r.status === 'FAULT' ? 'alarm'
        : 'warn';

  // Persistent per-component alarm glow — a fault is flagged on the diagram
  // itself, not only when someone happens to hover the right hotspot.
  const equipState = {};
  for (const spot of HOTSPOTS) equipState[spot.id] = worstState(r, spot.metrics);
  const equipClass = (id) =>
    `schematic__equip${active === id ? ' is-hot' : ''}` +
    (equipState[id] === 'alarm' ? ' schematic__equip--alarm'
      : equipState[id] === 'warn' ? ' schematic__equip--warn' : '');

  return (
    <div
      className={`schematic${running ? ' schematic--running' : ''}`}
      style={{ '--flow-speed': flowSpeed }}
    >
      <div className="schematic__header">
        <span className="schematic__title">Process Schematic — P&amp;ID</span>
        <span className="schematic__hint">Hover equipment for details</span>
        <span className="schematic__live">
          <span className="schematic__live-dot" />Live · 1s poll
        </span>
      </div>

      <div className="schematic__body">
       <div className="schematic__stage">
        {r.status && (
          <div className={`schematic__status schematic__status--${statusTone}`} role="status">
            <span className="schematic__status-dot" aria-hidden="true" />
            {r.status}
          </div>
        )}
        <svg viewBox="0 0 720 300" className="schematic__svg">
          <defs>
            <pattern id="schem-grid" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="var(--border-light)" opacity="0.5" />
            </pattern>
            <marker id="schematic-arrow-d" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
              <path d="M0 0l7 4.5-7 4.5z" fill="#818cf8" />
            </marker>
            <marker id="schematic-arrow-s" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
              <path d="M0 0l7 4.5-7 4.5z" fill="#38bdf8" />
            </marker>
            {/* cylindrical shading for horizontal pipe runs / metal bodies */}
            <linearGradient id="schem-pipe" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0"   style={{ stopColor: 'var(--pipe-hi)' }} />
              <stop offset="0.45" style={{ stopColor: 'var(--pipe-mid)' }} />
              <stop offset="1"   style={{ stopColor: 'var(--pipe-lo)' }} />
            </linearGradient>
            {/* tank cylinder — light band down the middle */}
            <linearGradient id="schem-tank" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0"    style={{ stopColor: 'var(--pipe-lo)' }} />
              <stop offset="0.35" style={{ stopColor: 'var(--pipe-hi)' }} />
              <stop offset="0.7"  style={{ stopColor: 'var(--pipe-mid)' }} />
              <stop offset="1"    style={{ stopColor: 'var(--pipe-lo)' }} />
            </linearGradient>
            {/* amber highlight body — the hero component, like the reference */}
            <radialGradient id="schem-amber" cx="0.35" cy="0.32" r="0.95">
              <stop offset="0"   style={{ stopColor: 'var(--amber-hi)' }} />
              <stop offset="0.55" style={{ stopColor: 'var(--amber-mid)' }} />
              <stop offset="1"   style={{ stopColor: 'var(--amber-lo)' }} />
            </radialGradient>
          </defs>

          <rect x="0" y="0" width="720" height="300" fill="url(#schem-grid)" />

          {/* sump tank — 3D cylinder with wireframe hoops */}
          <g className={equipClass('tank')}>
            <ellipse cx="54" cy="210" rx="37" ry="10" fill="var(--schem-shadow)" />
            <rect x="17" y="116" width="74" height="92" fill="url(#schem-tank)" stroke="var(--pipe-line)" strokeWidth="1" />
            <ellipse cx="54" cy="146" rx="37" ry="10" fill="none" stroke="var(--pipe-line)" strokeWidth="1" />
            <ellipse cx="54" cy="176" rx="37" ry="10" fill="none" stroke="var(--pipe-line)" strokeWidth="1" />
            <line x1="35" y1="118" x2="35" y2="206" stroke="var(--pipe-line)" strokeWidth="0.8" />
            <line x1="73" y1="118" x2="73" y2="206" stroke="var(--pipe-line)" strokeWidth="0.8" />
            <ellipse cx="54" cy="208" rx="37" ry="10" fill="var(--pipe-lo)" stroke="var(--pipe-line)" strokeWidth="1" />
            <ellipse cx="54" cy="116" rx="37" ry="10" fill="var(--pipe-hi)" stroke="var(--pipe-line)" strokeWidth="1.2" />
            <ellipse cx="54" cy="116" rx="26" ry="6.5" fill="none" stroke="var(--pipe-line)" strokeWidth="0.8" />
            <text x="54" y="232" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="var(--schem-text)">SUMP TANK</text>
          </g>

          {/* suction pipe — shaded tube with flange rings */}
          <g className={equipClass('suction')}>
            <rect x="88" y="141" width="172" height="18" rx="9" fill="url(#schem-pipe)" stroke="var(--pipe-line)" strokeWidth="1" />
            <line x1="94" y1="145.5" x2="254" y2="145.5" stroke="var(--pipe-sheen)" strokeWidth="1.6" strokeLinecap="round" />
            <ellipse cx="104" cy="150" rx="4" ry="11.5" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1" />
            <ellipse cx="216" cy="150" rx="4" ry="11.5" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1" />
            <line x1="96" y1="150" x2="254" y2="150" stroke="#38bdf8" strokeWidth="2.2" strokeDasharray="8 10"
              className="schematic__flow" markerEnd="url(#schematic-arrow-s)" opacity="0.85" />
            <line x1="174" y1="139" x2="174" y2="128" stroke="var(--pipe-lo)" strokeWidth="3" />
            <circle cx="174" cy="122" r="9" fill="url(#schem-pipe)" stroke="var(--pipe-line)" strokeWidth="1.2" />
            <line x1="174" y1="122" x2="170" y2="116" stroke="#38bdf8" strokeWidth="1.4" />
          </g>

          {/* pump — amber volute (the hero piece) with wireframe rings */}
          <g className={`${equipClass('pump')} schematic__pump-body`}>
            <ellipse cx="312" cy="212" rx="48" ry="8" fill="var(--schem-shadow)" />
            <circle cx="312" cy="150" r="54" fill="url(#schem-amber)" stroke="var(--amber-lo)" strokeWidth="2" />
            <circle cx="312" cy="150" r="44" fill="none" stroke="var(--amber-wire)" strokeWidth="1" />
            <circle cx="312" cy="150" r="33" fill="none" stroke="var(--amber-wire)" strokeWidth="1" />
            <circle cx="312" cy="150" r="21" fill="none" stroke="var(--amber-wire)" strokeWidth="1" />
            <g className="schematic__impeller">
              <g stroke="#7c4a03" strokeWidth="2.6" strokeLinecap="round">
                <path d="M312 150 C312 138 316 130 312 120" fill="none" />
                <path d="M312 150 C322 156 330 158 338 165" fill="none" />
                <path d="M312 150 C302 156 294 158 286 165" fill="none" />
              </g>
            </g>
            <circle cx="312" cy="150" r="5" fill="#7c4a03" />
            <circle cx="310" cy="148" r="1.6" fill="var(--amber-hi)" />
            <text x="312" y="232" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="var(--schem-text)">CENTRIFUGAL PUMP</text>
          </g>

          {/* motor — isometric block with cooling fins */}
          <g className={equipClass('motor')}>
            <polygon points="280,62 288,54 352,54 344,62" fill="var(--pipe-hi)" stroke="var(--pipe-line)" strokeWidth="1" />
            <polygon points="344,62 352,54 352,88 344,96" fill="var(--pipe-lo)" stroke="var(--pipe-line)" strokeWidth="1" />
            <rect x="280" y="62" width="64" height="34" rx="2" fill="url(#schem-pipe)" stroke="var(--pipe-line)" strokeWidth="1.2" />
            <line x1="286" y1="70" x2="338" y2="70" stroke="var(--pipe-line)" strokeWidth="1" />
            <line x1="286" y1="76" x2="338" y2="76" stroke="var(--pipe-line)" strokeWidth="1" />
            <line x1="286" y1="82" x2="338" y2="82" stroke="var(--pipe-line)" strokeWidth="1" />
            <line x1="286" y1="88" x2="338" y2="88" stroke="var(--pipe-line)" strokeWidth="1" />
            <text x="266" y="80" textAnchor="end" fontFamily="JetBrains Mono" fontSize="9" fill="var(--schem-text)">MOTOR</text>
            <rect x="308" y="96" width="8" height="4" fill="var(--pipe-lo)" />
          </g>

          {/* discharge pipe — layered strokes for a cylindrical sheen */}
          <g className={equipClass('discharge')}>
            <path d="M366 150 L497 150 Q506 150 506 141 L506 83 Q506 74 515 74 L664 74"
              fill="none" stroke="var(--pipe-lo)" strokeWidth="19" strokeLinecap="round" />
            <path d="M366 150 L497 150 Q506 150 506 141 L506 83 Q506 74 515 74 L664 74"
              fill="none" stroke="url(#schem-pipe)" strokeWidth="15" strokeLinecap="round" />
            <path d="M366 146 L494 146 M510 78 L660 78"
              fill="none" stroke="var(--pipe-sheen)" strokeWidth="1.6" strokeLinecap="round" />
            <ellipse cx="382" cy="150" rx="4" ry="12" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1" />
            <ellipse cx="660" cy="74" rx="4" ry="12" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1" />
            <path d="M370 150 L496 150 Q506 150 506 140 L506 84 Q506 74 516 74 L662 74" fill="none" stroke="#818cf8" strokeWidth="2.2"
              strokeDasharray="8 10" className="schematic__flow" markerEnd="url(#schematic-arrow-d)" opacity="0.85" />
            <line x1="440" y1="139" x2="440" y2="128" stroke="var(--pipe-lo)" strokeWidth="3" />
            <circle cx="440" cy="122" r="9" fill="url(#schem-pipe)" stroke="var(--pipe-line)" strokeWidth="1.2" />
            <line x1="440" y1="122" x2="444" y2="116" stroke="#818cf8" strokeWidth="1.4" />
          </g>

          {/* check valve — flanged body with a 3D handwheel, like the reference */}
          <g className={equipClass('valve')}>
            <ellipse cx="590" cy="38" rx="21" ry="7.5" fill="none" stroke="var(--pipe-lo)" strokeWidth="2.4" />
            <line x1="569" y1="38" x2="611" y2="38" stroke="var(--pipe-lo)" strokeWidth="1.4" />
            <line x1="590" y1="30.5" x2="590" y2="45.5" stroke="var(--pipe-lo)" strokeWidth="1.4" />
            <circle cx="590" cy="38" r="3" fill="var(--pipe-lo)" />
            <line x1="590" y1="45" x2="590" y2="62" stroke="var(--pipe-lo)" strokeWidth="4" />
            <ellipse cx="574" cy="74" rx="3.5" ry="12" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1" />
            <ellipse cx="606" cy="74" rx="3.5" ry="12" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1" />
            <path d="M578 65 L590 74 L578 83 Z" fill="url(#schem-pipe)" stroke="var(--pipe-line)" strokeWidth="1.2" />
            <path d="M602 65 L590 74 L602 83 Z" fill="url(#schem-pipe)" stroke="var(--pipe-line)" strokeWidth="1.2" />
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
          color={vibState === 'alarm' ? 'var(--danger-bright)' : vibState === 'warn' ? 'var(--warn-bright)' : 'var(--accent)'}
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
