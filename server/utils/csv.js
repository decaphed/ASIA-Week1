// ─────────────────────────────────────────────────────────────────────────
// csv.js — minimal CSV serializer for tabular export. No external
// dependency: the only export in this app is the fault-event training-data
// dump, whose cells are metric numbers, timestamps and short enum strings —
// not worth pulling in a full CSV library for RFC 4180 edge cases those
// values never hit.
// ─────────────────────────────────────────────────────────────────────────

function escapeCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param rows array of plain objects. @param columns ordered column keys. */
export function toCsv(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCell(row[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}
