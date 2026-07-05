// ─────────────────────────────────────────────────────────────────────────
// SensorCard.jsx — industrial KPI card for one pump metric.
// v3: alarm/warn state detection, threshold markers on fill-bar,
//     value colour driven by alarm level, industrial icon sizing.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '../../utils/formatters.js';
import { getAlarmState } from '../../utils/constants.js';
import {
  FlowIcon, RpmIcon, VibrationIcon,
  GaugeIcon, ThermometerIcon,
} from '../ui/Icons.jsx';

const ICONS = {
  flowRate:          FlowIcon,
  rpm:               RpmIcon,
  vibration:         VibrationIcon,
  suctionPressure:   GaugeIcon,
  dischargePressure: GaugeIcon,
  motorTemp:         ThermometerIcon,
};

const PRECISION = {
  flowRate: 1, rpm: 0, vibration: 2,
  suctionPressure: 2, dischargePressure: 2, motorTemp: 1,
};

function TrendArrow({ trend }) {
  if (trend === 'up') return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M5 8V2M2 5l3-3 3 3" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (trend === 'down') return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M5 2v6M2 5l3 3 3-3" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  return null;
}

export default function SensorCard({ sensor, value }) {
  const Icon      = ICONS[sensor.key] ?? FlowIcon;
  const precision = PRECISION[sensor.key] ?? 1;
  const alarm     = getAlarmState(sensor, value);

  const prevRef = useRef(null);
  const [pulse, setPulse]   = useState(false);
  const [delta, setDelta]   = useState(0);

  useEffect(() => {
    if (value === null || value === undefined) return;
    const prev = prevRef.current;
    if (prev !== null && value !== prev) {
      setDelta(value - prev);
      setPulse(true);
      const id = setTimeout(() => setPulse(false), 550);
      prevRef.current = value;
      return () => clearTimeout(id);
    }
    prevRef.current = value;
  }, [value]);

  const trend    = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const hasValue = value !== null && value !== undefined;

  // Fill bar: position within operating range
  const pct = hasValue
    ? Math.max(0, Math.min(100, ((value - sensor.min) / (sensor.max - sensor.min)) * 100))
    : 0;

  // Warn/alarm threshold marker positions on the bar
  const warnPct  = sensor.warnHigh  != null
    ? Math.max(0, Math.min(100, ((sensor.warnHigh  - sensor.min) / (sensor.max - sensor.min)) * 100)) : null;
  const alarmPct = sensor.alarmHigh != null
    ? Math.max(0, Math.min(100, ((sensor.alarmHigh - sensor.min) / (sensor.max - sensor.min)) * 100)) : null;

  return (
    <article
      className={`sensor-card sensor-card--${sensor.accent} sensor-card--alarm-${alarm}${pulse ? ' is-pulsing' : ''}`}
      aria-label={`${sensor.label}: ${hasValue ? formatNumber(value, precision) : 'no data'} ${sensor.unit}${alarm !== 'normal' && alarm !== 'nodata' ? '. ' + alarm.toUpperCase() : ''}`}
    >
      {/* Alarm badge — only visible when warn or alarm */}
      {(alarm === 'warn' || alarm === 'alarm') && (
        <span className={`sensor-card__alarm-badge sensor-card__alarm-badge--${alarm}`}
          aria-label={alarm === 'alarm' ? 'Alarm' : 'Warning'}>
          {alarm === 'alarm' ? '⚠ ALARM' : '⚠ WARN'}
        </span>
      )}

      <div className="sensor-card__top">
        <span className="sensor-card__icon"><Icon /></span>
        <div className="sensor-card__meta">
          <span className="sensor-card__shortlabel">{sensor.shortLabel}</span>
          <span className="sensor-card__label">{sensor.label}</span>
        </div>
        <span className={`sensor-card__trend sensor-card__trend--${trend}`}>
          <TrendArrow trend={trend} />
        </span>
      </div>

      <div className={`sensor-card__value sensor-card__value--alarm-${alarm}`}>
        {hasValue ? formatNumber(value, precision) : '--'}
        <span className="sensor-card__unit">{sensor.unit}</span>
      </div>

      {/* Fill bar with threshold markers */}
      <div className="sensor-card__bar-wrap">
        <div className="sensor-card__bar"
          role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="sensor-card__bar-fill" style={{ width: `${pct}%` }} />
          {warnPct  !== null && (
            <div className="sensor-card__bar-marker sensor-card__bar-marker--warn"
              style={{ left: `${warnPct}%` }} aria-hidden="true" />
          )}
          {alarmPct !== null && (
            <div className="sensor-card__bar-marker sensor-card__bar-marker--alarm"
              style={{ left: `${alarmPct}%` }} aria-hidden="true" />
          )}
        </div>
        <div className="sensor-card__bar-limits">
          <span>{formatNumber(sensor.min, 0)}</span>
          <span>{formatNumber(sensor.max, 0)}</span>
        </div>
      </div>
    </article>
  );
}
