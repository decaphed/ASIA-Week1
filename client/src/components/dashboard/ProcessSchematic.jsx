// ─────────────────────────────────────────────────────────────────────────
// ProcessSchematic.jsx — animated P&ID hero (V2 Overview spec §06).
// Sump tank → suction pipe → centrifugal pump (spinning impeller) + motor →
// discharge pipe → check valve → outlet, with 6 live value tags. Purely
// presentational except the vibration tag, which recolors on warn/alarm.
// ─────────────────────────────────────────────────────────────────────────

import { SENSORS, getAlarmState } from '../../utils/constants.js';
import { formatNumber } from '../../utils/formatters.js';

const VIBRATION = SENSORS.find((s) => s.key === 'vibration');

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

export default function ProcessSchematic({ reading }) {
  const r = reading || {};
  const vibState = getAlarmState(VIBRATION, r.vibration);
  const vibAlarm = vibState === 'alarm' || vibState === 'warn';

  return (
    <div className="schematic">
      <div className="schematic__header">
        <span className="schematic__title">Process Schematic — P&amp;ID</span>
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
          <rect x="16" y="108" width="76" height="104" rx="7" fill="#0b1520" stroke="#213648" strokeWidth="1.5" />
          <rect x="16" y="162" width="76" height="50" fill="rgba(0,180,216,.10)" />
          <path d="M16 162 Q35 156 54 162 T92 162" fill="none" stroke="rgba(0,180,216,.35)" strokeWidth="1.5" />
          <text x="54" y="232" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="#435a6a">SUMP TANK</text>

          {/* suction pipe */}
          <line x1="92" y1="150" x2="256" y2="150" stroke="#213648" strokeWidth="10" />
          <line x1="92" y1="150" x2="256" y2="150" stroke="#38bdf8" strokeWidth="2.5" strokeDasharray="8 10"
            className="schematic__flow" markerEnd="url(#schematic-arrow-s)" />
          <circle cx="174" cy="128" r="10" fill="#0b1520" stroke="#213648" strokeWidth="1.3" />
          <line x1="174" y1="128" x2="170" y2="122" stroke="#38bdf8" strokeWidth="1.4" />
          <line x1="174" y1="140" x2="174" y2="150" stroke="#213648" strokeWidth="2" />

          {/* pump body */}
          <circle cx="312" cy="150" r="54" fill="#0b1520" stroke="var(--accent)" strokeWidth="2.5" />
          <circle cx="312" cy="150" r="34" fill="none" stroke="#213648" strokeWidth="1.5" />
          <g className="schematic__impeller">
            <g stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round">
              <path d="M312 150 L312 120" />
              <path d="M312 150 L338 165" />
              <path d="M312 150 L286 165" />
            </g>
          </g>
          <circle cx="312" cy="150" r="4.5" fill="var(--accent)" />
          <text x="312" y="222" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="#435a6a">CENTRIFUGAL PUMP</text>

          {/* motor */}
          <rect x="280" y="62" width="64" height="34" rx="5" fill="#0b1520" stroke="#f97316" strokeWidth="1.7" />
          <line x1="286" y1="70" x2="338" y2="70" stroke="#213648" strokeWidth="1" />
          <line x1="286" y1="76" x2="338" y2="76" stroke="#213648" strokeWidth="1" />
          <line x1="286" y1="82" x2="338" y2="82" stroke="#213648" strokeWidth="1" />
          <text x="312" y="112" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="#f97316">MOTOR</text>
          <line x1="312" y1="96" x2="312" y2="98" stroke="#213648" strokeWidth="7" />

          {/* discharge pipe */}
          <path d="M366 150 L500 150 L500 74 L664 74" fill="none" stroke="#213648" strokeWidth="10" />
          <path d="M366 150 L500 150 L500 74 L664 74" fill="none" stroke="#818cf8" strokeWidth="2.5"
            strokeDasharray="8 10" className="schematic__flow" markerEnd="url(#schematic-arrow-d)" />

          {/* check valve */}
          <g transform="translate(590,74)">
            <circle r="14" fill="#0b1520" stroke="#435a6a" strokeWidth="1.5" />
            <path d="M-8 -8 L8 8 M8 -8 L-8 8" stroke="#7a94a8" strokeWidth="2" />
          </g>
          <text x="590" y="104" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="#435a6a">CV-01</text>

          <circle cx="440" cy="128" r="10" fill="#0b1520" stroke="#213648" strokeWidth="1.3" />
          <line x1="440" y1="128" x2="444" y2="122" stroke="#818cf8" strokeWidth="1.4" />
          <line x1="440" y1="140" x2="440" y2="150" stroke="#213648" strokeWidth="2" />
          <text x="676" y="70" fontFamily="JetBrains Mono" fontSize="10" fill="#435a6a">OUTLET</text>
        </svg>

        <Tag position="suction"   label="SUCTION P"    value={formatNumber(r.suctionPressure, 2)}   unit="bar"   color="#38bdf8" />
        <Tag position="flow"     label="FLOW RATE"     value={formatNumber(r.flowRate, 1)}           unit="L/min" color="var(--accent)" />
        <Tag position="discharge" label="DISCHARGE P"  value={formatNumber(r.dischargePressure, 2)}  unit="bar"   color="#818cf8" />
        <Tag position="rpm"      label="SHAFT SPEED"   value={formatNumber(r.rpm, 0)}                unit="rpm"   color="#f59e0b" />
        <Tag
          position="vibration"
          label={vibAlarm ? '⚠ VIBRATION' : 'VIBRATION'}
          value={formatNumber(r.vibration, 2)}
          unit="mm/s"
          color={vibState === 'alarm' ? 'var(--danger-bright)' : vibState === 'warn' ? 'var(--warn-bright)' : 'var(--danger-bright)'}
          className={vibAlarm ? `schematic__tag--${vibState}` : ''}
        />
        <Tag position="temp"     label="MOTOR TEMP"    value={formatNumber(r.motorTemp, 1)}          unit="°C"    color="#f97316" />
       </div>
      </div>
    </div>
  );
}
