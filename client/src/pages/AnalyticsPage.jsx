// ─────────────────────────────────────────────────────────────────────────
// AnalyticsPage.jsx — trend charts grouped by subsystem (hydraulic /
// mechanical) with per-metric forecast and trend classification.
// ─────────────────────────────────────────────────────────────────────────

import { useForecast, useTrend } from '../hooks/useSensorData.js';
import LiveChart from '../components/charts/LiveChart.jsx';
import { SENSORS } from '../utils/constants.js';

const SENSOR_MAP = Object.fromEntries(SENSORS.map((s) => [s.key, s]));

const HYDRAULIC_CHARTS = [
  { key: 'flowRate',          color: '#00b4d8' },
  { key: 'suctionPressure',   color: '#38bdf8' },
  { key: 'dischargePressure', color: '#818cf8' },
];

const MECHANICAL_CHARTS = [
  { key: 'rpm',               color: '#f59e0b' },
  { key: 'vibration',         color: '#ef4444' },
  { key: 'motorTemp',         color: '#f97316' },
];

function ChartGroup({ title, subtitle, defs, series, forecast, trend, id }) {
  return (
    <div className="chart-group" id={id}>
      <div className="chart-group__header">
        <h3 className="chart-group__title">{title}</h3>
        {subtitle && <span className="chart-group__subtitle">{subtitle}</span>}
      </div>
      <div className="chart-group__grid">
        {defs.map(({ key, color }) => {
          const sensor = SENSOR_MAP[key];
          return (
            <div key={key} className="chart-group__item">
              <LiveChart
                label={sensor.label}
                unit={sensor.unit}
                color={color}
                points={series[key]}
                warnHigh={sensor.warnHigh}
                alarmHigh={sensor.alarmHigh}
                forecast={forecast ? forecast[key] : null}
                trend={trend ? trend[key] : null}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AnalyticsPage({ series }) {
  const { data: forecast } = useForecast();
  const { data: trend } = useTrend();

  return (
    <div className="dashboard" id="analytics">
      <ChartGroup
        id="analytics-hydraulic"
        title="Hydraulic Performance"
        subtitle="Flow · Suction · Discharge"
        defs={HYDRAULIC_CHARTS}
        series={series}
        forecast={forecast}
        trend={trend}
      />
      <ChartGroup
        id="analytics-mechanical"
        title="Mechanical Condition"
        subtitle="Speed · Vibration · Temperature"
        defs={MECHANICAL_CHARTS}
        series={series}
        forecast={forecast}
        trend={trend}
      />
    </div>
  );
}
