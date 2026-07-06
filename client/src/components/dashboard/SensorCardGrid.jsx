// ─────────────────────────────────────────────────────────────────────────
// SensorCardGrid.jsx — the 6 KPI cards for Live Machine Telemetry.
// v4: machine status now lives in HealthStrip + ProcessSchematic (V2
//     Overview spec), so the old full-width banner is gone. Each card gets
//     a `history` slice for its sparkline.
// ─────────────────────────────────────────────────────────────────────────

import SensorCard from './SensorCard.jsx';
import { SENSORS } from '../../utils/constants.js';

export default function SensorCardGrid({ reading, series }) {
  const hasReading = reading !== null && reading !== undefined;

  return (
    <div className="sensor-grid">
      {SENSORS.map((sensor) => (
        <SensorCard
          key={sensor.key}
          sensor={sensor}
          value={hasReading ? reading[sensor.key] : null}
          history={series ? series[sensor.key]?.map((p) => p.v) : null}
        />
      ))}
    </div>
  );
}
