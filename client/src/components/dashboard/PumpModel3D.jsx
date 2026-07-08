// ─────────────────────────────────────────────────────────────────────────
// PumpModel3D.jsx — pseudo-3D "asset card" view of the pump (Van_Model +
// SCADA inspiration): a large rendered pump on a clean stage with live
// sensor nodes pinned at their physical locations. Hover, focus or tap a
// node to open the same metric/status popover the P&ID uses (classes are
// shared with ProcessSchematic so both views stay visually consistent).
// Pure SVG gradients — no 3D library.
// ─────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { SENSORS, getAlarmState, PUMP_NAME, PUMP_AREA, PUMP_ID } from '../../utils/constants.js';
import { formatNumber } from '../../utils/formatters.js';

const SENSOR_MAP = Object.fromEntries(SENSORS.map((s) => [s.key, s]));

// Sensor nodes pinned on the render (viewBox 560×300 coordinates).
const NODES = [
  { id: 'suction',   label: 'Inlet',   metrics: ['suctionPressure'],   x: 76,  y: 186 },
  { id: 'discharge', label: 'Outlet',  metrics: ['dischargePressure'], x: 208, y: 52  },
  { id: 'flow',      label: 'Flow',    metrics: ['flowRate'],          x: 246, y: 96  },
  { id: 'bearing',   label: 'Bearing', metrics: ['vibration'],         x: 292, y: 168 },
  { id: 'shaft',     label: 'Shaft',   metrics: ['rpm'],               x: 336, y: 140 },
  { id: 'motor',     label: 'Motor',   metrics: ['motorTemp'],         x: 452, y: 118 },
];

function worstState(reading, keys) {
  const rank = { alarm: 3, warn: 2, normal: 1, nodata: 0 };
  return keys.reduce((worst, k) => {
    const s = getAlarmState(SENSOR_MAP[k], reading?.[k]);
    return rank[s] > rank[worst] ? s : worst;
  }, 'nodata');
}

const STATE_LABEL = { alarm: 'ALARM', warn: 'WARNING', normal: 'NORMAL', nodata: 'NO DATA' };

function NodePopover({ node, reading }) {
  const state = worstState(reading, node.metrics);
  // Anchor near the node, flipping side past the horizontal midpoint.
  const style = node.x < 280
    ? { left: `${(node.x / 560) * 100}%`, top: `${Math.max(2, (node.y / 300) * 100 - 34)}%` }
    : { right: `${100 - (node.x / 560) * 100}%`, top: `${Math.max(2, (node.y / 300) * 100 - 34)}%` };

  return (
    <div className={`schematic__pop schematic__pop--${state}`} style={style} role="status">
      <div className="schematic__pop-head">
        <div>
          <div className="schematic__pop-name">{node.label} sensor</div>
          <div className="schematic__pop-tagid">{PUMP_ID} · live reading</div>
        </div>
        <span className={`schematic__pop-state schematic__pop-state--${state}`}>
          {STATE_LABEL[state]}
        </span>
      </div>
      <div className="schematic__pop-metrics">
        {node.metrics.map((k) => {
          const s = SENSOR_MAP[k];
          const st = getAlarmState(s, reading?.[k]);
          return (
            <div key={k} className="schematic__pop-metric">
              <span className="schematic__pop-metric-label">{s.label}</span>
              <span className={`schematic__pop-metric-value schematic__pop-metric-value--${st}`}>
                {formatNumber(reading?.[k], s.prec)}<small> {s.unit}</small>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PumpModel3D({ reading }) {
  const r = reading || {};
  const [active, setActive] = useState(null);
  const running = r.status === 'RUNNING';
  const activeNode = NODES.find((n) => n.id === active) || null;

  const toggle = (id) => setActive((cur) => (cur === id ? null : id));

  return (
    <div className={`pump3d${running ? ' pump3d--running' : ''}`}>
      {/* Spec rail — the Van_Model layout: identity + key facts beside the render */}
      <div className="pump3d__specs">
        <span className={`pump3d__status pump3d__status--${(r.status || 'offline').toLowerCase()}`}>
          {r.status ?? 'OFFLINE'}
        </span>
        <h3 className="pump3d__name">{PUMP_NAME}</h3>
        <p className="pump3d__area">{PUMP_AREA}</p>
        <dl className="pump3d__facts">
          <div><dt>Flow</dt><dd>{formatNumber(r.flowRate, 1)} <small>L/min</small></dd></div>
          <div><dt>Speed</dt><dd>{formatNumber(r.rpm, 0)} <small>rpm</small></dd></div>
          <div><dt>Motor</dt><dd>{formatNumber(r.motorTemp, 1)} <small>°C</small></dd></div>
        </dl>
        <p className="pump3d__hint">Hover or tap a sensor point for details</p>
      </div>

      {/* Stage — pseudo-3D render + pinned live sensor nodes */}
      <div className="pump3d__stage">
        <svg viewBox="0 0 560 300" className="pump3d__svg" aria-label="3D pump model with live sensors">
          <defs>
            <radialGradient id="p3d-volute" cx="0.32" cy="0.28" r="1">
              <stop offset="0"   style={{ stopColor: 'var(--amber-hi)' }} />
              <stop offset="0.5" style={{ stopColor: 'var(--amber-mid)' }} />
              <stop offset="1"   style={{ stopColor: 'var(--amber-lo)' }} />
            </radialGradient>
            <linearGradient id="p3d-metal" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0"    style={{ stopColor: 'var(--pipe-hi)' }} />
              <stop offset="0.45" style={{ stopColor: 'var(--pipe-mid)' }} />
              <stop offset="1"    style={{ stopColor: 'var(--pipe-lo)' }} />
            </linearGradient>
            <linearGradient id="p3d-motor" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0"    style={{ stopColor: 'var(--pipe-hi)' }} />
              <stop offset="0.35" style={{ stopColor: 'var(--pipe-mid)' }} />
              <stop offset="1"    style={{ stopColor: 'var(--pipe-lo)' }} />
            </linearGradient>
          </defs>

          {/* ground shadow + base skid */}
          <ellipse cx="290" cy="252" rx="215" ry="18" fill="var(--schem-shadow)" />
          <polygon points="105,236 130,222 480,222 455,236" fill="var(--pipe-lo)" stroke="var(--pipe-line)" strokeWidth="1" />
          <rect x="105" y="236" width="350" height="10" rx="2" fill="url(#p3d-metal)" stroke="var(--pipe-line)" strokeWidth="1" />

          {/* suction pipe (left, into volute eye) */}
          <rect x="40" y="172" width="140" height="26" rx="13" fill="url(#p3d-metal)" stroke="var(--pipe-line)" strokeWidth="1.2" />
          <line x1="48" y1="178" x2="172" y2="178" stroke="var(--pipe-sheen)" strokeWidth="2" strokeLinecap="round" />
          <ellipse cx="76" cy="185" rx="5" ry="16" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1.2" />
          <ellipse cx="40" cy="185" rx="6" ry="17" fill="var(--pipe-hi)" stroke="var(--pipe-line)" strokeWidth="1.2" />

          {/* discharge pipe (up from volute) */}
          <rect x="196" y="44" width="26" height="96" rx="13" fill="url(#p3d-metal)" stroke="var(--pipe-line)" strokeWidth="1.2" />
          <line x1="202" y1="52" x2="202" y2="132" stroke="var(--pipe-sheen)" strokeWidth="2" strokeLinecap="round" />
          <ellipse cx="209" cy="52" rx="17" ry="6" fill="var(--pipe-hi)" stroke="var(--pipe-line)" strokeWidth="1.2" />
          <ellipse cx="209" cy="96" rx="16" ry="5" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1" />

          {/* volute casing — the amber hero piece */}
          <g className="pump3d__body">
            <circle cx="210" cy="170" r="66" fill="url(#p3d-volute)" stroke="var(--amber-lo)" strokeWidth="2.5" />
            <circle cx="210" cy="170" r="52" fill="none" stroke="var(--amber-wire)" strokeWidth="1.2" />
            <circle cx="210" cy="170" r="38" fill="none" stroke="var(--amber-wire)" strokeWidth="1.2" />
            <ellipse cx="188" cy="146" rx="20" ry="12" fill="rgba(255,255,255,0.28)" transform="rotate(-24 188 146)" />
            <g className="pump3d__impeller">
              <g stroke="#7c4a03" strokeWidth="3" strokeLinecap="round" fill="none">
                <path d="M210 170 C210 156 215 147 210 134" />
                <path d="M210 170 C222 177 231 179 240 188" />
                <path d="M210 170 C198 177 189 179 180 188" />
              </g>
            </g>
            <circle cx="210" cy="170" r="7" fill="#7c4a03" />
            {[0, 60, 120, 180, 240, 300].map((deg) => (
              <circle
                key={deg}
                cx={210 + 59 * Math.cos((deg * Math.PI) / 180)}
                cy={170 + 59 * Math.sin((deg * Math.PI) / 180)}
                r="2.6" fill="var(--amber-lo)"
              />
            ))}
          </g>

          {/* bearing frame + shaft/coupling */}
          <rect x="272" y="150" width="52" height="40" rx="6" fill="url(#p3d-metal)" stroke="var(--pipe-line)" strokeWidth="1.2" />
          <rect x="324" y="158" width="26" height="24" rx="4" fill="var(--pipe-lo)" stroke="var(--pipe-line)" strokeWidth="1.2" />
          <line x1="278" y1="156" x2="318" y2="156" stroke="var(--pipe-sheen)" strokeWidth="1.6" strokeLinecap="round" />

          {/* motor — finned cylinder */}
          <rect x="350" y="112" width="130" height="110" rx="14" fill="url(#p3d-motor)" stroke="var(--pipe-line)" strokeWidth="1.4" />
          {[126, 142, 158, 174, 190, 206].map((y) => (
            <line key={y} x1="358" y1={y} x2="472" y2={y} stroke="var(--pipe-line)" strokeWidth="1.4" />
          ))}
          <ellipse cx="480" cy="167" rx="12" ry="55" fill="var(--pipe-mid)" stroke="var(--pipe-line)" strokeWidth="1.4" />
          <ellipse cx="480" cy="167" rx="5" ry="26" fill="var(--pipe-lo)" stroke="var(--pipe-line)" strokeWidth="1" />
          <rect x="392" y="96" width="46" height="16" rx="3" fill="var(--pipe-lo)" stroke="var(--pipe-line)" strokeWidth="1.2" />
          <line x1="358" y1="120" x2="472" y2="120" stroke="var(--pipe-sheen)" strokeWidth="2" strokeLinecap="round" />

          {/* live sensor nodes — drawn last, on top */}
          {NODES.map((n) => {
            const state = worstState(r, n.metrics);
            return (
              <g
                key={n.id}
                className={`pump3d__node pump3d__node--${state}${active === n.id ? ' is-active' : ''}`}
                transform={`translate(${n.x} ${n.y})`}
                onMouseEnter={() => setActive(n.id)}
                onMouseLeave={() => setActive((cur) => (cur === n.id ? null : cur))}
                onClick={() => toggle(n.id)}
                onFocus={() => setActive(n.id)}
                onBlur={() => setActive((cur) => (cur === n.id ? null : cur))}
                tabIndex={0}
                role="button"
                aria-label={`${n.label} sensor details`}
              >
                <circle className="pump3d__node-ring" r="11" />
                <circle className="pump3d__node-core" r="4.5" />
              </g>
            );
          })}
        </svg>

        {activeNode && <NodePopover node={activeNode} reading={r} />}
      </div>
    </div>
  );
}
