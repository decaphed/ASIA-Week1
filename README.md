# Industrial Pump Monitoring Dashboard

A full-stack, real-time SCADA dashboard for industrial pump monitoring built for a
university IoT assignment. **Node-RED** simulates a sensor gateway, **Express +
PostgreSQL/TimescaleDB** ingests, preprocesses and stores pump telemetry, a **Python
(FastAPI) service** runs Tier-1 rule-based fault detection with a human-in-the-loop
review workflow, and a **React + Vite** dashboard displays live metrics, trend
analysis, short-horizon forecasts, and fault review tools — all without manual page
refresh.

This README is written to be read *and* to teach: after the reference sections
there is a complete, beginner-friendly Node-RED tutorial and a step-by-step
walkthrough of how data flows through the whole system, so you can confidently
explain and rebuild every part of this project.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Folder Structure](#folder-structure)
4. [Installation](#installation)
5. [Running the Backend](#running-the-backend)
6. [Running the React Client](#running-the-react-client)
7. [Running Node-RED](#running-node-red)
8. [Why PostgreSQL + TimescaleDB](#why-postgresql--timescaledb)
9. [API Documentation](#api-documentation)
10. [Node-RED Learning Guide](#node-red-learning-guide-beginner-friendly)
11. [End-to-End Data Flow Walkthrough](#end-to-end-data-flow-walkthrough)
12. [Troubleshooting](#troubleshooting)
13. [Future Improvements](#future-improvements)

---

## Project Overview

| Layer | Technology | Responsibility |
|---|---|---|
| Data generation | **Node-RED** | Simulates a sensor gateway every second: random-walks a single "load" scalar with mean reversion (so the 6 metrics move together like real pump telemetry), injects rare RUNNING→FAULT/STOPPED episodes with one of three fault-type signatures (THERMAL, CAVITATION, BEARING), and POSTs each reading to the backend behind a retry-with-backoff queue |
| Backend | **Node.js + Express** | Validates, preprocesses (physics checks, missing-data gap-filling, outlier capping, one-minute aggregation), stores pump readings, computes trends/forecasts/drift, calls the PdM service for fault scoring, serves REST API |
| Fault detection | **Python (FastAPI)**, `pdm/` | Tier-1 rule engine: evaluates each closed one-minute window against per-metric min/max/stdDev/rate-of-change thresholds (`pdm/app/thresholds.yaml`) and returns a flagged/confidence verdict the backend persists for human review |
| Storage | **PostgreSQL 16 + TimescaleDB** (`pg`) | A networked hypertable database holding raw telemetry, preprocessed signals, and fault-event review records as time-series data. See `docs/plan/2026-08-04-timescaledb-migration.md`. |
| Frontend | **React (Vite)** | Four-page dashboard (Overview / Analytics / Predictions / Reports); every chart is hand-built SVG (no charting library); polls the API and renders live metrics, trend charts, forecasts, and the fault-review workflow |

The pieces are decoupled — each only knows about HTTP. You could swap
Node-RED for a real gateway, or React for a mobile app, without touching the
others.

**Dashboard pages:**
- **Overview** — at-a-glance: machine health gauge, active alarms, fault-review queue card, 6 live metric cards with 60-second sparklines, animated P&ID process schematic
- **Analytics** — per-metric time series (1h/8h/24h/7d) with the alarm limit overlaid, availability/run-time/excursion tiles, 24h and 7d rollup tables
- **Predictions** — three tabs: **Forecast** (4-hour projection extrapolated from the backend's damped-trend model), **Fault Detection** (every Tier-1 rule-engine detection and its outcome), **Needs Review** (the human-in-the-loop queue and review drawer)
- **Reports** — historical data export (CSV/Excel/PDF, generated client-side), manual test-reading entry, fault-review audit trail, a composed system event log

---

## Architecture

```
┌──────────────┐   HTTP POST /api/data    ┌──────────────────────────┐
│  Node-RED    │  every 1s (JSON reading) │   Express backend :3000  │
│  (generator) │ ───────────────────────► │  routes→controllers→     │
│  inject→func │                          │  services→preprocessing  │
│  →http req   │                          │  →PostgreSQL/TimescaleDB │
└──────────────┘                          └──────────┬────────┬──────┘
                                                       │        │ POST /score
                                    GET /api/live (1s) │        │ (per closed
                               GET /api/history/series │        │  1-min window)
                                    GET /api/stats/     │        ▼
                                    health/forecast/…   │  ┌──────────────────┐
                                                        │  │ PdM service :8000│
                                                        │  │ (Python/FastAPI) │
                                                        │  │ Tier-1 rule      │
                                                        │  │ engine           │
                                                        │  └──────────────────┘
                                                        ▼
                                          ┌─────────────────────────┐
                                          │  React dashboard :5173  │
                                          │  api/client.js → hooks →│
                                          │  pages / cards / charts │
                                          └─────────────────────────┘
```

**Why this shape?**

- **Node-RED** acts as a stand-in for real sensor hardware. Its HTTP-request
  node mimics exactly how a physical gateway would push telemetry to a server
  — so everything downstream works unmodified the day you plug in real
  sensors.
- **Express is layered**: `routes → controllers → services → models →
  database`. Each layer has one job (URL mapping, HTTP shaping, business
  logic, SQL, storage), so no file mixes concerns and every layer can be
  tested or replaced independently.
- **PostgreSQL + TimescaleDB** stores telemetry as hypertables, giving cheap
  time-bucketed aggregation for the Analytics/summary/trend/forecast
  endpoints without hand-rolled downsampling logic. See
  [Why PostgreSQL + TimescaleDB](#why-postgresql--timescaledb).
- **The PdM service is a separate process** (Python/FastAPI) so the
  fault-detection rule engine can be developed and tested — and eventually
  swapped for a trained model — independently of the Express backend; the
  backend only knows it POSTs a closed window and gets back a verdict.
- **React polls** rather than uses WebSockets/SSE, because polling is the
  simplest mechanism to build, explain, and debug live in a viva. `/api/live`
  is polled every second (matches Node-RED's generation rate); other
  endpoints poll on their own slower cadence (15s–5min) since they don't need
  per-second freshness.

---

## Frontend Design System

**Look and feel:** a light, operator-grade control-room theme — no dark mode,
no gradients, no external icon library (every icon is inline SVG).

- **Palette:** page background `#F1F4F8`; white cards (`#ffffff`) on a
  `#E2E8F0` border with a soft two-layer shadow; primary navy `#1F3A6E` for
  CTAs and emphasis; slate `#33475a` and muted `#8a99a8` for secondary text.
- **Status palette** (shared across cards, chips, and the process schematic):
  normal `#177E4D`, warning `#B27400`, alarm `#B3282D`, and a fourth state,
  **unknown/no-data** `#5f6f7e` — deliberately not a shade of green, so a
  missing reading can never look the same as a healthy one (see
  [Live-data staleness](#live-data-staleness) below).
- **Typography:** `IBM Plex Sans` for body/UI text, `IBM Plex Mono` for every
  numeric/tabular value (readings, timestamps, event IDs), loaded from Google
  Fonts in `client/index.html`.
- **Shape:** 10px border radius on cards, 6-8px on controls; soft shadows,
  no hard offsets.
- **Charts:** no charting library. Every chart — the health gauge, metric
  sparklines, the Analytics time-series, the forecast fan, the P&ID process
  schematic, the review drawer's evidence chart — is hand-built SVG generated
  by `client/src/utils/geometry.js` (`pts`, `line`, `area`, `bandPath`, `arc`,
  `polar`, `range`). `client/package.json`'s only runtime dependencies are
  `react` and `react-dom`.
- **Routing:** no router, no hash routes. `App.jsx` holds the current page in
  React state (`useState('overview')`) and conditionally renders one of the
  four page components.
- **Accessibility:** every interactive control is a real `<button>` (never a
  bare `<div onClick>`); the page has a proper `h1`→`h2`→`h3` heading
  hierarchy; the Predictions tab strip uses `role="tablist"/"tab"/"tabpanel"`;
  the fault-review drawer is a `role="dialog"` with `aria-modal`, a focus
  trap, Escape-to-close, and focus restored to the triggering button on
  close; a global `:focus-visible` ring and a `.sr-only` utility live in
  `client/src/index.css`.

**Pages:**

| Page | Purpose |
|---|---|
| **Overview** | At-a-glance: machine health gauge, active alarms, fault-review queue card, 6 live metric cards with 60-second sparklines, animated P&ID process schematic |
| **Analytics** | Per-metric time series (1h/8h/24h/7d) with the alarm limit overlaid, availability/run-time/excursion tiles, 24h and 7d rollup tables |
| **Predictions** | **Forecast** tab (4-hour projection per metric), **Fault Detection** tab (every Tier-1 rule-engine detection and its outcome), **Needs Review** tab (the pending human-in-the-loop queue and review drawer) |
| **Reports** | Historical data export (CSV/Excel/PDF, generated client-side from the history-series endpoint), manual test-reading entry, fault-review audit trail, a composed system event log |

### Live-data staleness

If `/api/live` stops returning fresh readings (no new timestamp for 3 poll
intervals), the Overview page does **not** keep showing the last-known values
as if they were current. It shows a banner ("No live data from the gateway"),
blanks the health gauge and metric values to `—`, greys out the schematic,
and reports alarm state as **unknown** rather than "no active alarms" — an
outage must never read as an all-clear.

---

## Folder Structure

```
ASIA-Week1/
├── client/                          # React + Vite frontend — light control-room theme, no chart library
│   ├── src/
│   │   ├── assets/
│   │   │   └── logo.png             # ASIA wordmark
│   │   ├── api/
│   │   │   └── client.js            # the ONLY file making HTTP calls; unwraps the {success,data} envelope
│   │   ├── hooks/
│   │   │   ├── usePolling.js        # generic interval poller (fetcher, intervalMs, deps)
│   │   │   ├── useLiveBuffer.js     # 1 Hz /api/live poll into a rolling 60-sample buffer per metric, with staleness detection
│   │   │   └── useClock.js          # wall-clock display
│   │   ├── utils/
│   │   │   ├── constants.js         # METRICS, THRESHOLDS (ported from server/config/thresholds.js), SC status palette, statusOf(), fmt()
│   │   │   ├── geometry.js          # SVG path helpers shared by every hand-drawn chart
│   │   │   └── faultEvents.js       # presentation helpers for fault_events rows (titles, severity, timestamps)
│   │   ├── components/
│   │   │   ├── Card.jsx             # Card, CardLabel, Pill, buttonReset — shared primitives
│   │   │   ├── Sidebar.jsx          # left-nav (Overview/Analytics/Predictions/Reports), connection status, reviewer identity
│   │   │   ├── TopBar.jsx           # page title, LIVE indicator, pending-review CTA
│   │   │   ├── Toast.jsx            # bottom-center confirmation toast
│   │   │   ├── ProcessSchematic.jsx # animated P&ID diagram with live instrument bubbles
│   │   │   └── ReviewDrawer.jsx     # fault-review modal: evidence chart + HITL confirm/reject form
│   │   ├── pages/
│   │   │   ├── OverviewPage.jsx     # health gauge, alarms, queue card, metric cards, schematic
│   │   │   ├── AnalyticsPage.jsx    # per-metric trend chart + rollup tables
│   │   │   ├── PredictionsPage.jsx  # Forecast / Fault Detection / Needs Review tabs
│   │   │   └── ReportsPage.jsx      # export, manual reading, audit trail, event log
│   │   ├── App.jsx                  # application shell: page state, live-data hook, fault-event polling
│   │   ├── main.jsx                 # React entry point
│   │   └── index.css                # design tokens, keyframes, focus/hover states
│   ├── index.html
│   ├── vite.config.js
│   ├── nginx.conf                   # production static-file server + /api reverse proxy
│   └── Dockerfile
├── server/                          # Express + PostgreSQL/TimescaleDB backend (telemetry ingestion & preprocessing)
│   ├── config/                      # thresholds.js (alarm bands per metric)
│   ├── controllers/                 # HTTP routing → JSON response shaping (live/history/series/summary/stats/health/
│   │                                 #   forecast/trend/drift/processed/pdm/whoami controllers)
│   ├── routes/                      # URL → controller mapping (index.js is the whole API surface at a glance)
│   ├── middleware/                  # validation, error handling, latency timing, Authentik identity/group gating
│   ├── database/                    # db.js (pg Pool via DATABASE_URL), schema.sql, node-pg-migrate migrations
│   ├── models/                      # data access layer — ALL SQL here (sensorModel.js, processedModel.js, forecastModel.js, faultEventModel.js)
│   ├── services/                    # business logic: sensorService, summaryService, trendService, forecastService,
│   │                                 #   driftService, processedService, faultEventService, pdmService
│   ├── preprocessing/               # signal processing pipeline
│   │   ├── pipeline.js              # main entry: normalizes, caps outliers, captures pre-cap features
│   │   ├── precapFeatures.js        # raw stddev/rate-of-change/excursion (pre-Hampel-cap)
│   │   └── evaluation/              # fault-prediction evaluation harness (Phases 3+)
│   │       ├── episodes.js          # identify contiguous FAULT episodes, walk-forward split
│   │       └── metrics.js           # precision/recall/Brier score at lead times
│   ├── scripts/                     # utilities: evaluateFaultPrediction.js
│   ├── utils/                       # logger.js, validation.js, pdmReviewValidation.js
│   ├── app.js                       # Express app configuration (CORS, middleware stack)
│   ├── server.js                    # entry point (port 3000)
│   └── .env.example
├── pdm/                              # Python (FastAPI) Tier-1 fault-detection service
│   ├── app/
│   │   ├── main.py                  # FastAPI app (POST /score), thresholds.yaml loader
│   │   ├── rules.py                 # pure threshold-evaluation functions (min/max/stdDev/rateOfChange per metric)
│   │   └── thresholds.yaml          # per-metric rule thresholds + version string
│   └── requirements.txt
├── node-red/                        # sensor gateway simulator
│   └── flow.json                    # inject(1s) → function(generate reading) → http request(POST /api/data, with
│   │                                 #   catch/retry/delay on failure) → debug
├── authentik/                       # Traefik + Authentik forward-auth stack (dashboard SSO, PdM-reviewer group gating)
├── db/                              # Postgres init scripts run on first container start
├── docker-compose.yml               # postgres, pdm, backend, client, node-red, Traefik, Authentik services
├── scripts/                         # repository-level utilities
├── docs/                            # dated plan/spec/runbook documents (migration history, hardening, PdM design, …)
├── FAULT_PREDICTION_PLAN.md         # detailed plan for the ML pipeline (Phases 1-3 done; see status below)
└── README.md
```

---

## Installation

Prerequisites: **Node.js 18+** (developed/tested on Node 24) and npm.

```bash
# 1. Backend
cd server
npm install
cp .env.example .env

# 2. Frontend
cd ../client
npm install
cp .env.example .env

# 3. PdM service (Python) — required for the Fault Review queue to receive
#    any events at all; see "Running the PdM Service" below.
cd ../pdm
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env

# 4. Node-RED (no local install needed — see "Running Node-RED" below)
```

## Running the Backend

The backend requires a running PostgreSQL/TimescaleDB instance reachable at
`DATABASE_URL` (see `server/.env.example`). For local development the
simplest path is to start just the database service from the repo root:

```bash
docker compose up postgres
```

Then apply migrations and start the server:

```bash
cd server
npm run migrate:up   # node-pg-migrate — creates raw_telemetry, processed_telemetry, fault_events, etc.
npm run dev           # nodemon, auto-restarts on file changes
# or: npm start        for a plain node run
```

You should see:

```
[INFO ] Backend listening on http://localhost:3000
```

Verify it's alive:

```bash
curl http://localhost:3000/api/health
```

## Running the React Client

```bash
cd client
npm run dev
```

Open **http://localhost:5173**. Until Node-RED starts sending data — or if
the feed stops — the dashboard shows a "No live data from the gateway"
banner and blanks the metric values to `—` rather than pretending stale
numbers are current. This is expected, graceful behaviour, not a bug.

To build a production bundle: `npm run build` (outputs to `client/dist/`).

## Running the PdM Service

The **Fault Review** page (`#/review`) is driven entirely by `fault_events` rows,
and those rows only get created when the backend's `pdmService.js` successfully
POSTs each closed one-minute window to the Python Tier 1 rule-engine service in
`pdm/` and gets back a verdict. **If this service isn't running, the review
queue stays empty forever** — the backend fails the `/score` call silently
(logged, not fatal — see `server/services/pdmService.js`) and neither
`FLAGGED` nor `NEGATIVE_SAMPLE` rows ever get written.

```bash
cd pdm
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
uvicorn app.main:app --reload --port 8000
```

Verify it's alive:

```bash
curl http://localhost:8000/docs
```

`server/.env`'s `PDM_SERVICE_URL` (default `http://localhost:8000`) must point
here. Thresholds live in `pdm/app/thresholds.yaml`, not in an env var.

## Running Node-RED

You don't need a permanent Node-RED install for this project — `npx` fetches
and runs it on demand:

```bash
npx node-red
```

Node-RED will print a URL, typically **http://localhost:1880**. Open it, then
follow the [Node-RED Learning Guide](#node-red-learning-guide-beginner-friendly)
below to import `node-red/flow.json` and start the simulator.

> If you prefer a permanent install: `npm install -g node-red`, then just run
> `node-red`.

> **Running Node-RED natively instead of via Docker Compose?** The committed
> `flow.json` targets `http://backend:3000/api/data` — the Compose service
> name — because it's designed to run as the `node-red` service inside
> `docker-compose.yml`, on the same network as `backend`. If you run Node-RED
> **natively** (`npx node-red`, no container), open the "POST /api/data" node
> and change the URL to `http://localhost:3000/api/data`, since `backend` as
> a DNS name only resolves inside the Compose network.

---

## Why PostgreSQL + TimescaleDB

The project moved from an embedded SQLite database to a networked PostgreSQL
16 instance with the TimescaleDB extension — see
`docs/plan/2026-08-04-timescaledb-migration.md` for the full migration
rationale and history. The concrete reasons the current stack uses it:

- **Hypertables give cheap time-bucketed aggregation.** The Analytics page's
  per-range series, the management summary, and the trend/drift/forecast
  services all need "average this metric over N-second buckets" —
  TimescaleDB does this natively (`time_bucket()`), instead of hand-rolled
  downsampling logic against a plain table.
- **A shared, networked database matches the multi-service architecture.**
  The stack now has multiple processes touching telemetry-adjacent data (the
  Express backend, the PdM fault-detection service via the `fault_events`
  table, and human reviewers via the frontend). A single embedded SQLite file
  can't be shared safely across processes/containers the way a networked
  Postgres instance can.
- **JSONB columns hold structured pipeline metadata** — per-metric feature
  snapshots, triggered-rule lists, physics-violation details — with real
  query support, rather than serializing everything to `TEXT`.
- **`pg`** (`node-postgres`) is the driver; the connection is a pooled
  `DATABASE_URL` (see `server/database/db.js`). Schema changes are applied
  with `node-pg-migrate` (`npm run migrate:up` / `migrate:down` in
  `server/`).

The core tables are `raw_telemetry` (one row per ingested reading — the six
pump metrics, `status`, `faultType`, `provenance`, physics-validation flags),
`processed_telemetry` (the one-minute aggregates the preprocessing pipeline
produces — mean/median/min/max/stdDev per metric, dominant status, pre-cap
features), and `fault_events` (the PdM rule engine's flagged detections and
their human-in-the-loop review outcome). See `server/database/schema.sql` and
`server/models/` for the authoritative column lists — this README summarizes
rather than duplicates them, so it can't drift out of sync with the real
schema the way the old SQLite-era description did.

All SQL lives in the `server/models/` layer. Nowhere else in the backend
writes a SQL string — controllers and services only call named functions
(`insertReading()`, `getHistory()`, `getFaultEventById()`, …). This is the
standard data-access-layer pattern: one place to audit, optimize, or extend
storage.

---

## API Documentation

Base URL: `http://localhost:3000/api`. Every endpoint responds with a
`{ "success": true, "data": … }` envelope (or `{ "success": false, "error", "details"? }`
on failure).

### `POST /api/data`

Ingests one raw reading (this is what Node-RED calls every second). Runs the
full preprocessing pipeline on every request.

**Request body:**
```json
{
  "flowRate": 212.4,
  "rpm": 2950,
  "vibration": 3.12,
  "suctionPressure": 1.85,
  "dischargePressure": 8.6,
  "motorTemp": 68.2,
  "status": "RUNNING",
  "faultType": null,
  "timestamp": "2026-08-11T14:05:00.000Z"
}
```
`status` is one of `RUNNING | STOPPED | FAULT` (defaults to `RUNNING`);
`faultType` is one of `THERMAL | CAVITATION | BEARING` (only meaningful when
`status` is `FAULT`); `timestamp` is optional — the server stamps the current
time if omitted.

**Success (201):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "flowRate": 212.4,
    "rpm": 2950,
    "vibration": 3.12,
    "suctionPressure": 1.85,
    "dischargePressure": 8.6,
    "motorTemp": 68.2,
    "status": "RUNNING",
    "faultType": null,
    "timestamp": "2026-08-11T14:05:00.000Z",
    "provenance": "MEASURED",
    "physicsValid": true
  }
}
```

**Validation failure (400):**
```json
{
  "success": false,
  "error": "Invalid sensor data",
  "details": ["flowRate must be a number", "rpm is required"]
}
```

### `GET /api/live`

Returns the single most recent reading, or
`{ "success": true, "data": null, "message": "No readings yet" }` if none exist.

### `GET /api/history`

A page of historical readings, newest first by default. **Query params:**
`page` (default 1), `limit` (default 100, max 1000), `sort` (`asc`|`desc`,
default `desc`).

### `GET /api/history/series?range=1h|8h|24h|7d`

A downsampled per-metric time series for the Analytics chart:
```json
{ "success": true, "data": { "range": "24h", "bucketSeconds": 900,
  "points": [ { "t": "2026-08-11T14:00:00.000Z", "flowRate": 210.4, "rpm": 2950,
                "vibration": 3.12, "suctionPressure": 1.85,
                "dischargePressure": 8.6, "motorTemp": 68.2 } ] } }
```

### `GET /api/summary?range=24h|7d`

A management roll-up: availability, real run-time, per-sensor min/max/avg,
and distinct warn/alarm excursion counts.

### `GET /api/stats`

Aggregate statistics across all stored readings — `totalRecords`,
`latestTimestamp`, per-metric averages, plus the last request's
`apiLatencyMs`.

### `GET /api/health`

Backend + database status, used to drive the dashboard's connection
indicators.

```json
{
  "success": true,
  "status": "ok",
  "database": "connected",
  "uptimeSeconds": 340,
  "lastReadingAt": "2026-08-11T14:05:58.000Z",
  "serverTime": "2026-08-11T14:05:59.100Z"
}
```

The React app infers the **Node-RED** indicator itself: `useLiveBuffer`
treats a reading as stale once no new timestamp has arrived for 3 poll
intervals — no dedicated "Node-RED heartbeat" endpoint is needed.

### `GET /api/forecast`

The current damped-trend (Holt's Linear / ETS) forecast per metric:
`{ <metric>: { level, trend, forecast, lowerBound, upperBound } }` — one step
ahead; the Predictions page extrapolates this across a 4-hour horizon
client-side.

### `GET /api/trend`

Short-horizon (Mann-Kendall/Theil-Sen) rate-of-change classification per
metric: direction, magnitude label, slope, significance.

### `GET /api/drift`

A two-sample z-test comparing a recent window against a longer reference
window per metric — flags a structural shift to a new operating level.

### `GET /api/whoami`

Echoes the Authentik identity attached to the request (username, email,
groups), or all-`null` fields for direct/dev access with no forward-auth
identity.

### `GET /api/pdm/fault-events` · `GET /api/pdm/fault-events/:id` · `GET /api/pdm/fault-events/stats`

Lists/reads fault-event rows produced by the PdM Tier-1 rule engine — `id`,
`status` (`PENDING_REVIEW`/`CONFIRMED`/`REJECTED`/`N/A`), `confidence`
(`LOW`/`MEDIUM`/`HIGH`), `triggeredRules`, `detectedAt`, and review fields
once reviewed. `/stats` returns a confidence×outcome agreement breakdown.

### `PATCH /api/pdm/fault-events/:id`

Human-in-the-loop review: records `status` (`CONFIRMED`/`REJECTED`),
`faultType`, `rootCause`, `resolution`, `notes`, and an optional `faultEnd`.
Gated by `requireGroup('pdm-reviewers')` when the request carries an
Authentik identity. See `server/utils/pdmReviewValidation.js` for the exact
per-status required fields.

---

## Fault Detection & Prediction Pipeline

**Status:** Tier-1 rule-based fault detection with human-in-the-loop review
is live in production (the `pdm/` service, the `fault_events` table, and the
Predictions page's Fault Detection / Needs Review tabs). Short-horizon
statistical forecasting (damped-trend ETS, `GET /api/forecast`) is also live.
A trained ML classifier — the original scope of "Phases 4-6" below — remains
future work, gated on fault-episode volume. See `FAULT_PREDICTION_PLAN.md`
for the full historical phase plan.

### History (Phases 1-3, complete)

**Phase 1 — Fault-type diversity** (commit `048b7fe`)
- Node-RED now injects one of three realistic failure signatures (THERMAL, CAVITATION,
  BEARING) when a fault occurs, each biasing a different subset of the 6 metrics
  (e.g., THERMAL spikes motor temp; CAVITATION collapses pressure/flow).
- Backend validates and persists the `faultType` field on every reading.
- Dashboard displays "Auto-trip - [Type]" instead of generic "Auto-trip".

**Phase 2 — Pre-cap feature capture** (commit `a10dd6e`)
- New preprocessing module (`server/preprocessing/precapFeatures.js`) captures raw
  statistical anomalies *before* outlier-smoothing: standard deviation, rate-of-change,
  max excursion per metric.
- Stored as `precapFeaturesByMetric` JSON column on `processed_telemetry`.
- These features survive the signal-suppression problem (outlier caps smooth away the
  very spikes a predictor needs to learn from).

**Phase 3 — Evaluation harness** (commit `8777c4c`)
- Implemented a mechanical gate: `checkEvaluationGate()` requires ≥100 fault episodes
  before any model can be trained or evaluated.
- Walk-forward split (`walkForwardSplit()`) ensures chronological ordering and
  episode-boundary discipline — no leakage via autocorrelation.
- Baseline metrics (`precisionRecallAtLeadTime`, `brierScore`) so a future classifier
  has concrete targets to beat.
- Script: `node server/scripts/evaluateFaultPrediction.js` — prints current episode
  count and blocks model work until the gate clears.

### What replaced the original Phase 4-6 plan

The original plan called for populating a `PredictPage` UI and a dedicated
`/api/predict` endpoint once ~100-200 fault episodes had accumulated. That
scope was superseded by two things that shipped instead of waiting on a
trained model:

- **Tier-1 rule engine + HITL review** (`pdm/`, `fault_events`,
  `PATCH /api/pdm/fault-events/:id`) — a working, auditable detection loop
  that flags threshold/rate-of-change excursions and routes them to an
  engineer for confirm/reject, rather than waiting on model training.
- **ETS statistical forecasting** (`GET /api/forecast`) — a working
  short-horizon outlook per metric, extrapolated to 4 hours on the
  Predictions page's Forecast tab.

A trained classifier (SVM/RF/temporal CNN, per the original phase plan) is
still open work; see `FAULT_PREDICTION_PLAN.md` and
`server/scripts/evaluateFaultPrediction.js` for the evaluation-gate mechanics
that would still apply — `checkEvaluationGate()` still requires ≥100 fault
episodes before any model can be trained or evaluated.

---

## Node-RED Learning Guide (beginner-friendly)

This section assumes you have **never used Node-RED before**. By the end you
will be able to explain every node in `node-red/flow.json` and rebuild it from
scratch.

### What is Node-RED, in one sentence?

Node-RED is a visual, flow-based programming tool: you drag small blocks
("nodes") onto a canvas, wire their outputs to other nodes' inputs, and Node-RED
runs the resulting pipeline continuously. Each node does one small job (fire a
timer, run some code, make an HTTP request); the wires between them are how
data ("messages", always shaped as `msg` with a `msg.payload`) moves from one
step to the next.

We use it here to **simulate a physical sensor gateway** — in a real
deployment, a device would read a physical sensor and POST the value to our
backend the exact same way this flow does.

### Step 1 — Start Node-RED

```bash
npx node-red
```

Wait for:
```
[info] Server now running at http://127.0.0.1:1880/
```

Open that URL in your browser. You'll see a blank canvas (or an empty "Flow 1"
tab) and a palette of nodes down the left side.

### Step 2 — Import the provided flow

1. Click the **hamburger menu** (☰) in the top-right corner.
2. Choose **Import**.
3. Click **select a file to import** and choose `node-red/flow.json` from this
   repo (or paste its contents into the text box).
4. Click **Import**. A new tab called **"IoT Sensor Simulator"** appears with
   four connected nodes.
5. Click the red **Deploy** button (top-right) to activate the flow.

### Step 3 — The nodes, one by one

#### 1. `inject` — "every 1s"

| | |
|---|---|
| **Category** | Common → input nodes |
| **Purpose** | A timer. It fires (injects a message) on a schedule. |
| **Why it's needed** | Nothing else in Node-RED runs on its own — every flow needs a trigger. This is ours. |
| **Configuration** | `Repeat`: interval, every `1` second. `Payload`: timestamp (unused — the function node overwrites it). |
| **Expected output** | Once deployed, this node's message rate is 1/second — you'll see its status show a small timestamp under the node every time it fires. |

**Common mistake:** forgetting to set "Repeat" to *interval* (leaving it as
"none" means it only fires once, manually, when you click the node).

#### 2. `function` — "generate reading"

| | |
|---|---|
| **Category** | Function |
| **Purpose** | Runs arbitrary JavaScript. Here it builds one simulated pump reading. |
| **Why it's needed** | This is where the actual simulation logic lives — not independent random draws, but a persistent virtual pump model, so the 6 metrics move together the way real telemetry does. |
| **Configuration** | The full code lives in `flow.json`; the walkthrough below covers its structure rather than reproducing all ~80 lines inline. |

**How it works, conceptually** (full code in `node-red/flow.json`'s
`gen_reading` node):

1. **Persistent state across ticks.** Unlike `msg`, Node-RED's `context`
   object survives between function calls, so the node keeps a `state`
   object (`load`, `regime`, `faultType`, …) instead of drawing fresh random
   numbers each second.
2. **`load`** (0–1, "how hard the pump is working") random-walks with mean
   reversion toward a regime-specific target — this is what gives every
   metric real momentum instead of jumping between unrelated values tick to
   tick.
3. **Regime transitions.** Mostly `RUNNING`; small per-tick probabilities
   flip it into a `FAULT` episode (15-40 ticks, picking one of `THERMAL` /
   `CAVITATION` / `BEARING`) or a `STOPPED` episode (20-60 ticks), then back
   to `RUNNING`.
4. **Per-fault-type metric profiles.** Each fault type biases a different
   subset of the 6 metrics — e.g. `THERMAL` spikes `motorTemp` and sags
   `rpm`; `CAVITATION` collapses `suctionPressure` and `flowRate`; `BEARING`
   spikes `vibration` and destabilizes `rpm` — scaled by a severity ramp that
   climbs across the episode.
5. **Output shape:**
   ```json
   { "flowRate": 212.4, "rpm": 2950, "vibration": 3.12, "suctionPressure": 1.85,
     "dischargePressure": 8.6, "motorTemp": 68.2, "status": "RUNNING",
     "faultType": null, "timestamp": "2026-08-11T14:00:00.000Z" }
   ```
   `status` is `RUNNING` | `STOPPED` | `FAULT`; `faultType` is only set while
   `status === "FAULT"`.
6. **`msg.headers = { "Content-Type": "application/json" }`** — read by the
   next node (`http request`) so Express's `express.json()` middleware parses
   the body correctly.

#### 3. `http request` — "POST /api/data"

| | |
|---|---|
| **Category** | Network |
| **Purpose** | Makes an outbound HTTP call — the actual "send data to the backend" step. |
| **Why it's needed** | This is the one line in the whole flow that connects Node-RED to Express. |
| **Configuration** | Method: `POST`. URL: `http://localhost:3000/api/data`. Return: "a parsed JSON object". |

**What problem does it solve?** Without this node, we'd have generated data
that goes nowhere. This node is Node-RED's equivalent of `fetch()`/`axios` in
JavaScript, or `requests.post()` in Python.

**Expected output:** the backend responds with `201 Created` and the stored
reading (see [`POST /api/data`](#post-apidata) above); that response becomes
the new `msg.payload` flowing into the next node.

#### 4. `debug` — "backend response"

| | |
|---|---|
| **Category** | Common → output nodes |
| **Purpose** | Prints `msg.payload` to Node-RED's **Debug** sidebar (the bug icon on the right). |
| **Why it's needed** | This is your window into whether things are actually working — without it you'd be flying blind. |
| **Configuration** | "Output": `msg.payload`. "To": Debug tab. |

**Expected output**, once per second, in the Debug sidebar:
```json
{
  "success": true,
  "data": {
    "id": 87,
    "flowRate": 212.4,
    "rpm": 2950,
    "vibration": 3.12,
    "suctionPressure": 1.85,
    "dischargePressure": 8.6,
    "motorTemp": 68.2,
    "status": "RUNNING",
    "faultType": null,
    "timestamp": "2026-08-11T14:00:00.000Z",
    "provenance": "MEASURED",
    "physicsValid": true
  }
}
```
Seeing `"success": true` and an incrementing `id` confirms the whole pipeline
— generate → send → store — is working end to end.

#### 5. Resilience: `catch` → `retry with backoff` → `delay`

Three additional nodes handle a failed `POST /api/data` call rather than
silently dropping that tick's reading:

| | |
|---|---|
| **`catch`** | Scoped only to the `http request` node (`senderr: true` on that node is what makes failures reach the catch, rather than crashing the flow). Receives the *original* message that entered the failing node — `msg.payload` is still the reading object, not a response body. |
| **`retry with backoff (max 3)`** | Increments `msg.retryCount`; gives up (and logs a warning) after 3 attempts, otherwise passes the message on. |
| **`delay`** | Waits ~1s (with jitter) before feeding the message back into the same `http request` node. |

This absorbs transient failures — a backend restart, a momentary network
blip — that a fire-and-forget POST would otherwise lose outright. A sustained
outage longer than ~3 retry cycles still drops readings for that window,
which is why the dashboard treats a stale live feed as a real condition to
surface (see [Live-data staleness](#live-data-staleness)), not something to
paper over.

### Step 4 — Deploy and verify

1. Make sure the **Express backend is already running** on port 3000 (see
   [Running the Backend](#running-the-backend)) — otherwise the `http
   request` node will show a red "error" status.
2. Click **Deploy**.
3. Open the **Debug** sidebar (bug icon, top-right).
4. You should see a new JSON message appear roughly once per second.
5. Cross-check with the API directly: `curl http://localhost:3000/api/stats`
   — `totalRecords` should be climbing by ~1 per second.
6. Open the React dashboard (`http://localhost:5173`) — the cards should
   start animating and the Node-RED status indicator should turn green.

### Common Node-RED mistakes (and fixes)

| Symptom | Cause | Fix |
|---|---|---|
| Inject node fires once, then never again | "Repeat" left as "none" | Edit the inject node → set Repeat → "interval" → every 1 second |
| `http request` node shows a red triangle / "error" | Backend isn't running, or wrong port/URL | Start the backend first; confirm the URL is exactly `http://localhost:3000/api/data` |
| Debug panel shows nothing | Debug node is disabled, or wired to the wrong output | Click the small button on the debug node to toggle it active (green) |
| Backend returns 400 "Invalid sensor data" | A required field is missing or non-numeric | Check `server/utils/validation.js`'s `NUMERIC_FIELDS`/`VALID_STATUSES`/`VALID_FAULT_TYPES` — every field the flow's `function` node emits must be present and correctly typed |
| CORS error mentioned in browser console | You're calling the API from a page whose origin isn't allowed | Not applicable to Node-RED itself (server-to-server has no CORS), but if you build a browser-based simulator instead, make sure `CLIENT_ORIGIN` in `server/.env` matches |
| Node-RED changes don't seem to apply | Forgot to click **Deploy** after editing | Always click the red Deploy button after any change |

---

## End-to-End Data Flow Walkthrough

1. **Node-RED generates a reading.** The `inject` node fires once per second,
   triggering the `function` node to advance the virtual pump model one tick
   and build a reading object.
2. **Node-RED sends an HTTP POST request.** The `http request` node POSTs
   that JSON object to `/api/data` (retried with backoff on failure — see
   the resilience nodes above).
3. **Express receives the request.** `app.js` routes it through CORS,
   `express.json()` (parses the body), the latency timer, then to
   `routes/index.js`, which maps `POST /data` to the validation middleware and
   `dataController.createReading`.
4. **The backend validates the data.** `middleware/validateReading.js` calls
   `utils/validation.js`, rejecting the request with `400` if any field is
   missing or the wrong type, or `status`/`faultType` isn't one of the
   allowed enum values.
5. **The preprocessing pipeline runs.** `server/preprocessing/pipeline.js`
   physics-checks the reading, gap-fills missing metrics, Hampel-caps
   outliers, and rolls the reading into the current one-minute
   `processed_telemetry` aggregate.
6. **PostgreSQL/TimescaleDB stores both layers.** `services/sensorService.js`
   normalizes the payload and calls `models/sensorModel.js`'s
   `insertReading()`; the processed one-minute window is written by
   `processedService.js` once it closes.
7. **The PdM service scores each closed window.** `services/pdmService.js`
   POSTs the closed window to the Python Tier-1 rule engine (`pdm/`); a
   flagged verdict creates or extends a `fault_events` row via
   `faultEventService.js`.
8. **React requests live and historical data.** Independently of ingestion,
   `App.jsx` and each page call `api/client.js` through `usePolling`/
   `useLiveBuffer`, hitting the corresponding `GET` endpoints on their own
   cadence (`/api/live` at 1 Hz; others every 15s-5min).
9. **The backend returns JSON responses.** Each controller calls the service
   layer, which calls the model layer, and shapes a consistent
   `{ success, data }` envelope.
10. **React updates the dashboard.** `OverviewPage`'s live buffer drives the
    health gauge, alarm panel, and per-metric spark cards; `AnalyticsPage`
    and `PredictionsPage` redraw their hand-built SVG charts from their own
    polled data; a stale/missing feed flips the whole page into the
    no-live-data state described in
    [Live-data staleness](#live-data-staleness) rather than freezing on old
    numbers.

---

## Troubleshooting

| Problem | What you'll see | Fix |
|---|---|---|
| Backend offline | Dashboard shows the "No live data from the gateway" banner; Sidebar's connection dot turns red | Start the server: `cd server && npm run dev` |
| Database unavailable | `/api/health` returns `503` with `"database": "unavailable"` | Confirm PostgreSQL/TimescaleDB is running and `DATABASE_URL` in `server/.env` is correct (`docker compose up postgres` for local dev); check migrations were applied (`npm run migrate:up`) |
| Fault-review queue stays empty | Predictions → Needs Review shows "Queue clear" even though thresholds are clearly being exceeded | The PdM service (`pdm/`) isn't running or isn't reachable — the backend fails the `/score` call silently (logged, not fatal). Start it per [Running the PdM Service](#running-the-pdm-service) and confirm `PDM_SERVICE_URL` points at it |
| Node-RED disconnected | The live feed goes stale after a few seconds even though the backend is up | Deploy the flow in Node-RED again; confirm the `inject` node's Repeat is set to "interval" |
| `ECONNREFUSED` from the `http request` node, backend confirmed running | Running Node-RED **natively** while `flow.json` still targets the Compose DNS name `backend`, or vice versa | See the Docker/native URL note in [Running Node-RED](#running-node-red) — the URL must match how Node-RED is actually deployed |
| Invalid sensor data (400) | Node-RED's `http request` node shows an error status | Check `server/utils/validation.js`'s `NUMERIC_FIELDS`/`VALID_STATUSES`/`VALID_FAULT_TYPES` against what the `function` node emits |
| Empty history / "No readings yet" | Normal on first run | Start Node-RED so readings begin flowing |
| CORS error in browser console | Dashboard requests fail, console shows a CORS message | Make sure `client/.env`'s `VITE_API_URL` origin matches `server/.env`'s `CLIENT_ORIGIN` (default `http://localhost:5173`) |
| Network error / timeout | Dashboard shows the no-live-data banner, `usePolling` calls reject | Confirm the backend is reachable at the configured `VITE_API_URL` and no firewall is blocking port 3000 |

---

## Future Work

**Already done, previously listed here as future work:**
- ~~Docker Compose to spin up the stack~~ — `docker-compose.yml` now runs
  postgres, pdm, backend, client, node-red, Traefik and Authentik together.
- ~~Authentication on the ingestion/review endpoints~~ — Authentik
  forward-auth now fronts the dashboard, and `PATCH /api/pdm/fault-events/:id`
  is gated to the `pdm-reviewers` group when an identity is present.
- ~~CSV/JSON export from the Reports page~~ — implemented client-side (CSV,
  Excel via SpreadsheetML, and a PDF print view), generated from the
  `/api/history/series` endpoint with no dedicated export endpoint needed.

**High priority (blocks a trained fault-prediction model):**
- Continue collecting fault episodes (target: ~100–200) to clear the
  evaluation gate and enable model selection & hyperparameter tuning — see
  [Fault Detection & Prediction Pipeline](#fault-detection--prediction-pipeline).

**Medium priority (production readiness):**
- **Server-Sent Events (SSE) or WebSockets** instead of polling, for instant
  push updates with less network chatter (current poll rates — 1s for live
  data, 15s-5min for everything else — are adequate for a university demo,
  but a real control room would benefit from sub-second latency).
- **User-editable alert thresholds** — currently a static config file
  (`server/config/thresholds.js`, mirrored in `client/src/utils/constants.js`)
  rather than something a reviewer can adjust from the UI.
- **TimescaleDB retention/compression policies** to downsample or roll up
  very old raw readings once the table grows large (currently unbounded; see
  TimescaleDB's `add_retention_policy`/`add_compression_policy`).
- **Frontend lint tooling** — `client/` has no ESLint config; adding
  `eslint-plugin-react-hooks` and `eslint-plugin-jsx-a11y` would catch hook
  and accessibility regressions automatically rather than relying on manual
  review.
