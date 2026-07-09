// ─────────────────────────────────────────────────────────────────────────
// ViolationsPanel.jsx — "Data Confidence" panel for the Reports page.
//
// Management-facing on top: one confidence badge (driven by the
// preprocessing pipeline's qualityScore/qualityLabel) plus a plain-English
// sentence naming any sensor that reported unusual values in the latest
// one-minute window. The engineering breakdown (per-sensor physics
// violations vs Hampel-capped statistical spikes vs cross-variable checks —
// different failure modes, different remediation, see quality.js) is still
// here for engineers, but folded behind a "Show technical detail"
// disclosure instead of leading the page. The `unmatched` counter
// (a validator.js rule drifting out of sync with quality.js's category
// table) is a developer diagnostic and is no longer rendered at all — it
// stays visible in the API payload/logs.
// ─────────────────────────────────────────────────────────────────────────

import { SENSORS } from '../../utils/constants.js';

const CROSS_VARIABLE_CHECKS = [
  { key: 'dischargePressureVsSuction', label: 'Outlet vs inlet pressure consistency' },
  { key: 'statusMismatch', label: 'Running status vs flow & speed consistency' },
];

// qualityLabel → management wording.
const CONFIDENCE = {
  GOOD: { tone: 'ok',     word: 'High',   blurb: 'Readings this minute look clean and trustworthy.' },
  FAIR: { tone: 'warn',   word: 'Medium', blurb: 'Some readings this minute needed cleaning up — treat small changes with care.' },
  POOR: { tone: 'danger', word: 'Low',    blurb: 'Many readings this minute were unreliable — numbers on this page may be off.' },
};

function StatDivider({ label }) {
  return (
    <div className="stat-divider" role="presentation">
      <span className="stat-divider__label">{label}</span>
    </div>
  );
}

function ViolationStat({ label, count }) {
  const hasViolations = count > 0;
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={`stat__value${hasViolations ? ' stat__value--warn' : ' stat__value--ok'}`}>
        {count}
      </span>
    </div>
  );
}

export default function ViolationsPanel({ processed }) {
  // Null before the first window closes (~60s after startup) or for any
  // processed_telemetry row stored before these columns existed.
  const violations = processed?.violationsByMetric;
  const outliers = processed?.outliersByMetric;

  if (!violations) {
    return <div className="dashboard__empty">Collecting the first minute of data…</div>;
  }

  const confidence = CONFIDENCE[processed.qualityLabel] ?? CONFIDENCE.FAIR;
  const flaggedSensors = SENSORS.filter(
    (s) => (violations[s.key] ?? 0) > 0 || (outliers?.[s.key] ?? 0) > 0,
  );
  const crossVariableFlags = CROSS_VARIABLE_CHECKS.filter((c) => (violations[c.key] ?? 0) > 0);
  const checksRun = SENSORS.length + CROSS_VARIABLE_CHECKS.length;
  const checksFlagged = flaggedSensors.length + crossVariableFlags.length;
  const allClear = checksFlagged === 0;

  return (
    <div className="stats-panel-wrap">
      <div className={`data-confidence data-confidence--${confidence.tone}`}>
        <div className="data-confidence__badge">
          <span className="data-confidence__word">{confidence.word}</span>
          <span className="data-confidence__caption">data quality</span>
        </div>
        <div className="data-confidence__body">
          <p className="data-confidence__blurb">{confidence.blurb}</p>
          <p className="data-confidence__detail">
            {flaggedSensors.length === 0
              ? 'No sensor reported missing, spiky, or physically-implausible readings in the last minute.'
              : `${flaggedSensors.map((s) => s.label).join(', ')} reported missing, spiky, or physically-implausible readings in the last minute.`}
          </p>
          <p className="data-confidence__note">
            This measures how trustworthy the raw readings are — not whether a sensor is operating outside its normal range. A sensor can be in WARN or ALARM (see Alarms &amp; Events) while still scoring high here.
          </p>
        </div>
        {processed.qualityScore != null && (
          <div className="data-confidence__score" title="Overall data-quality score for the latest one-minute window: 40% completeness + 30% no outliers + 30% within physical limits">
            {Math.round(processed.qualityScore)}<span>/100</span>
            <span className="data-confidence__score-caption">quality score</span>
          </div>
        )}
      </div>

      <div className={`data-confidence__checks-summary data-confidence__checks-summary--${allClear ? 'ok' : 'warn'}`}>
        <span className="data-confidence__checks-icon" aria-hidden="true">{allClear ? '✓' : '!'}</span>
        {allClear
          ? `All ${checksRun} data-quality checks passed for the last one-minute window — every sensor and cross-check came back clean.`
          : `${checksFlagged} of ${checksRun} data-quality checks flagged something in the last one-minute window — see detail below.`}
      </div>

      <details className="data-confidence__details">
        <summary>Show technical detail</summary>

        <StatDivider label="Readings outside physical limits, by sensor" />
        <div className="stats-panel">
          {SENSORS.map((sensor) => (
            <ViolationStat key={sensor.key} label={sensor.label} count={violations[sensor.key] ?? 0} />
          ))}
        </div>

        {outliers && (
          <>
            <StatDivider label="Sudden spikes smoothed out, by sensor" />
            <div className="stats-panel">
              {SENSORS.map((sensor) => (
                <ViolationStat key={sensor.key} label={sensor.label} count={outliers[sensor.key] ?? 0} />
              ))}
            </div>
          </>
        )}

        <StatDivider label="Consistency checks between sensors" />
        <div className="stats-panel stats-panel--system">
          {CROSS_VARIABLE_CHECKS.map((check) => (
            <ViolationStat key={check.key} label={check.label} count={violations[check.key] ?? 0} />
          ))}
        </div>
      </details>
    </div>
  );
}
