// ─────────────────────────────────────────────────────────────────────────
// SensorCard.jsx — one numeric live value (flowRate / rpm / vibration / etc.).
// v2: icon color matches the card accent, digit precision per metric,
//     trend indicator uses smaller SVG arrows instead of Unicode chars.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '../../utils/formatters.js';
import { ThermometerIcon, GaugeIcon, FlowIcon, RpmIcon, VibrationIcon } from '../ui/Icons.jsx';

// Map each sensor key to its icon component
const ICONS = {
  flowRate:          FlowIcon,
  rpm:               RpmIcon,
  vibration:         VibrationIcon,
  suctionPressure:   GaugeIcon,
  dischargePressure: GaugeIcon,
  motorTemp:         ThermometerIcon,
};

// Decimal precision per sensor — RPM looks better as a whole number
const PRECISION = {
  flowRate: 1,
  rpm: 0,
  vibration: 2,
  suctionPressure: 2,
  dischargePressure: 2,
  motorTemp: 1,
};

function TrendArrow({ trend }) {
  if (trend === 'up') return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M5 8V2M2 5l3-3 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (trend === 'down') return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M5 2v6M2 5l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  return <span style={{ fontSize: '10px', opacity: 0.4 }}>—</span>;
}

export default function SensorCard({ sensor, value }) {
  const Icon = ICONS[sensor.key] ?? FlowIcon;
  const precision = PRECISION[sensor.key] ?? 1;
  const prevRef = useRef(null);
  const [pulse, setPulse] = useState(false);
  const [delta, setDelta] = useState(0);

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

  const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  const hasValue = value !== null && value !== undefined;
  const pct = hasValue
    ? Math.max(0, Math.min(100, ((value - sensor.min) / (sensor.max - sensor.min)) * 100))
    : 0;

  return (
    <article
      className={`sensor-card sensor-card--${sensor.accent}${pulse ? ' is-pulsing' : ''}`}
      aria-label={`${sensor.label}: ${hasValue ? formatNumber(value, precision) : 'no data'} ${sensor.unit}`}
    >
      <div className="sensor-card__top">
        <span className="sensor-card__icon"><Icon /></span>
        <span className="sensor-card__label">{sensor.label}</span>
        <span className={`sensor-card__trend sensor-card__trend--${trend}`}>
          <TrendArrow trend={trend} />
        </span>
      </div>

      <div className="sensor-card__value">
        {hasValue ? formatNumber(value, precision) : '--'}
        <span className="sensor-card__unit">{sensor.unit}</span>
      </div>

      <div className="sensor-card__bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="sensor-card__bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </article>
  );
}
