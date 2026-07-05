// ─────────────────────────────────────────────────────────────────────────
// SensorCardGrid.jsx — the row of live cards.
//
// Renders the six numeric SensorCards from the SENSORS config plus a special
// Status card (RUNNING / STOPPED / FAULT) and the timestamp of the latest
// reading. When `reading` is null (no data yet / backend down) every card
// shows "--".
// ─────────────────────────────────────────────────────────────────────────

import SensorCard from './SensorCard.jsx';
import { SENSORS } from '../../utils/constants.js';
import { formatTime } from '../../utils/formatters.js';
import { StatusIcon } from '../ui/Icons.jsx';

const STATUS_ACCENT = {
  RUNNING: 'status--running',
  STOPPED: 'status--stopped',
  FAULT:   'status--fault',
};

export default function SensorCardGrid({ reading }) {
  const hasReading = reading !== null && reading !== undefined;
  const status = hasReading ? reading.status : null;

  return (
    <div className="sensor-grid">
      {SENSORS.map((sensor) => (
        <SensorCard
          key={sensor.key}
          sensor={sensor}
          value={hasReading ? reading[sensor.key] : null}
        />
      ))}

      {/* Status is a text enum (RUNNING / STOPPED / FAULT), so it gets its own card. */}
      <article className={`sensor-card sensor-card--status ${status ? STATUS_ACCENT[status] ?? '' : ''}`}>
        <div className="sensor-card__top">
          <span className="sensor-card__icon"><StatusIcon /></span>
          <span className="sensor-card__label">Status</span>
        </div>
        <div className="sensor-card__value sensor-card__value--text">
          {!hasReading ? '--' : status ?? '--'}
        </div>
        <div className="sensor-card__timestamp">
          Updated {formatTime(hasReading ? reading.timestamp : null)}
        </div>
      </article>
    </div>
  );
}
