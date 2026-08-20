// ─────────────────────────────────────────────────────────────────────────
// faultEvents.js — presentation helpers for /api/pdm/fault-events rows.
//
// A fault_events row carries triggeredRules like ["vibration.max",
// "motorTemp.rateOfChange"] and confidence LOW|MEDIUM|HIGH (see
// pdm/app/rules.py). These helpers turn that into the operator-facing
// strings the design shows.
// ─────────────────────────────────────────────────────────────────────────

import { METRICS, METRIC_BY_KEY, THRESHOLDS, FAULT_TYPE_LABEL, fmt } from './constants.js';

const RULE_PHRASES = {
  max: 'above its alarm band',
  min: 'below its alarm band',
  stdDev: 'unstable readings',
  rateOfChange: 'rising too fast',
};

export function parseRules(row) {
  let rules = row.triggeredRules;
  if (typeof rules === 'string') {
    try { rules = JSON.parse(rules); } catch { rules = []; }
  }
  return Array.isArray(rules) ? rules : [];
}

/** "Discharge Pressure — rising too fast" from a raw "dischargePressure.rateOfChange" rule id. */
export function ruleLabel(rule) {
  const [metricKey, ruleKind] = rule.split('.');
  const metric = METRIC_BY_KEY[metricKey];
  const phrase = RULE_PHRASES[ruleKind] || 'abnormal behavior';
  return `${metric ? metric.label : metricKey} — ${phrase}`;
}

/**
 * §15.6 — a predictionSource='TIER2_MODEL' row has no triggeredRules (Tier 1
 * never fired), so it needs its own "why" derived from the row's raw
 * feature values instead of a rule id. True when there's nothing for
 * eventMetrics()'s rule-based path to read AND this row was at least
 * partly a Tier 2 detection — never fires for a plain Tier 1 row that
 * happens to have an empty rules array (there isn't one today, but the
 * predictionSource check keeps this from silently reinterpreting one).
 */
function isTier2Only(row) {
  return parseRules(row).length === 0 && String(row.predictionSource || '').includes('TIER2_MODEL');
}

/**
 * How far a metric's reading sits from its "normal" center, in band-widths
 * — used only to rank metrics for a Tier-2-only row, which has no
 * triggeredRules to read instead (§15.6). Not a threshold crossing check
 * (statusOf already exists for that): a Tier 2 flag can fire on a
 * multivariate pattern well inside every single-metric band, so ranking by
 * distance-from-center still surfaces the metric(s) that moved the most,
 * even when none of them individually crossed into warn/crit.
 */
function metricDistance(key, value) {
  if (value == null || Number.isNaN(value)) return -Infinity;
  const t = THRESHOLDS[key];
  if (!t) return 0;
  const high = t.warnHigh ?? t.alarmHigh;
  const low = t.warnLow ?? t.alarmLow;
  if (high != null && low != null) {
    const mid = (high + low) / 2;
    const half = (high - low) / 2 || 1;
    return Math.abs(value - mid) / half;
  }
  if (high != null) return value / high;
  if (low != null) return low / Math.max(value, 1e-6);
  return 0;
}

/** Metric keys ranked furthest-from-normal first, from a Tier-2-only row's featureSnapshot. */
function tier2RankedMetrics(row) {
  const stats = row.featureSnapshot?.metricStats || {};
  return METRICS
    .map((m) => ({ key: m.key, distance: metricDistance(m.key, stats[m.key]?.mean ?? stats[m.key]?.last) }))
    .filter((m) => Number.isFinite(m.distance))
    .sort((a, b) => b.distance - a.distance)
    .map((m) => m.key);
}

/** Metric keys involved in an event, in rule order, deduplicated. */
export function eventMetrics(row) {
  if (isTier2Only(row)) return tier2RankedMetrics(row).slice(0, 2);
  const seen = [];
  for (const rule of parseRules(row)) {
    const key = rule.split('.', 1)[0];
    if (METRIC_BY_KEY[key] && !seen.includes(key)) seen.push(key);
  }
  return seen;
}

/** "Vibration · Motor Temp" style label for the Metric(s) column. */
export function metricsLabel(row) {
  const keys = eventMetrics(row);
  return keys.length ? keys.map((k) => METRIC_BY_KEY[k].label).join(' · ') : '—';
}

/** One-line human title, e.g. "Vibration above its alarm band". */
export function eventTitle(row) {
  const rules = parseRules(row);
  if (!rules.length) {
    if (isTier2Only(row)) {
      const [topKey] = eventMetrics(row);
      const metric = topKey && METRIC_BY_KEY[topKey];
      const stats = row.featureSnapshot?.metricStats || {};
      const value = topKey ? (stats[topKey]?.mean ?? stats[topKey]?.last) : null;
      return metric && value != null
        ? `Predicted fault — ${metric.label} ${fmt(value, metric.dec)} ${metric.unit}`
        : 'Predicted fault — model detection';
    }
    return 'Automated detection';
  }
  const [metricKey, ruleKind] = rules[0].split('.');
  const metric = METRIC_BY_KEY[metricKey];
  const phrase = RULE_PHRASES[ruleKind] || 'abnormal behavior';
  const extra = rules.length > 1 ? ` (+${rules.length - 1} more rule${rules.length > 2 ? 's' : ''})` : '';
  return `${metric ? metric.label : metricKey} ${phrase}${extra}`;
}

/** Short model-behavior line for the queue's secondary text. */
export function modelLine(row) {
  const kinds = new Set(parseRules(row).map((r) => r.split('.')[1]));
  if (kinds.has('rateOfChange')) return 'Rising trend detected';
  if (kinds.has('stdDev')) return 'Unstable readings detected';
  if (kinds.has('max') || kinds.has('min')) return 'Threshold excursion detected';
  return 'Rule engine detection';
}

/** CRITICAL for HIGH confidence, WARNING otherwise (design's two levels). */
export function severityOf(row) {
  return String(row.confidence || '').toUpperCase() === 'HIGH' ? 'CRITICAL' : 'WARNING';
}

export function sevPill(sev) {
  return sev === 'CRITICAL'
    ? { bg: '#FBEAE8', color: '#B3282D' }
    : { bg: '#FBF3E0', color: '#8a5f00' };
}

export function confidenceLabel(row) {
  const c = String(row.confidence || '').toUpperCase();
  return c === 'HIGH' ? 'High' : c === 'MEDIUM' ? 'Medium' : c === 'LOW' ? 'Low' : '—';
}

export function eventId(row) {
  return `FE-${row.id}`;
}

/** "Tier 1" / "Tier 2" / "Tier 1 + 2" — §15.6's Source badge text. */
export function sourceLabel(row) {
  const source = row.predictionSource || 'TIER1_RULE';
  if (source === 'BOTH') return 'Tier 1 + 2';
  if (source === 'TIER2_MODEL') return 'Tier 2';
  return 'Tier 1';
}

/** Same pill-styling pattern as sevPill/pillFor — reused, not a new component. */
export function sourcePill(row) {
  const source = row.predictionSource || 'TIER1_RULE';
  if (source === 'TIER2_MODEL') return { bg: '#EDEBFA', color: '#4A3AA8' };
  if (source === 'BOTH') return { bg: '#E4F3EB', color: '#177E4D' };
  return { bg: '#eef1f4', color: '#5f6f7e' };
}

// Recency window options for the fault-event filter bar. `ms: null` means
// "All time" (no lower bound).
export const RECENCY_OPTIONS = [
  { id: 'all', label: 'All time', ms: null },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

// §15.4/D54 — "Escalated" is a dashboard-level grouping of status='CONFIRMED'
// rows, not a new backend state (no new fault_events.status value). Default
// 'ALL' keeps every existing caller's behavior unchanged.
export const DEFAULT_FILTERS = { severity: 'ALL', metric: 'ALL', recency: 'all', escalated: 'ALL' };

/**
 * Shared filter for both the Needs Review queue and the All Detections
 * table — same axes (severity, metric, recency, escalated) apply to either
 * list, so the filtering logic lives in one place rather than being
 * duplicated per tab.
 * @param events fault_events rows.
 * @param filters { severity: 'ALL'|'CRITICAL'|'WARNING', metric: 'ALL'|metricKey,
 *   recency: RECENCY_OPTIONS id, escalated: 'ALL'|'ESCALATED' }
 */
export function filterEvents(events, filters) {
  const recency = RECENCY_OPTIONS.find((r) => r.id === filters.recency) || RECENCY_OPTIONS[0];
  const cutoff = recency.ms != null ? Date.now() - recency.ms : null;
  return events.filter((e) => {
    if (filters.severity !== 'ALL' && severityOf(e) !== filters.severity) return false;
    if (filters.metric !== 'ALL' && !eventMetrics(e).includes(filters.metric)) return false;
    if (cutoff != null && Date.parse(e.detectedAt) < cutoff) return false;
    if (filters.escalated === 'ESCALATED' && e.status !== 'CONFIRMED') return false;
    return true;
  });
}

export function faultTypeLabel(row) {
  return row.faultType ? (FAULT_TYPE_LABEL[row.faultType] || row.faultType) : '—';
}

/** "Today 08:42" / "Aug 10 21:03" style stamp. */
export function shortStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return `Today ${hm}`;
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${md} ${hm}`;
}

/** "Aug 9 · 14:20" style stamp used by the audit trail. */
export function dotStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${md} · ${d.toTimeString().slice(0, 5)}`;
}

/** Coarse age like "18 h" / "3 d" / "42 min". */
export function ageOf(iso, now = Date.now()) {
  if (!iso) return '—';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
