# Pump Schematic & Analytics Enhancement — Design

## Context

A `components/` folder (shadcn/ui + Tailwind + Radix + Recharts TSX mockups, static/fake data)
was dropped into the repo root as visual inspiration for improving the dashboard. The live
app (`client/src`) is React 18 + Vite + vanilla CSS + Chart.js + a custom animated SVG P&ID
schematic, wired to real backend services via `hooks/useSensorData.js`.

Decision: treat the mockups as a **design reference only**. Port good visual ideas natively
into the existing CSS/JSX architecture and real data hooks. No new dependencies (no Tailwind,
Radix, Recharts, TypeScript).

Investigation found the mockup's KPI bar (circular health gauge, status, availability, alarms,
run hours, last comm) is already implemented in `HealthStrip.jsx` — and more rigorously, since
a prior pass deliberately retired a fabricated "Efficiency %" tile in favor of real measured
data. This design does **not** reintroduce fabricated metrics (efficiency donut, vibration
FFT spectrum — sensors report scalar mm/s, not frequency bins) or duplicate the Topbar system
status indicators removed earlier this session.

## Scope

### 1. `ProcessSchematic.jsx` — visual polish

- Status pill (RUNNING / STOPPED / FAULT) overlaid top-left of the schematic stage, driven by
  `reading.status` (data already available, currently unused for this purpose in this
  component). Color via existing alarm-state CSS conventions.
- Subtle dot-grid background pattern behind the SVG stage (visual depth only, no data).
- Tidy instrument tag/bezel spacing using existing `--schem-*` CSS variables — stay within the
  current industrial flat-shadow theme, not the mockup's rounded/glow style.

### 2. `AnalyticsPage.jsx` — per-metric summary strip

- New 6-card strip between `TrendSummary` and the `ChartGroup`s: one card per sensor (icon,
  current value, min/avg/max + a range bar).
- Min/avg/max computed client-side from the same `chartSeries[key]` points already loaded for
  the charts — no new endpoint, no fabricated numbers. Recomputed via `useMemo` keyed on
  `chartSeries`.
- Works in both Live and historical range modes (whatever `chartSeries` currently holds).

### Explicitly out of scope

- Efficiency donut, vibration frequency spectrum (fabricated/unavailable data).
- Sidebar "System Status" widget (duplicates Topbar indicators already removed this session).
- Any Tailwind/Radix/Recharts/TypeScript adoption.

## Architecture / data flow

Both additions are pure presentational components reading props/derived values already
flowing through existing pages — no new hooks, no new API calls, no backend changes.

- `ProcessSchematic`: new local derived value `statusTone` from `reading.status`; new SVG/CSS
  for the pill and background pattern. No prop signature changes.
- `AnalyticsPage`: new `MetricSummaryStrip` component (co-located in `AnalyticsPage.jsx` or a
  new file `components/dashboard/MetricSummaryStrip.jsx`, consistent with existing pattern of
  page-local subcomponents like `ChartGroup`/`TrendSummary` living in the page file) receiving
  `chartSeries` and rendering one card per `SENSORS` entry.

## Testing

No test suite exists for the client; verification is manual via dev server (`npm run dev`) —
visually confirm the status pill reflects live status changes (RUNNING/STOPPED/FAULT), the
summary strip's min/avg/max match the plotted series, and both light/dark themes render
correctly (existing CSS variable system).

## Implementation ownership (parallel agent split)

- **Agent A — Schematic**: `ProcessSchematic.jsx` + related CSS in `index.css`.
- **Agent B — Analytics**: `AnalyticsPage.jsx` (+ new `MetricSummaryStrip.jsx` if split out) +
  related CSS in `index.css`.

CSS lives in one shared file (`index.css`), so each agent should add new rules in a clearly
delimited block (e.g. `/* — Schematic status pill — */`) to minimize merge conflicts, and both
agents should avoid touching unrelated existing rules.
