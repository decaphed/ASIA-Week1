# Industrial IoT Live-Data Monitoring Dashboard

A full-stack, real-time industrial monitoring dashboard built for a university IoT
assignment. **Node-RED** simulates sensor hardware, **Express + SQLite** ingests
and stores every reading, and a **React + Vite** dashboard displays live values,
scrolling charts, and searchable historical records — all without a single
manual page refresh.

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
8. [Why SQLite](#why-sqlite)
9. [API Documentation](#api-documentation)
10. [Node-RED Learning Guide](#node-red-learning-guide-beginner-friendly)
11. [End-to-End Data Flow Walkthrough](#end-to-end-data-flow-walkthrough)
12. [Troubleshooting](#troubleshooting)
13. [Future Improvements](#future-improvements)

---

## Project Overview

| Layer | Technology | Responsibility |
|---|---|---|
| Data generation | **Node-RED** | Simulates a sensor every second and POSTs a JSON reading to the backend |
| Backend | **Node.js + Express** | Validates, stores, and serves sensor data over a REST API |
| Storage | **SQLite** (`better-sqlite3`) | A single-file, zero-config database holding every reading ever recorded |
| Frontend | **React (Vite) + Chart.js** | Polls the API and renders live cards, scrolling charts, and a history table |

The three pieces are fully decoupled — each only knows about HTTP. You could
swap Node-RED for a real sensor, or React for a mobile app, without touching
the other two.

---

## Architecture

```
┌──────────────┐   HTTP POST /api/data    ┌─────────────────────────┐
│  Node-RED    │  every 1s (JSON reading) │   Express backend :3000 │
│  (generator) │ ───────────────────────► │  routes→controllers→    │
│  inject→func │                          │  services→SQLite (better│
│  →http req   │                          │  -sqlite3)  data.db     │
└──────────────┘                          └───────────┬─────────────┘
                                                       │ GET /api/live   (1s)
                                                       │ GET /api/history(5s)
                                                       │ GET /api/stats /health
                                                       ▼
                                          ┌─────────────────────────┐
                                          │  React dashboard :5173  │
                                          │  services/api → hooks → │
                                          │  cards / charts / table │
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
- **SQLite** is a single file (`server/data.db`) — no database server to
  install, configure, or crash. See [Why SQLite](#why-sqlite) for the full
  reasoning.
- **React polls** rather than uses WebSockets/SSE, because polling is the
  simplest mechanism to build, explain, and debug live in a viva. `/api/live`
  is polled every second (matches Node-RED's generation rate); `/api/history`
  and `/api/stats` every 5 seconds (they don't need per-second freshness).

---

## Folder Structure

```
ASIA-Week1/
├── client/                     # React + Vite frontend
│   ├── src/
│   │   ├── assets/
│   │   ├── components/
│   │   │   ├── charts/         # LiveChart.jsx
│   │   │   ├── dashboard/      # SensorCard, SensorCardGrid, StatsPanel
│   │   │   ├── layout/         # Sidebar, Topbar, StatusIndicator, Clock
│   │   │   ├── tables/         # HistoryTable
│   │   │   └── ui/             # Card, Spinner, ErrorBanner
│   │   ├── hooks/               # usePolling, useSensorData (useLiveData, …)
│   │   ├── pages/               # DashboardPage.jsx
│   │   ├── services/            # api.js — the ONLY file that makes HTTP calls
│   │   ├── utils/               # formatters.js, constants.js
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css            # dark industrial theme
│   ├── index.html
│   ├── vite.config.js
│   └── .env.example
├── server/                     # Express + SQLite backend
│   ├── controllers/             # HTTP request/response shaping
│   ├── routes/                  # URL → controller mapping
│   ├── middleware/               # validation, error handling, latency timer
│   ├── database/                 # db.js (connection), schema.sql
│   ├── models/                    # ALL SQL lives here (sensorModel.js)
│   ├── services/                  # business logic (sensorService.js)
│   ├── utils/                      # logger.js, validation.js
│   ├── app.js                      # Express app config
│   ├── server.js                   # entry point
│   └── .env.example
├── node-red/
│   └── flow.json                # importable Node-RED flow
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

# 3. Node-RED (no local install needed — see "Running Node-RED" below)
```

## Running the Backend

```bash
cd server
npm run dev      # nodemon, auto-restarts on file changes
# or: npm start   for a plain node run
```

On first run, `server/data.db` is created automatically and the `SensorData`
table is set up. You should see:

```
[INFO ] SQLite ready at .../server/data.db
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

Open **http://localhost:5173**. Until Node-RED starts sending data, the cards
show `--` and the history table shows "No readings yet" — this is expected,
graceful behaviour, not a bug.

To build a production bundle: `npm run build` (outputs to `client/dist/`).

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

---

## Why SQLite

SQLite is the right database for this project for several concrete reasons:

- **Zero configuration.** There's no separate database server to install,
  start, or crash independently of your app — the entire database is one file
  (`server/data.db`). For a student project or a small edge-device gateway,
  this removes an entire category of setup problems.
- **Embedded, not networked.** The database library links directly into the
  Node process (`better-sqlite3`). There's no TCP connection, no connection
  pool, no network latency between your app and its data.
- **Perfectly matched to the data volume.** A dashboard ingesting one row per
  second produces ~86,400 rows/day — trivial for SQLite, which comfortably
  handles databases many gigabytes in size.
- **Synchronous API (via `better-sqlite3`).** Every query
  (`db.prepare(sql).get()/.all()/.run()`) returns immediately — no callbacks,
  no promises. This makes the storage code read top-to-bottom, which is ideal
  for learning and for a viva walkthrough.
- **WAL mode** (`PRAGMA journal_mode = WAL`, set in `database/db.js`) lets the
  many `GET` requests (reads) proceed concurrently with the `POST /api/data`
  writes from Node-RED, so the dashboard never blocks waiting on ingestion.

The schema (`server/database/schema.sql`) is intentionally simple:

```sql
CREATE TABLE IF NOT EXISTS SensorData (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  temperature REAL    NOT NULL,
  humidity    REAL    NOT NULL,
  pressure    REAL    NOT NULL,
  light       INTEGER NOT NULL DEFAULT 0,  -- 0/1, SQLite has no BOOLEAN type
  timestamp   TEXT    NOT NULL              -- ISO-8601 string
);

CREATE INDEX IF NOT EXISTS idx_sensordata_timestamp ON SensorData (timestamp DESC);
```

- `INTEGER PRIMARY KEY` is SQLite's alias for the internal `ROWID`, so it
  auto-increments with no extra syntax.
- `light` is stored as `0`/`1` because SQLite has no native boolean type; the
  service layer (`services/sensorService.js`) converts it back to `true`/`false`
  for the API.
- `timestamp` is `TEXT` in ISO-8601 format (`2026-07-05T10:00:00.000Z`).
  SQLite has no dedicated date type, but ISO strings sort correctly as plain
  text, which is all `ORDER BY timestamp` needs.
- The index on `timestamp` speeds up the "give me the newest N rows" queries
  that `/api/live` and `/api/history` run constantly.

All SQL lives in exactly one file: **`server/models/sensorModel.js`**. Nowhere
else in the backend writes a SQL string — controllers and services only call
named functions like `insertReading()` or `getHistory()`. This is the standard
data-access-layer pattern: one place to audit, optimize, or swap out storage.

---

## API Documentation

Base URL: `http://localhost:3000/api`

### `POST /api/data`

Ingests one sensor reading (this is what Node-RED calls every second).

**Request body:**
```json
{
  "temperature": 24.6,
  "humidity": 55.2,
  "pressure": 1013.1,
  "light": true,
  "timestamp": "2026-07-05T10:00:00.000Z"
}
```
`timestamp` is optional — if omitted, the server stamps the current time.

**Success (201):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "temperature": 24.6,
    "humidity": 55.2,
    "pressure": 1013.1,
    "light": true,
    "timestamp": "2026-07-05T10:00:00.000Z"
  }
}
```

**Validation failure (400):**
```json
{
  "success": false,
  "error": "Invalid sensor data",
  "details": ["temperature must be a number", "humidity is required"]
}
```

### `GET /api/live`

Returns the single most recent reading.

```json
{ "success": true, "data": { "id": 42, "temperature": 26.1, "humidity": 61.3, "pressure": 1009.4, "light": false, "timestamp": "2026-07-05T10:05:00.000Z" } }
```
If no readings exist yet: `{ "success": true, "data": null, "message": "No readings yet" }`.

### `GET /api/history`

Returns a page of historical readings, newest first by default.

**Query params:** `page` (default 1), `limit` (default 100, max 1000), `sort` (`asc`|`desc`, default `desc`)

```
GET /api/history?page=1&limit=5&sort=desc
```
```json
{
  "success": true,
  "page": 1,
  "limit": 5,
  "sort": "desc",
  "total": 238,
  "totalPages": 48,
  "count": 5,
  "data": [ { "id": 238, "temperature": 27.3, "humidity": 58.0, "pressure": 1015.2, "light": true, "timestamp": "2026-07-05T10:09:58.000Z" }, "... 4 more" ]
}
```

### `GET /api/stats`

Aggregate statistics across all stored readings.

```json
{
  "success": true,
  "data": {
    "totalRecords": 238,
    "latestTimestamp": "2026-07-05T10:09:58.000Z",
    "averageTemperature": 27.41,
    "averageHumidity": 59.87,
    "averagePressure": 1012.03,
    "apiLatencyMs": 0.68
  }
}
```

### `GET /api/health`

Backend + database status, used to drive the dashboard's connection
indicators.

```json
{
  "success": true,
  "status": "ok",
  "database": "connected",
  "uptimeSeconds": 340,
  "lastReadingAt": "2026-07-05T10:09:58.000Z",
  "serverTime": "2026-07-05T10:09:59.100Z"
}
```

The React app infers the **Node-RED** indicator itself: if `lastReadingAt` is
more recent than a few seconds ago, data must still be flowing in, so Node-RED
must be running — no dedicated "Node-RED heartbeat" endpoint is needed.

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
| **Purpose** | Runs arbitrary JavaScript. Here it builds one fake sensor reading. |
| **Why it's needed** | This is where the actual simulation logic lives — random values within realistic physical ranges. |
| **Configuration** | The code below is pasted into the node's "Function" tab. |

**Full code** (also embedded in `flow.json`):
```javascript
// Generate one simulated sensor reading.
// rand() returns a value in [min, max] rounded to 1 decimal place.
function rand(min, max) {
    return Math.round((Math.random() * (max - min) + min) * 10) / 10;
}

msg.payload = {
    temperature: rand(20, 35),   // degrees Celsius
    humidity: rand(40, 80),      // percent
    pressure: rand(980, 1040),   // hectopascals (hPa)
    light: Math.random() > 0.5,  // random on/off
    timestamp: new Date().toISOString()
};

// Tell the backend the body is JSON so Express parses it correctly.
msg.headers = { "Content-Type": "application/json" };

return msg;
```

**Line-by-line:**
- `function rand(min, max) {...}` — a small helper that scales
  `Math.random()` (which returns 0–1) into the given range and rounds to one
  decimal place, so values look like real sensor precision (e.g. `24.6`, not
  `24.638291...`).
- `msg.payload = {...}` — every Node-RED message carries its data in
  `msg.payload`. We overwrite it entirely with our reading object.
- `temperature/humidity/pressure` — each calls `rand()` with the physical
  range specified in the assignment brief.
- `light: Math.random() > 0.5` — a coin flip; `true` about half the time.
- `timestamp: new Date().toISOString()` — the current instant as an ISO-8601
  string, e.g. `"2026-07-05T10:00:00.000Z"` — exactly the format our backend
  expects.
- `msg.headers = {...}` — the next node (`http request`) reads this to set the
  outgoing request's `Content-Type` header, so Express's `express.json()`
  middleware parses the body correctly.
- `return msg;` — every function node must return the (possibly modified)
  message to pass it along the wire.

**Expected debug output** (see node 4 below) for one tick might look like:
```json
{ "temperature": 24.6, "humidity": 55.2, "pressure": 1013.1, "light": true, "timestamp": "2026-07-05T10:00:00.000Z" }
```

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
    "temperature": 24.6,
    "humidity": 55.2,
    "pressure": 1013.1,
    "light": true,
    "timestamp": "2026-07-05T10:00:00.000Z"
  }
}
```
Seeing `"success": true` and an incrementing `id` confirms the whole pipeline
— generate → send → store — is working end to end.

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
| Backend returns 400 "Invalid sensor data" | Function node's ranges were edited to something out of bounds | Keep temperature 20–35, humidity 40–80, pressure 980–1040, or widen the ranges in `server/utils/validation.js` to match |
| CORS error mentioned in browser console | You're calling the API from a page whose origin isn't allowed | Not applicable to Node-RED itself (server-to-server has no CORS), but if you build a browser-based simulator instead, make sure `CLIENT_ORIGIN` in `server/.env` matches |
| Node-RED changes don't seem to apply | Forgot to click **Deploy** after editing | Always click the red Deploy button after any change |

---

## End-to-End Data Flow Walkthrough

1. **Node-RED generates sensor data.** The `inject` node fires once per
   second, triggering the `function` node to build a random reading object.
2. **Node-RED sends an HTTP POST request.** The `http request` node POSTs that
   JSON object to `http://localhost:3000/api/data`.
3. **Express receives the request.** `app.js` routes it through CORS,
   `express.json()` (parses the body), the latency timer, then to
   `routes/index.js`, which maps `POST /data` to the validation middleware and
   `dataController.createReading`.
4. **The backend validates the data.**
   `middleware/validateReading.js` calls `utils/validation.js`, rejecting the
   request with `400` if any field is missing, non-numeric, or out of its
   physical range.
5. **SQLite stores the reading.** `services/sensorService.js` normalizes the
   payload (booleans → 0/1, fills in a timestamp if missing) and calls
   `models/sensorModel.js`'s `insertReading()`, which runs a prepared `INSERT`
   statement against `data.db`.
6. **React requests live and historical data.** Independently of ingestion,
   the dashboard's `hooks/useSensorData.js` hooks (`useLiveData`, `useHistory`,
   `useStats`, `useHealth`) call `services/api.js`, which calls the
   corresponding `GET` endpoints on a timer (`usePolling.js`).
7. **The backend returns JSON responses.** Each controller
   (`liveController`, `historyController`, `statsController`,
   `healthController`) calls the service layer, which calls the model layer,
   and shapes a consistent `{ success, data }` envelope.
8. **React updates the dashboard cards.** `useLiveData`'s new data flows into
   `DashboardPage.jsx` → `SensorCardGrid` → each `SensorCard`, which detects
   the value changed (via a `useRef` comparison) and plays a brief pulse
   animation.
9. **React updates the charts.** The same live reading is appended to a
   rolling 30-point window per metric (`DashboardPage.jsx`'s `series` state),
   which `LiveChart` (Chart.js) redraws with animation disabled for an instant,
   scrolling feel.
10. **React refreshes the historical table.** Every 5 seconds, `useHistory`
    fetches the latest 100 rows; `HistoryTable` re-applies the user's current
    search/sort/pagination on the client side, so the view stays consistent
    even as new rows arrive underneath.

---

## Troubleshooting

| Problem | What you'll see | Fix |
|---|---|---|
| Backend offline | Dashboard shows an "Backend offline" banner; Backend indicator turns red | Start the server: `cd server && npm run dev` |
| SQLite unavailable | `/api/health` returns `503` with `"database": "unavailable"` | Check the `DB_PATH` in `server/.env` is writable; ensure no other process has locked `data.db` |
| Node-RED disconnected | Node-RED indicator turns red while Backend/Database stay green | Deploy the flow in Node-RED again; confirm the `inject` node's Repeat is set |
| Invalid sensor data (400) | Node-RED's `http request` node shows an error status | Check the function node's generated ranges match `server/utils/validation.js`'s `RANGES` |
| Empty history / "No readings yet" | Normal on first run | Start Node-RED so readings begin flowing |
| CORS error in browser console | Dashboard requests fail, console shows a CORS message | Make sure `client/.env`'s `VITE_API_URL` origin matches `server/.env`'s `CLIENT_ORIGIN` (default `http://localhost:5173`) |
| Network error / timeout | Dashboard hooks show `error`, stale data stays on screen | Confirm the backend is reachable at the configured `VITE_API_URL` and no firewall is blocking port 3000 |

---

## Future Improvements

- **Server-Sent Events (SSE) or WebSockets** instead of polling, for
  instant push updates with less network chatter.
- **Authentication** on the ingestion endpoint so only trusted devices can
  POST readings.
- **Docker Compose** to spin up backend + Node-RED + client with one command.
- **Configurable alert thresholds** (e.g. flag temperature > 32°C) surfaced
  as dashboard notifications.
- **Data retention/rollup jobs** to downsample very old readings once the
  table grows large.
