// ─────────────────────────────────────────────────────────────────────────
// geometry.js — SVG path helpers shared by every hand-drawn chart (spark
// cards, analytics chart, forecast fan, gauge, evidence chart).
// ─────────────────────────────────────────────────────────────────────────

/** Map an array of values onto [x0,y0,w,h] as [x,y] point pairs. */
export function pts(arr, x0, y0, w, h, min, max) {
  const n = arr.length;
  const sp = max - min || 1;
  if (n === 1) return [[x0 + w / 2, y0 + h - ((arr[0] - min) / sp) * h]];
  return arr.map((v, i) => [x0 + i * (w / (n - 1)), y0 + h - ((v - min) / sp) * h]);
}

/**
 * Map an array of readings onto [x0,y0,w,h], positioning each point by its
 * actual elapsed time within [tMin,tMax] rather than by array index — so a
 * gap in the underlying data (e.g. an ingestion outage) reads as a gap in
 * the chart instead of being silently stretched to fill the full width,
 * which would misrepresent when the plotted window actually has data.
 */
export function ptsByTime(values, times, x0, y0, w, h, min, max, tMin, tMax) {
  const sp = max - min || 1;
  const tsp = tMax - tMin || 1;
  return values.map((v, i) => [x0 + ((times[i] - tMin) / tsp) * w, y0 + h - ((v - min) / sp) * h]);
}

export function line(points) {
  if (!points.length) return '';
  return 'M' + points.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
}

export function area(points, yBase) {
  if (!points.length) return '';
  return (
    line(points) +
    ' L' + points[points.length - 1][0].toFixed(1) + ',' + yBase +
    ' L' + points[0][0].toFixed(1) + ',' + yBase + ' Z'
  );
}

/** Closed band between an upper and lower series (already mapped to points). */
export function bandPath(upper, lower) {
  if (!upper.length || !lower.length) return '';
  return (
    line(upper) +
    ' L' + [...lower].reverse().map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L') +
    ' Z'
  );
}

export function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

export function arc(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const laf = a1 - a0 > 180 ? 1 : 0;
  return `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} A${r} ${r} 0 ${laf} 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
}

/** [min,max] of an array padded by padFrac of the span. */
export function range(arr, padFrac = 0.18) {
  const clean = arr.filter((v) => v != null && !Number.isNaN(v));
  if (!clean.length) return [0, 1];
  const mn = Math.min(...clean);
  const mx = Math.max(...clean);
  const pad = (mx - mn || 1) * padFrac;
  return [mn - pad, mx + pad];
}
