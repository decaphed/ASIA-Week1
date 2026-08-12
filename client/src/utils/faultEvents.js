// ─────────────────────────────────────────────────────────────────────────
// faultEvents.js — presentation helpers for /api/pdm/fault-events rows.
//
// A fault_events row carries triggeredRules like ["vibration.max",
// "motorTemp.rateOfChange"] and confidence LOW|MEDIUM|HIGH (see
// pdm/app/rules.py). These helpers turn that into the operator-facing
// strings the design shows.
// ─────────────────────────────────────────────────────────────────────────

import { METRIC_BY_KEY, FAULT_TYPE_LABEL } from './constants.js';

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

/** Metric keys involved in an event, in rule order, deduplicated. */
export function eventMetrics(row) {
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
  if (!rules.length) return 'Automated detection';
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
