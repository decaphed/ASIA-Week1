// ─────────────────────────────────────────────────────────────────────────
// SensorCardGrid.jsx — the 6 KPI cards for Live Machine Telemetry.
// v4: machine status now lives in HealthStrip + ProcessSchematic (V2
//     Overview spec), so the old full-width banner is gone. Each card gets
//     a `history` slice for its sparkline.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { animate, stagger } from 'animejs';
import SensorCard from './SensorCard.jsx';
import { SENSORS } from '../../utils/constants.js';

export default function SensorCardGrid({ reading, series, stale = false }) {
  const hasReading = reading !== null && reading !== undefined;
  const gridRef = useRef(null);

  // One-time staggered entrance for the KPI cards on first mount.
  useEffect(() => {
    const cards = gridRef.current?.querySelectorAll('.sensor-card');
    if (!cards?.length) return;
    animate(cards, {
      opacity: [0, 1],
      translateY: [10, 0],
      delay: stagger(60),
      duration: 420,
      ease: 'outQuad',
    });
  }, []);

  return (
    <div className="sensor-grid" ref={gridRef}>
      {SENSORS.map((sensor) => (
        <SensorCard
          key={sensor.key}
          sensor={sensor}
          value={hasReading ? reading[sensor.key] : null}
          history={series ? series[sensor.key]?.map((p) => p.v) : null}
          stale={stale}
        />
      ))}
    </div>
  );
}
