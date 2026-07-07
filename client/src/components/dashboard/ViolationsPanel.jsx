// ─────────────────────────────────────────────────────────────────────────
// ViolationsPanel.jsx — "Sensor Health / Data Quality" panel: per-metric
// physics-violation counts for the latest processed window, so a sensor
// that's glitching (e.g. rpm consistently out of range) is visible by name
// instead of buried in the single aggregate qualityScore (see
// preprocessing/quality.js::computeQuality's violationsByMetric).
//
// Mirrors StatsPanel.jsx's "grouped stat rows" layout/classes exactly, so
// this reuses .stats-panel/.stat/.stat-divider rather than introducing a
// second grid system.
// ─────────────────────────────────────────────────────────────────────────

import { SENSORS } from '../../utils/constants.js';

// The two cross-variable rules aren't attributable to a single sensor (see
// quality.js), so they get their own fixed rows here, listed after the
// per-metric grid.
const CROSS_VARIABLE_CHECKS = [
  { key: 'dischargePressureVsSuction', label: 'Discharge vs Suction' },
  { key: 'statusMismatch', label: 'Status vs Flow/RPM' },
];

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
  // processed_telemetry row stored before this column existed — treat both
  // the same as SystemHealthPanel treats "no processed data yet".
  const violations = processed?.violationsByMetric;
  const outliers = processed?.outliersByMetric;

  if (!violations) {
    return <div className="dashboard__empty">Collecting…</div>;
  }

  return (
    <div className="stats-panel-wrap">
      <StatDivider label="Per-Sensor Violations" />
      <div className="stats-panel">
        {SENSORS.map((sensor) => (
          <ViolationStat key={sensor.key} label={sensor.shortLabel} count={violations[sensor.key] ?? 0} />
        ))}
      </div>
      {/* outliersByMetric is a separate signal from violationsByMetric on
          purpose (see pipeline.js/quality.js): a physics violation usually
          means a broken/miscalibrated sensor, an outlier is a statistical
          spike that got Hampel-capped — different failure modes, different
          remediation, so they're not merged into one counter. */}
      {outliers && (
        <>
          <StatDivider label="Per-Sensor Outliers" />
          <div className="stats-panel">
            {SENSORS.map((sensor) => (
              <ViolationStat key={sensor.key} label={sensor.shortLabel} count={outliers[sensor.key] ?? 0} />
            ))}
          </div>
        </>
      )}
      <StatDivider label="Cross-Variable Checks" />
      <div className="stats-panel stats-panel--system">
        {CROSS_VARIABLE_CHECKS.map((check) => (
          <ViolationStat key={check.key} label={check.label} count={violations[check.key] ?? 0} />
        ))}
      </div>
      {/* unmatched exists so a validator.js rule that drifts out of sync
          with VIOLATION_CATEGORY (quality.js) fails loudly instead of being
          silently dropped — only rendered when non-zero, same "quiet unless
          something needs attention" convention as SystemHealthPanel's
          DriftRow list. */}
      {violations.unmatched > 0 && (
        <>
          <StatDivider label="Unrecognized" />
          <div className="stats-panel stats-panel--system">
            <ViolationStat label="Unmatched Rule" count={violations.unmatched} />
          </div>
        </>
      )}
    </div>
  );
}
