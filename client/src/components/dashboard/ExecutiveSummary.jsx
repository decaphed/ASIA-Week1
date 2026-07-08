// ─────────────────────────────────────────────────────────────────────────
// ExecutiveSummary.jsx — the first thing management sees on the Overview
// page: one plain-English verdict ("Running normally" / "Needs attention
// now") plus an Outlook line that turns the forecast + trend models'
// output into sentences a non-technical reader can act on. No statistics
// jargon anywhere — the model names/intervals stay in the code comments.
// ─────────────────────────────────────────────────────────────────────────

import { SENSORS, getAlarmState } from '../../utils/constants.js';
import { computeHealth } from '../../utils/health.js';

// Plain-language pace for the trend service's magnitude buckets.
const PACE = { slight: 'slowly', moderate: 'steadily', sharp: 'quickly' };

/**
 * Turn one sensor's forecast + trend entries into a plain-English outlook
 * item, or null when there's nothing worth telling management about.
 * Severity: 2 = expected to cross a caution/critical level, 1 = clearly
 * moving but staying in the normal range.
 */
function outlookForSensor(sensor, forecastEntry, trendEntry) {
  const fc = forecastEntry && Number.isFinite(forecastEntry.forecast) ? forecastEntry : null;
  const tr = trendEntry && trendEntry.direction !== 'stable' ? trendEntry : null;

  // Will the predicted next value (or the top of its uncertainty band)
  // cross a caution or critical limit?
  if (fc) {
    const { forecast, upperBound, lowerBound } = fc;
    if (sensor.alarmHigh != null && forecast >= sensor.alarmHigh) {
      return { key: sensor.key, severity: 2, tone: 'danger', text: `${sensor.label} is expected to reach the critical level — act now` };
    }
    if (sensor.warnHigh != null && forecast >= sensor.warnHigh) {
      return { key: sensor.key, severity: 2, tone: 'warn', text: `${sensor.label} is expected to pass the caution level soon` };
    }
    if (sensor.warnLow != null && forecast <= sensor.warnLow) {
      return { key: sensor.key, severity: 2, tone: 'warn', text: `${sensor.label} is expected to fall below the caution level soon` };
    }
    if (sensor.warnHigh != null && upperBound >= sensor.warnHigh && tr && tr.direction === 'up') {
      return { key: sensor.key, severity: 2, tone: 'warn', text: `${sensor.label} is rising and could touch the caution level` };
    }
    if (sensor.warnLow != null && lowerBound <= sensor.warnLow && tr && tr.direction === 'down') {
      return { key: sensor.key, severity: 2, tone: 'warn', text: `${sensor.label} is falling and could touch the caution level` };
    }
  }

  // Moving noticeably, but staying inside the normal range.
  if (tr && (tr.magnitude === 'moderate' || tr.magnitude === 'sharp')) {
    const verb = tr.direction === 'up' ? 'rising' : 'falling';
    return {
      key: sensor.key,
      severity: 1,
      tone: 'info',
      text: `${sensor.label} is ${verb} ${PACE[tr.magnitude]} but staying in the normal range`,
    };
  }

  return null;
}

/** Build the verdict headline + outlook items from live + model data. */
export function buildSummary(reading, forecast, trend) {
  const health = computeHealth(reading);
  const inAlarm = [];
  const inWarn = [];
  if (reading) {
    for (const sensor of SENSORS) {
      const state = getAlarmState(sensor, reading[sensor.key]);
      if (state === 'alarm') inAlarm.push(sensor.label);
      else if (state === 'warn') inWarn.push(sensor.label);
    }
  }

  const outlook = SENSORS
    .map((s) => outlookForSensor(s, forecast?.[s.key], trend?.[s.key]))
    .filter(Boolean)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 3);

  let tone, headline, subline;
  if (!reading) {
    tone = 'neutral';
    headline = 'Connecting to the pump…';
    subline = 'Live readings will appear here in a moment.';
  } else if (inAlarm.length > 0) {
    tone = 'danger';
    headline = 'Needs attention now';
    subline = `${inAlarm.join(' and ')} ${inAlarm.length > 1 ? 'are' : 'is'} past the critical level.`;
  } else if (inWarn.length > 0) {
    tone = 'warn';
    headline = 'Worth watching';
    subline = `${inWarn.join(' and ')} ${inWarn.length > 1 ? 'are' : 'is'} above the caution level — no action needed yet.`;
  } else if (outlook.some((o) => o.severity === 2)) {
    tone = 'warn';
    headline = 'Running normally — one thing to watch';
    subline = 'Everything is within limits right now, but the outlook below flags what may change.';
  } else {
    tone = 'ok';
    headline = 'Running normally';
    subline = 'All readings are within their normal range and expected to stay there.';
  }

  return { tone, headline, subline, outlook, health };
}

export default function ExecutiveSummary({ reading, forecast, trend }) {
  const { tone, headline, subline, outlook } = buildSummary(reading, forecast, trend);

  return (
    <section className={`exec-summary exec-summary--${tone}`} aria-label="Executive summary">
      <div className="exec-summary__glow" aria-hidden="true" />
      <div className="exec-summary__main">
        <span className={`exec-summary__beacon exec-summary__beacon--${tone}`} aria-hidden="true" />
        <div className="exec-summary__text">
          <h2 className="exec-summary__headline">{headline}</h2>
          <p className="exec-summary__subline">{subline}</p>
        </div>
      </div>

      <div className="exec-summary__outlook">
        <span className="exec-summary__outlook-title">Next hour outlook</span>
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
    </section>
  );
}
