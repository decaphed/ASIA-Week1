// ─────────────────────────────────────────────────────────────────────────
// SensorCard.jsx — one numeric live value (temperature / humidity / pressure).
//
// Requirement: "Animate cards whenever values change." We remember the
// previous value in a ref; when a new value differs we (a) flash the card via
// the .is-pulsing class for 600ms and (b) compute a small up/down trend arrow.
// The fill-bar shows where the value sits within its expected min–max range.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '../../utils/formatters.js';

export default function SensorCard({ sensor, value }) {
  const prevRef = useRef(null);
  const [pulse, setPulse] = useState(false);
  const [delta, setDelta] = useState(0);

  useEffect(() => {
    if (value === null || value === undefined) return;
    const prev = prevRef.current;

    if (prev !== null && value !== prev) {
      setDelta(value - prev);
      setPulse(true);
      const id = setTimeout(() => setPulse(false), 600);
      prevRef.current = value;
      return () => clearTimeout(id);
    }
    prevRef.current = value;
  }, [value]);

  const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—';

  const hasValue = value !== null && value !== undefined;
  const pct = hasValue
    ? Math.max(0, Math.min(100, ((value - sensor.min) / (sensor.max - sensor.min)) * 100))
    : 0;

  return (
    <article className={`sensor-card sensor-card--${sensor.accent} ${pulse ? 'is-pulsing' : ''}`}>
      <div className="sensor-card__top">
        <span className="sensor-card__icon">{sensor.icon}</span>
        <span className="sensor-card__label">{sensor.label}</span>
        <span className={`sensor-card__trend sensor-card__trend--${trend}`}>{arrow}</span>
      </div>

      <div className="sensor-card__value">
        {hasValue ? formatNumber(value) : '--'}
        <span className="sensor-card__unit">{sensor.unit}</span>
      </div>

      <div className="sensor-card__bar">
        <div className="sensor-card__bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </article>
  );
}
