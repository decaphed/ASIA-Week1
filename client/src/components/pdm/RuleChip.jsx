// ─────────────────────────────────────────────────────────────────────────
// RuleChip.jsx — one parsed triggeredRules entry ("{metric}.{ruleType}"),
// rendered as a small chip: metric short label + a glyph for the rule type,
// tinted with that metric's SENSORS accent color.
// ─────────────────────────────────────────────────────────────────────────

import { SENSORS, RULE_TYPE_META } from '../../utils/constants.js';

export default function RuleChip({ metric, ruleType }) {
  const sensor = SENSORS.find((s) => s.key === metric);
  const meta = RULE_TYPE_META[ruleType] ?? { glyph: '', label: ruleType };
  const label = sensor?.shortLabel ?? metric;
  const title = `${sensor?.label ?? metric} — ${meta.label}`;

  return (
    <span
      className="rule-chip"
      style={sensor ? { borderLeftColor: `var(--${sensor.accent})` } : undefined}
      title={title}
    >
      {label} {meta.glyph}
    </span>
  );
}
