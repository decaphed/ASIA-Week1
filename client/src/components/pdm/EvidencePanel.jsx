// ─────────────────────────────────────────────────────────────────────────
// EvidencePanel.jsx — left column of the detail view: header strip, "what
// tripped" paired with real numbers, collapsible full-metric table, timing,
// and a buffer-not-yet-chartable placeholder. Pure, read-only — never reads
// `event.confidence` (see FaultQueueTable.jsx's comment for why).
// ─────────────────────────────────────────────────────────────────────────

import RuleChip from './RuleChip.jsx';
import TimingTimeline from './TimingTimeline.jsx';
import { parseTriggeredRules, parseFeatureSnapshot } from '../../utils/faultRules.js';
import { SENSORS, RULE_TYPE_META, ONGOING_WINDOW_SECONDS } from '../../utils/constants.js';
import { formatDayTime, formatNumber } from '../../utils/formatters.js';

function statusPillClass(status) {
  if (status === 'PENDING_REVIEW') return 'pill--pending';
  if (status === 'CONFIRMED') return 'pill--confirmed';
  if (status === 'REJECTED') return 'pill--rejected';
  return 'pill--off';
}

export default function EvidencePanel({ event }) {
  const rules = parseTriggeredRules(event.triggeredRules);
  const snapshot = parseFeatureSnapshot(event.featureSnapshot);
  const isOngoing =
    event.status === 'PENDING_REVIEW' &&
    event.lastSeenWindowEnd &&
    (Date.now() - Date.parse(event.lastSeenWindowEnd)) / 1000 <= ONGOING_WINDOW_SECONDS;

  return (
    <div className="evidence-panel">
      <div className="evidence-panel__header">
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>Event #{event.id}</span>
        <span className={`pill ${statusPillClass(event.status)}`}>{event.status}</span>
        <span className="pill pill--off">{event.eventType}</span>
        <span className="review-footnote" style={{ marginTop: 0 }}>
          detected {formatDayTime(event.detectedAt)}
        </span>
        {isOngoing && <span className="pill pill--ongoing">ONGOING</span>}
      </div>

      <h3 className="evidence-panel__section-title">What tripped</h3>
      {rules.length === 0 ? (
        <p className="review-footnote">No triggered rules recorded on this event.</p>
      ) : (
        <div className="evidence-panel__rules">
          {rules.map((rule) => {
            const [metric, ruleType] = rule.split('.');
            const sensor = SENSORS.find((s) => s.key === metric);
            const meta = RULE_TYPE_META[ruleType] ?? { label: ruleType };
            const precap = snapshot?.precapFeaturesByMetric?.[metric];
            const stats = snapshot?.metricStats?.[metric];
            return (
              <div key={rule} className="evidence-rule-row">
                <div className="evidence-rule-row__head">
                  <RuleChip metric={metric} ruleType={ruleType} />
                  <strong>{sensor?.label ?? metric}</strong>
                  <span className="review-footnote" style={{ marginTop: 0 }}>{meta.label}</span>
                </div>
                {(precap || stats) && (
                  <div className="evidence-rule-row__numbers">
                    {precap && (
                      <>
                        <span>rate of change {formatNumber(precap.rawRateOfChange, sensor?.prec ?? 2)}</span>
                        <span>std dev {formatNumber(precap.rawStdDev, sensor?.prec ?? 2)}</span>
                        <span>max excursion {formatNumber(precap.rawMaxExcursion, sensor?.prec ?? 2)}</span>
                      </>
                    )}
                    {stats && (
                      <>
                        <span>mean {formatNumber(stats.mean, sensor?.prec ?? 2)}</span>
                        <span>min {formatNumber(stats.min, sensor?.prec ?? 2)}</span>
                        <span>max {formatNumber(stats.max, sensor?.prec ?? 2)}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <details className="eng-tools">
        <summary>All metrics at flag time</summary>
        {!snapshot ? (
          <p className="review-footnote">Feature snapshot unreadable.</p>
        ) : (
          <table className="history__table">
            <thead>
              <tr>
                <th>Metric</th><th>Mean</th><th>Median</th><th>Min</th><th>Max</th><th>Std Dev</th><th>Last</th>
              </tr>
            </thead>
            <tbody>
              {SENSORS.map((sensor) => {
                const stats = snapshot.metricStats?.[sensor.key];
                const triggered = rules.some((r) => r.startsWith(`${sensor.key}.`));
                return (
                  <tr key={sensor.key} style={triggered ? { fontWeight: 700 } : undefined}>
                    <td>{sensor.shortLabel}</td>
                    <td>{formatNumber(stats?.mean, sensor.prec)}</td>
                    <td>{formatNumber(stats?.median, sensor.prec)}</td>
                    <td>{formatNumber(stats?.min, sensor.prec)}</td>
                    <td>{formatNumber(stats?.max, sensor.prec)}</td>
                    <td>{formatNumber(stats?.stdDev, sensor.prec)}</td>
                    <td>{formatNumber(stats?.last, sensor.prec)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </details>

      <h3 className="evidence-panel__section-title">Timing</h3>
      <TimingTimeline event={event} />

      <h3 className="evidence-panel__section-title">Raw buffer</h3>
      <p className="review-footnote">
        Raw telemetry for this buffer window ({event.bufferSampleCount ?? 0} samples) isn't
        available to the dashboard yet.
      </p>
    </div>
  );
}
