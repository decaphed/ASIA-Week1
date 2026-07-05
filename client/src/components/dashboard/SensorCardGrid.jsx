// ─────────────────────────────────────────────────────────────────────────
// SensorCardGrid.jsx — the row of live cards.
//
// Renders the three numeric SensorCards from the SENSORS config plus a special
// Light card (boolean on/off) and the timestamp of the latest reading. When
// `reading` is null (no data yet / backend down) every card shows "--".
// ─────────────────────────────────────────────────────────────────────────

import SensorCard from './SensorCard.jsx';
import { SENSORS } from '../../utils/constants.js';
import { formatTime } from '../../utils/formatters.js';

export default function SensorCardGrid({ reading }) {
  const hasReading = reading !== null && reading !== undefined;
  const light = hasReading ? reading.light : null;

  return (
    <div className="sensor-grid">
      {SENSORS.map((sensor) => (
        <SensorCard
          key={sensor.key}
          sensor={sensor}
          value={hasReading ? reading[sensor.key] : null}
        />
      ))}

      {/* Light is boolean, so it gets its own on/off card. */}
      <article className={`sensor-card sensor-card--light ${light ? 'is-on' : 'is-off'}`}>
        <div className="sensor-card__top">
          <span className="sensor-card__icon">{light ? '💡' : '🌙'}</span>
          <span className="sensor-card__label">Light</span>
        </div>
        <div className="sensor-card__value sensor-card__value--text">
          {!hasReading ? '--' : light ? 'ON' : 'OFF'}
        </div>
        <div className="sensor-card__timestamp">
          Updated {formatTime(hasReading ? reading.timestamp : null)}
        </div>
      </article>
    </div>
  );
}
