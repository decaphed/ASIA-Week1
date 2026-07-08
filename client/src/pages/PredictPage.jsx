// ─────────────────────────────────────────────────────────────────────────
// PredictPage.jsx — "Predictions": the fourth mode of the dashboard
// (current state → Overview, how we got here → Analytics, official record
// → Reports, WHAT'S COMING → here). Today it is an honest placeholder that
// establishes the route, nav entry, and layout shell for the upcoming
// AI/ML failure-prediction model — no fake numbers, every value renders
// as "—" until a real model feeds it. The short-horizon statistical
// outlook (ETS forecast + trend) is shown as the interim signal so the
// page is useful before the model lands.
// ─────────────────────────────────────────────────────────────────────────

import { useForecast, useTrend } from '../hooks/useSensorData.js';
import Card from '../components/ui/Card.jsx';
import { buildSummary } from '../components/dashboard/ExecutiveSummary.jsx';
import { PUMP_NAME } from '../utils/constants.js';

// The stub metrics the ML model will eventually fill in. Kept as data so
// wiring the model later is a matter of replacing `value: null` with real
// output — the layout, labels and tones are already final.
const MODEL_METRICS = [
  { key: 'risk',   label: 'Failure risk — next 7 days',        value: null, hint: 'Probability the pump develops a fault within a week' },
  { key: 'window', label: 'Suggested maintenance window',      value: null, hint: 'Best time to service before wear becomes a failure' },
  { key: 'part',   label: 'Component most likely to fail',     value: null, hint: 'Bearing, seal, impeller or motor — ranked by the model' },
  { key: 'life',   label: 'Estimated remaining useful life',   value: null, hint: 'How long the pump can run at current duty' },
];

export default function PredictPage({ reading }) {
  const { data: forecast } = useForecast();
  const { data: trend } = useTrend();
  const { outlook } = buildSummary(reading, forecast, trend);

  return (
    <div className="dashboard" id="predict">
      <Card
        id="predict-model"
        title="AI Failure Prediction"
        subtitle={`Machine-learning model for ${PUMP_NAME} — in development`}
      >
        <div className="predict-hero">
          <div className="predict-hero__badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V19a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-3.3c-1.8-1.2-3-3.3-3-5.7a7 7 0 0 1 7-7z" />
              <path d="M9.5 21h5" />
              <path d="M12 7v3l2 2" />
            </svg>
          </div>
          <div className="predict-hero__body">
            <p className="predict-hero__blurb">
              This page will predict failures before they happen.
            </p>
            <p className="predict-hero__detail">
              A learning model is being trained on this pump's history — flow, pressure,
              vibration and temperature patterns leading up to past faults. Once live, it
              will estimate failure risk, name the component at risk, and suggest the best
              maintenance window. Until then, the short-term outlook below comes from the
              live statistical forecast.
            </p>
          </div>
          <span className="predict-hero__status">In development</span>
        </div>

        <div className="predict-grid">
          {MODEL_METRICS.map((m) => (
            <div key={m.key} className="predict-tile" title={m.hint}>
              <span className="predict-tile__label">{m.label}</span>
              <span className="predict-tile__value">{m.value ?? '—'}</span>
              <span className="predict-tile__hint">{m.hint}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card
        id="predict-outlook"
        title="Short-Term Outlook"
        subtitle="What the live statistical forecast expects over the next hour"
      >
        <div className="predict-outlook">
          {outlook.length === 0 ? (
            <span className="exec-summary__outlook-item exec-summary__outlook-item--ok">
              ✓ Everything is expected to stay in the normal range
            </span>
          ) : (
            outlook.map((item) => (
              <span key={item.key} className={`exec-summary__outlook-item exec-summary__outlook-item--${item.tone}`}>
                {item.text}
              </span>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
