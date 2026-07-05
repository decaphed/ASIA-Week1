// ─────────────────────────────────────────────────────────────────────────
// SensorCardGrid.jsx — machine status banner + 6 KPI cards.
// v3: Status promoted to a full-width "Machine Status Banner" above the
//     KPI grid. Alarm count derived from live readings.
// ─────────────────────────────────────────────────────────────────────────

import SensorCard from './SensorCard.jsx';
import { SENSORS, PUMP_ID, PUMP_NAME, PUMP_AREA, getAlarmState } from '../../utils/constants.js';
import { formatTime } from '../../utils/formatters.js';
import { StatusIcon, AlarmIcon, WarnIcon, FaultIcon } from '../ui/Icons.jsx';

// Count active alarms and warnings across all live values
function countAlarms(reading) {
  if (!reading) return { alarms: 0, warns: 0 };
  let alarms = 0, warns = 0;
  for (const sensor of SENSORS) {
    const state = getAlarmState(sensor, reading[sensor.key]);
    if (state === 'alarm') alarms++;
    else if (state === 'warn') warns++;
  }
  return { alarms, warns };
}

function MachineBanner({ reading }) {
  const hasReading = reading !== null && reading !== undefined;
  const status     = hasReading ? (reading.status ?? 'UNKNOWN') : null;
  const ts         = hasReading ? reading.timestamp : null;
  const { alarms, warns } = countAlarms(reading);

  const statusKey = status ? status.toLowerCase() : 'unknown';

  // Choose icon based on fault state
  let StatusStateIcon = StatusIcon;
  if (status === 'FAULT') StatusStateIcon = FaultIcon;

  return (
    <div className={`machine-banner machine-banner--${statusKey}`} role="region" aria-label="Machine Status">
      <div className="machine-banner__left">
        <div className={`machine-banner__indicator machine-banner__indicator--${statusKey}`}>
          <StatusStateIcon />
        </div>
        <div className="machine-banner__identity">
          <span className="machine-banner__id">{PUMP_ID}</span>
          <span className="machine-banner__name">{PUMP_NAME}</span>
          <span className="machine-banner__area">{PUMP_AREA}</span>
        </div>
      </div>

      <div className="machine-banner__center">
        <div className={`machine-banner__status-text machine-banner__status-text--${statusKey}`}>
          {status ?? '—'}
        </div>
        <div className="machine-banner__updated">
          {ts ? `Last reading: ${formatTime(ts)}` : 'Awaiting data…'}
        </div>
      </div>

      <div className="machine-banner__alarms">
        {alarms > 0 && (
          <div className="machine-banner__alarm-tag machine-banner__alarm-tag--alarm">
            <AlarmIcon />
            <span>{alarms} ALARM{alarms > 1 ? 'S' : ''}</span>
          </div>
        )}
        {warns > 0 && (
          <div className="machine-banner__alarm-tag machine-banner__alarm-tag--warn">
            <WarnIcon />
            <span>{warns} WARNING{warns > 1 ? 'S' : ''}</span>
          </div>
        )}
        {alarms === 0 && warns === 0 && hasReading && (
          <div className="machine-banner__alarm-tag machine-banner__alarm-tag--ok">
            <span>ALL NORMAL</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SensorCardGrid({ reading }) {
  const hasReading = reading !== null && reading !== undefined;

  return (
    <div className="sensor-section">
      <MachineBanner reading={reading} />
      <div className="sensor-grid">
        {SENSORS.map((sensor) => (
          <SensorCard
            key={sensor.key}
            sensor={sensor}
            value={hasReading ? reading[sensor.key] : null}
          />
        ))}
      </div>
    </div>
  );
}
