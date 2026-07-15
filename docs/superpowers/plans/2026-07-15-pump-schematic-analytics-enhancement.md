# Pump Schematic & Analytics Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port two visual improvements from the reference mockups in `components/` into the live dashboard's existing vanilla-CSS/JSX stack, using only real data already available in the app: a live status pill + background texture on the pump schematic, and a real min/avg/max metric summary strip on the Analytics page.

**Architecture:** Two independent, purely presentational changes. No new dependencies, no new API calls, no backend changes. Task 1 touches `ProcessSchematic.jsx` + `index.css`. Task 2 adds a new `MetricSummaryStrip.jsx` component and wires it into `AnalyticsPage.jsx`, plus `index.css`. The two tasks touch different CSS regions (clearly delimited comment blocks) so they can be implemented in parallel without conflict.

**Tech Stack:** React 18 (JSX, no TypeScript), vanilla CSS with custom properties (no Tailwind), no new npm packages.

## Global Constraints

- No new dependencies (confirmed via `client/package.json`: no Tailwind, Radix, Recharts, or TypeScript in this project — do not add any).
- No fabricated metrics: every displayed number must trace to real data already flowing through the app (`reading`, `chartSeries`, etc.) — do not invent efficiency percentages or frequency-spectrum data.
- Follow the existing CSS variable system (`--panel`, `--border`, `--text-*`, `--ok-bright`/`--warn-bright`/`--danger-bright`, `--mono`, `--shadow-sm`, etc.) defined in `client/src/index.css` `:root` — do not hardcode colors.
- There is no test suite for the client. Verification is manual: run `npm run dev` in `client/` and visually confirm behavior in the browser (both `data-theme="dark"` default and `data-theme="light"` via the existing theme toggle).
- No unrelated refactoring — touch only the files/regions named in each task.

---

### Task 1: ProcessSchematic status pill + background texture

**Files:**
- Modify: `client/src/components/dashboard/ProcessSchematic.jsx`
- Modify: `client/src/index.css` (new block after line ~600, right after the existing `.schematic__tag-unit` rule and before the `/* ── Interactive equipment hotspots… */` comment at line ~602)

**Interfaces:**
- Consumes: `ProcessSchematic`'s existing `reading` prop (`r = reading || {}`), specifically `r.status` (one of `'RUNNING' | 'STOPPED' | 'FAULT'`, or `undefined` before the first reading — see `client/src/components/dashboard/ManualReadingForm.jsx:15` for the canonical status list).
- Produces: no new exports, no prop signature changes. Purely additive JSX + CSS inside the existing component.

- [ ] **Step 1: Add the status-tone derivation and status pill JSX**

  Open `client/src/components/dashboard/ProcessSchematic.jsx`. Find this existing block (around line 172-175):

  ```jsx
  const running = r.status === 'RUNNING';
  const flowSpeed = running && r.flowRate > 0
    ? `${Math.min(3, Math.max(0.55, 1.1 * (175 / r.flowRate))).toFixed(2)}s`
    : '1.1s';
  ```

  Immediately after it, add:

  ```jsx
  // Status pill tone: ok while running, warn while deliberately stopped,
  // alarm on an auto-trip fault, neutral before the first reading arrives.
  const statusTone = !r.status ? 'neutral'
    : r.status === 'RUNNING' ? 'ok'
      : r.status === 'FAULT' ? 'alarm'
        : 'warn';
  ```

  Then find the `<div className="schematic__body">` → `<div className="schematic__stage">` block (around line 199-200):

  ```jsx
      <div className="schematic__body">
       <div className="schematic__stage">
  ```

  Immediately after the `<div className="schematic__stage">` line, add the status pill (it must be a sibling of the `<svg>`, absolutely positioned within the stage):

  ```jsx
        {r.status && (
          <div className={`schematic__status schematic__status--${statusTone}`} role="status">
            <span className="schematic__status-dot" aria-hidden="true" />
            {r.status}
          </div>
        )}
  ```

- [ ] **Step 2: Add the dot-grid background pattern to the SVG**

  In the same file, find the `<defs>` block inside the `<svg viewBox="0 0 720 300" className="schematic__svg">` (around line 201-228). It currently starts with:

  ```jsx
        <svg viewBox="0 0 720 300" className="schematic__svg">
          <defs>
            <marker id="schematic-arrow-d" ...
  ```

  Add a new pattern as the *first* child of `<defs>`, before the `schematic-arrow-d` marker:

  ```jsx
          <defs>
            <pattern id="schem-grid" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="var(--border-light)" opacity="0.5" />
            </pattern>
            <marker id="schematic-arrow-d" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
  ```

  Then, immediately after the closing `</defs>` tag, before the `{/* sump tank — 3D cylinder... */}` comment, add the background rect as the first drawn element:

  ```jsx
          </defs>

          <rect x="0" y="0" width="720" height="300" fill="url(#schem-grid)" />

          {/* sump tank — 3D cylinder with wireframe hoops */}
  ```

- [ ] **Step 3: Add the CSS for the status pill and tag shadow polish**

  Open `client/src/index.css`. Find the `.schematic__tag-unit` rule (around line 600):

  ```css
  .schematic__tag-unit { font-size: clamp(6.5px, 1.05cqw, 9px); color: var(--text-dim); font-weight: 400; }
  ```

  Immediately after it, add a new delimited block:

  ```css

  /* ── Schematic status pill (RUNNING/STOPPED/FAULT overlay) ────────────── */
  .schematic__status {
    position: absolute; left: 3%; top: 4%; z-index: 1;
    display: flex; align-items: center; gap: 6px;
    padding: clamp(4px, 0.9cqw, 7px) clamp(8px, 1.6cqw, 12px);
    background: var(--bg-elevated); border: 1px solid var(--border-light);
    box-shadow: var(--shadow-sm);
    font-family: var(--mono); font-weight: 700;
    font-size: clamp(8px, 1.2cqw, 10px); letter-spacing: 1px;
    color: var(--text-muted); text-transform: uppercase;
  }
  .schematic__status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
  .schematic__status--ok      { color: var(--ok-bright); }
  .schematic__status--ok      .schematic__status-dot { background: var(--ok-bright); box-shadow: 0 0 6px var(--ok-glow); animation: pulse-dot 1.6s ease-in-out infinite; }
  .schematic__status--warn    { color: var(--warn-bright); }
  .schematic__status--warn    .schematic__status-dot { background: var(--warn-bright); }
  .schematic__status--alarm   { color: var(--danger-bright); }
  .schematic__status--alarm   .schematic__status-dot { background: var(--danger-bright); }
  .schematic__status--neutral { color: var(--text-faint); }
  .schematic__status--neutral .schematic__status-dot { background: var(--text-faint); }
  ```

  Next, find the `.schematic__tag {` rule (around line 566-573):

  ```css
  .schematic__tag {
    position: absolute; background: var(--bg-elevated); border: 1px solid var(--border-light);
    border-radius: 0;
    padding: clamp(4px, 0.9cqw, 8px) clamp(7px, 1.6cqw, 14px);
    min-width: clamp(74px, 13.5cqw, 118px);
  }
  ```

  Add `box-shadow: var(--shadow-sm);` as a new line inside this rule (after `border-radius: 0;`):

  ```css
  .schematic__tag {
    position: absolute; background: var(--bg-elevated); border: 1px solid var(--border-light);
    border-radius: 0;
    box-shadow: var(--shadow-sm);
    padding: clamp(4px, 0.9cqw, 8px) clamp(7px, 1.6cqw, 14px);
    min-width: clamp(74px, 13.5cqw, 118px);
  }
  ```

- [ ] **Step 4: Verify in the browser**

  Run: `cd client && npm run dev`

  Open the Overview page (P&ID tab). Confirm:
  - A pill reading the current status (`RUNNING`/`STOPPED`/`FAULT`) appears top-left of the schematic stage, green/amber/red per tone, with a pulsing dot while running.
  - A faint dot-grid texture is visible behind the pipes/pump artwork.
  - Hover tags still show their shadow/border correctly; nothing overlaps the new pill.
  - Toggle the theme (existing light/dark toggle) — pill and grid remain legible in both.
  - Use `ManualReadingForm` (if reachable in the UI) or wait for the simulator to cycle status to confirm the pill updates for `STOPPED`/`FAULT` too.

  Expected: no console errors, pill and background render correctly, existing hover/popover behavior unaffected.

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/components/dashboard/ProcessSchematic.jsx client/src/index.css
  git commit -m "$(cat <<'EOF'
  Add live status pill and background texture to pump schematic

  Ports the mockup's status-badge idea using real reading.status data
  (RUNNING/STOPPED/FAULT), plus a subtle dot-grid backdrop for visual
  depth. No new dependencies, no fabricated data.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: Analytics per-metric summary strip

**Files:**
- Create: `client/src/components/dashboard/MetricSummaryStrip.jsx`
- Modify: `client/src/pages/AnalyticsPage.jsx`
- Modify: `client/src/index.css` (new block after the `.health-strip`/`.health-tile` rules region, e.g. right after line ~499's `.health-tile__label` rule block ends — search for the next blank line after it, or simply append the new block directly after the last `.health-tile__*` rule and before whatever rule follows)

**Interfaces:**
- Consumes: `AnalyticsPage`'s existing `chartSeries` value (already computed in `AnalyticsPage.jsx`, shape `{ [sensorKey]: [{ t: string, v: number|null }, ...] }` — see `buildLiveSeriesFromProcessed`/`buildSeriesFromPoints` in that file), and `SENSORS` from `client/src/utils/constants.js` (each entry has `key`, `shortLabel`, `unit`, `accent`, `prec`).
- Produces: default export `MetricSummaryStrip({ series })` — a presentational component with no side effects, no new hooks.

- [ ] **Step 1: Create the MetricSummaryStrip component**

  Create `client/src/components/dashboard/MetricSummaryStrip.jsx`:

  ```jsx
  // ─────────────────────────────────────────────────────────────────────────
  // MetricSummaryStrip.jsx — 6-card min/avg/max strip for AnalyticsPage.
  // Purely derived from the same chartSeries points already plotted in the
  // ChartGroups below — no new endpoint, no fabricated numbers.
  // ─────────────────────────────────────────────────────────────────────────

  import { SENSORS } from '../../utils/constants.js';
  import { formatNumber } from '../../utils/formatters.js';

  /** min/avg/max/latest over one sensor's currently-loaded series points. */
  function summarize(points) {
    const values = (points || [])
      .map((p) => p.v)
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    return { min, max, avg, latest: values[values.length - 1] };
  }

  export default function MetricSummaryStrip({ series }) {
    return (
      <div className="metric-strip" id="analytics-metric-strip">
        {SENSORS.map((sensor) => {
          const stats = summarize(series?.[sensor.key]);
          const range = stats ? stats.max - stats.min : 0;
          const fillPct = stats && range > 0 ? ((stats.avg - stats.min) / range) * 100 : 50;
          return (
            <div key={sensor.key} className={`metric-strip__card metric-strip__card--${sensor.accent}`}>
              <span className="metric-strip__label">{sensor.shortLabel}</span>
              <div className="metric-strip__value">
                {stats ? formatNumber(stats.latest, sensor.prec) : '--'}
                <span className="metric-strip__unit"> {sensor.unit}</span>
              </div>
              <div className="metric-strip__bar">
                <div className="metric-strip__bar-fill" style={{ width: `${fillPct}%` }} />
              </div>
              <div className="metric-strip__minmax">
                <span>MIN {stats ? formatNumber(stats.min, sensor.prec) : '--'}</span>
                <span>AVG {stats ? formatNumber(stats.avg, sensor.prec) : '--'}</span>
                <span>MAX {stats ? formatNumber(stats.max, sensor.prec) : '--'}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  ```

- [ ] **Step 2: Wire it into AnalyticsPage**

  Open `client/src/pages/AnalyticsPage.jsx`. Add the import near the top, next to the other component imports (around line 20-21):

  ```jsx
  import LiveChart from '../components/charts/LiveChart.jsx';
  import MetricSummaryStrip from '../components/dashboard/MetricSummaryStrip.jsx';
  import Spinner from '../components/ui/Spinner.jsx';
  ```

  Then find the render block where `TrendSummary` and the `ChartGroup`s are rendered (around line 220-255):

  ```jsx
    return (
      <div className="dashboard" id="analytics">
        <RangeSelector range={range} onSelect={setRange} hint={hint} />

        {isLive && <TrendSummary trend={trend} />}

        {pending ? (
  ```

  Change it to render the strip right after `TrendSummary`, but only once data is available (same `pending`/`empty` gate the charts already use — reuse `chartSeries`, which is populated in both live and historical modes):

  ```jsx
    return (
      <div className="dashboard" id="analytics">
        <RangeSelector range={range} onSelect={setRange} hint={hint} />

        {isLive && <TrendSummary trend={trend} />}

        {!pending && !empty && <MetricSummaryStrip series={chartSeries} />}

        {pending ? (
  ```

- [ ] **Step 3: Add the CSS for the metric strip**

  Open `client/src/index.css`. Find the end of the health-strip/health-tile rule group — locate this rule (around line 499-500):

  ```css
  .health-tile__label {
    font-family: var(--mono); font-weight: 700; font-size: 9px;
    letter-spacing: 0.9px; color: var(--text-dim); text-transform: uppercase;
  }
  ```

  Search forward from there for the next top-level rule that is clearly a *different* component (e.g. `.health-tile__value` and onward keep going — just add the new block right after the whole `.health-tile*` group ends, before the next unrelated selector such as `.hero-row` or similar). Insert this new delimited block immediately after the last `.health-tile__*` rule in that group:

  ```css

  /* ── Analytics per-metric summary strip (real min/avg/max, no fabricated data) ── */
  .metric-strip {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 12px;
    margin-bottom: var(--content-pad);
  }
  .metric-strip__card {
    background: var(--panel); border: 1px solid var(--border);
    border-left: 3px solid var(--border-light);
    border-radius: var(--radius); padding: 12px 14px; min-width: 0;
    display: flex; flex-direction: column; gap: 8px;
  }
  .metric-strip__card--flow        { border-left-color: var(--flow); }
  .metric-strip__card--rpm         { border-left-color: var(--rpm); }
  .metric-strip__card--vibration   { border-left-color: var(--vibration); }
  .metric-strip__card--pressure-s  { border-left-color: var(--pressure-s); }
  .metric-strip__card--pressure-d  { border-left-color: var(--pressure-d); }
  .metric-strip__card--temp        { border-left-color: var(--temp); }
  .metric-strip__label {
    font-family: var(--mono); font-weight: 700; font-size: 9px;
    letter-spacing: 0.9px; color: var(--text-dim); text-transform: uppercase;
  }
  .metric-strip__value {
    font-family: var(--mono); font-weight: 700; font-size: 18px; color: var(--text);
    line-height: 1.1;
  }
  .metric-strip__unit { font-size: 10px; color: var(--text-dim); font-weight: 400; }
  .metric-strip__bar {
    height: 4px; background: var(--bg-elevated); border: 1px solid var(--border);
    overflow: hidden;
  }
  .metric-strip__bar-fill { height: 100%; background: var(--accent); }
  .metric-strip__minmax {
    display: flex; justify-content: space-between; gap: 4px;
    font-family: var(--mono); font-size: 9px; color: var(--text-faint);
  }
  ```

  Then add the responsive breakpoints. Find the existing `@media (max-width: 1100px)` block (around line 1237-1244) and add `.metric-strip` to it:

  ```css
  @media (max-width: 1100px) {
    :root { --content-pad: 18px; }
    .sensor-grid { grid-template-columns: repeat(2, 1fr); }
    .chart-group__grid { grid-template-columns: 1fr 1fr; }
    .stats-panel { grid-template-columns: repeat(3, 1fr); }
    .manual-entry__grid { grid-template-columns: repeat(2, 1fr); }
    .health-strip { grid-template-columns: repeat(3, 1fr); }
    .metric-strip { grid-template-columns: repeat(3, 1fr); }
  }
  ```

  Find the `@media (max-width: 900px)` block (around line 1245-1255) and add:

  ```css
  @media (max-width: 900px) {
    :root { --sidebar-w: 0px; }
    .sidebar { transform: translateX(-100%); }
    .app__main { margin-left: 0; }
    .chart-group__grid { grid-template-columns: 1fr; }
    .sensor-grid { grid-template-columns: repeat(2, 1fr); }
    .topbar { flex-wrap: wrap; height: auto; padding: 10px 14px; gap: 8px; }
    .clock { display: none; }
    .hero-row { grid-template-columns: 1fr; }
    .health-strip { grid-template-columns: repeat(2, 1fr); }
    .metric-strip { grid-template-columns: repeat(2, 1fr); }
  }
  ```

  Find the `@media (max-width: 500px)` block (around line 1256-1261) and add:

  ```css
  @media (max-width: 500px) {
    :root { --content-pad: 12px; }
    .sensor-grid { grid-template-columns: 1fr; }
    .stats-panel { grid-template-columns: 1fr 1fr; }
    .health-strip { grid-template-columns: 1fr; }
    .metric-strip { grid-template-columns: 1fr; }
  }
  ```

- [ ] **Step 4: Verify in the browser**

  Run: `cd client && npm run dev`

  Open the Analytics page. Confirm:
  - A 6-card strip appears between the trend summary line and the Hydraulic/Mechanical chart groups.
  - Each card's MIN/AVG/MAX values are plausible and consistent with what the chart directly below plots for that metric (spot-check flow rate: the chart's visible min/max should roughly match the card).
  - Switching the range selector (Live / 1h / 8h / 24h / 7d) updates the strip's numbers along with the charts, with no stale/mismatched values and no flash of `--` once each dataset finishes loading.
  - Resize the window / open devtools responsive mode to confirm the strip reflows at the three breakpoints (6 → 3 → 2 → 1 columns).
  - Toggle light/dark theme — colors remain legible.

  Expected: no console errors, numbers match the plotted series, layout responsive.

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/components/dashboard/MetricSummaryStrip.jsx client/src/pages/AnalyticsPage.jsx client/src/index.css
  git commit -m "$(cat <<'EOF'
  Add real min/avg/max metric summary strip to Analytics page

  Ports the mockup's per-metric summary card idea, computed client-side
  from the same series data already driving the charts below — no new
  endpoint, no fabricated numbers (unlike the mockup's efficiency/FFT
  panels, which are intentionally not ported).

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```
