# Predictive Maintenance (PdM) — Implementation Plan

Adds a tiered fault-detection system on top of the existing preprocessing pipeline: a
rule-based (Tier 1) detector running today, a Human-In-The-Loop (HITL) review workflow that
labels confirmed faults and extracts training buffers, and the wiring for a Tier 2 ML
model (Random Forest / XGBoost) to be trained later once enough labeled faults exist.

**Status:** planning only — nothing here has been executed yet.

**Independent of the TimescaleDB migration** (`docs/plan/2026-08-04-timescaledb-migration.md`).
This plan targets the current SQLite setup as-is and does not depend on that migration
happening first, or at all. See §7 for the one thing to watch if both land close together.

---

## 0. Preconditions

- The backend runs as it does today: Express + `better-sqlite3`, ingesting via
  `preprocessing/pipeline.js`, producing one `processed_telemetry` row per closed 60-second
  window through `processedService.saveAndTrigger()`.
- No Postgres, no CT changes, no infrastructure work required for this plan.

---

## 1. Scope

### In scope
- A Tier 1 rule engine — per-metric min/max/std-dev/rate-of-change thresholds — that scores
  every closed window and flags candidate faults.
- A `fault_events` table (HITL's record: root cause, resolution, reviewer, confidence,
  linked buffer range) and review endpoints to confirm/reject/annotate a flagged candidate.
- Fault-buffer extraction: on HITL confirmation, capture references to the hour before, the
  fault period, and the hour after, from `raw_telemetry`, keyed by timestamp range — stored
  as DB rows, not standalone CSV files (see §3.3 for why).
- A new `pdmService.js` hook wired into `processedService.saveAndTrigger()`, following the
  exact pattern already used by forecast/drift/trend.
- A standalone Python FastAPI service (new `pdm/` directory at the repo root, sibling to
  `server/` and `client/`) that receives a `processedRecord` over HTTP and returns a Tier 1
  rule-engine verdict. Structured so a Tier 2 model slots into the same endpoint later
  without changing the contract.
- Docker packaging for the Python service, consistent with the existing
  `docker-compose.backend.yml` / `docker-compose.frontend.yml` split-file convention.

### Explicitly NOT in scope
- **No Tier 2 model training or trained model artifact.** There isn't enough labeled fault
  data yet — that's the entire reason Tier 1 + HITL exists first. `pdm/app/model.py` is
  scaffolded with a clear extension point but ships with no model loaded, and `/score`
  returns the rule-engine verdict only.
- **No TimescaleDB / Postgres.** Everything here runs against the current SQLite database.
- **No multi-pump support.** Same single-stream assumption the rest of the codebase makes
  today (see `docs/plan/2026-08-04-timescaledb-migration.md` §4.5's note on this).
- **No Proxmox CT provisioning.** A dedicated `pdm-python` CT running this container is
  still the intended deployment target (consistent with the frontend/backend/node-red CT
  split), and `docker-compose.pdm.yml` is written as its own file specifically so it can be
  deployed there independently. Standing up that CT is manual operator work, not something
  Claude Code does — same split used in the TimescaleDB plan, where CT creation was never
  part of the repo-work scope either. See the session notes for the CT creation steps.
- **No dashboard UI changes beyond what's needed to review flagged faults.** A full HITL
  review UI is a separate, larger frontend task — this plan adds the API endpoints it would
  call, not the screens themselves.

### Why this shape
- **Rules before ML** because there isn't enough labeled fault diversity to train anything
  yet — this was the tech lead's explicit call, and it matches the reality of the dataset
  (mostly normal operation, a handful of fault episodes).
- **HITL writes to the database, not standalone CSVs** because a disconnected file
  side-channel becomes unmanageable (orphaned files, no query-ability, no link back to the
  fault record) — see §3.3.
- **Python stays stateless, behind HTTP, no direct DB access** — this was already decided:
  SQLite's single-writer model doesn't tolerate a second process writing to it, and the
  language boundary (Node/Python) doubles as a clean process/deploy boundary.
- **The rule engine reuses features the pipeline already computes.** `precapFeaturesByMetric`
  (`rawStdDev`, `rawRateOfChange`, `rawMaxExcursion` per metric, computed in
  `preprocessing/precapFeatures.js`) is already exactly the `[min, max, std-dev, rate of
  change]` feature set the tech lead specified — combined with the per-window
  `{metric}Min`/`{metric}Max` columns already stored on `processed_telemetry`. Tier 1 does
  not need to recompute anything Node has already produced.

---

## 2. Target repo layout

```
server/
├── database/
│   ├── schema.sql              # + fault_events table (see §4.2)
│   └── db.js                   # + one more idempotent ALTER TABLE block, matching existing style
├── models/
│   └── faultEventModel.js      # NEW — mirrors processedModel.js's role for the new table
├── services/
│   ├── processedService.js     # saveAndTrigger() gains a 4th onNewProcessedRecord call
│   └── pdmService.js           # NEW — onNewProcessedRecord hook, HTTP call to pdm/, persists verdict
├── controllers/
│   └── pdmController.js        # NEW — HITL review endpoints (list flagged, confirm, reject, annotate)
└── routes/index.js             # + /api/pdm/* routes

pdm/                             # NEW — top-level, sibling to server/ and client/
├── app/
│   ├── main.py                 # FastAPI app, POST /score
│   ├── rules.py                 # Tier 1: min/max/std-dev/rate-of-change thresholds
│   ├── model.py                 # Tier 2 extension point — no model loaded yet
│   └── schemas.py               # Pydantic models mirroring processedRecord's shape
├── tests/
│   └── test_rules.py
├── requirements.txt
├── Dockerfile
└── .env.example

docker-compose.pdm.yml          # NEW — follows the existing backend/frontend split-file pattern
```

---

## 3. Design decisions

### 3.1 What the rule engine actually evaluates

Every closed window already carries, per metric, in `processed_telemetry`:
`{metric}Mean/Median/Min/Max/StdDev/Last`, plus `precapFeaturesByMetric.{metric}` with
`rawStdDev`, `rawRateOfChange`, `rawMaxExcursion` computed *before* Hampel capping (i.e. the
raw signal, not the smoothed one — the right input for fault detection, where you want to
see the spike, not have it capped away).

Tier 1 rules operate on this JSON directly. No new Node-side computation is needed — the
Python service receives the full `processedRecord` payload and evaluates thresholds against
fields that already exist.

Threshold source: start from the physically-reasoned constants already in
`server/preprocessing/config.js` (`MAX_RAMP_RATE_PER_SECOND`) and `server/utils/validation.js`
(`RANGES`) as the initial rate-of-change and min/max ceilings, rather than inventing a
second, disconnected set of numbers. These are explicitly documented as provisional
placeholders in that file — Tier 1's thresholds should say so too, and should be easy for
the tech lead / a domain expert to retune without a code change (see 3.1.1).

**3.1.1 Threshold configuration** — thresholds live in a single, well-commented
`pdm/app/thresholds.yaml` (or `.py` dict, whichever the implementer prefers — YAML is easier
for a non-engineer to tune later), not hardcoded inline in `rules.py`. Each metric gets:
`stdDevMax`, `rateOfChangeMax`, `min`, `max` — sourced initially from the Node-side constants
above, explicitly labeled as "initial values, ported from server/preprocessing/config.js,
pending domain-expert review."

### 3.2 What a "flag" actually is

A rule violation on a single window is a **candidate**, not a confirmed fault — this mirrors
the existing philosophy in `faultClassifier.js` ("never fabricate confidence it doesn't
have"). The Tier 1 response shape:

```json
{
  "flagged": true,
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "triggeredRules": ["vibration.rateOfChange", "motorTemp.stdDev"],
  "metric": "vibration",
  "windowEnd": "2026-08-05T10:14:00.000Z"
}
```

`confidence` is derived from how many independent rules triggered and on how many metrics —
same reasoning `faultClassifier.js` already uses for its own SENSOR_FAULT vs
NOT_SENSOR_FAULT split (two or more metrics moving together is stronger signal than one).
Reuse that reasoning rather than inventing a new scale.

A flagged candidate becomes a `fault_events` row with `status = 'PENDING_REVIEW'`. Nothing
about a Tier 1 flag is presented to an operator as a confirmed fault — HITL review is what
promotes it.

### 3.3 Why `fault_events` is a table, not CSV files

Per the tech lead's original idea, fault buffers were going to be separate CSV files
(hour-before + fault period + hour-after) to enrich a future training set. Storing the
*buffer content* as a duplicate copy is unnecessary — `raw_telemetry` already has every
sample in that range. All `fault_events` needs to store is the **time range** and the HITL
metadata; the buffer is reconstructed on demand with a single timestamp query.

```sql
CREATE TABLE IF NOT EXISTS fault_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What Tier 1 (or a human, for a manually-logged fault) flagged.
  detectedAt         TEXT NOT NULL,          -- ISO timestamp the flag was raised
  triggerWindowEnd   TEXT NOT NULL,          -- processed_telemetry.timestamp that triggered this
  triggeredRules     TEXT,                   -- JSON array, e.g. ["vibration.rateOfChange"]
  confidence         TEXT,                   -- LOW | MEDIUM | HIGH (Tier 1's own read)

  -- Buffer boundaries — an hour before the fault, the fault period itself, and
  -- an hour after it's resolved. bufferEnd is only known once resolvedAt is
  -- set, so it's nullable until HITL closes the event out.
  faultStart         TEXT NOT NULL,
  faultEnd           TEXT,
  bufferStart        TEXT NOT NULL,          -- faultStart minus 1 hour
  bufferEnd          TEXT,                   -- faultEnd plus 1 hour, once known

  -- HITL fields — null until a human reviews it.
  status             TEXT NOT NULL DEFAULT 'PENDING_REVIEW', -- PENDING_REVIEW | CONFIRMED | REJECTED
  faultType          TEXT,                   -- THERMAL | CAVITATION | BEARING | OTHER, HITL's call
  rootCause          TEXT,
  resolution         TEXT,
  reviewedBy         TEXT,
  reviewedAt         TEXT,
  notes              TEXT,

  createdAt          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fault_events_status ON fault_events (status);
CREATE INDEX IF NOT EXISTS idx_fault_events_buffer ON fault_events (bufferStart, bufferEnd);
```

Extracting the actual buffer for training is then just:

```sql
SELECT * FROM raw_telemetry
WHERE timestamp BETWEEN :bufferStart AND :bufferEnd
ORDER BY timestamp ASC;
```

If a CSV export is genuinely needed later (e.g. to hand a dataset to someone without DB
access, or to snapshot it for a specific model training run), generate it **from this
query, on demand** — it's a derived artifact, not the source of truth. Add a
`GET /api/pdm/fault-events/:id/buffer.csv` endpoint for that if/when it's actually needed;
not included in this phase's scope unless requested.

Add this table in `schema.sql`, following the file's existing style, and add the matching
idempotent `ALTER TABLE`/creation check in `db.js` if the table needs to be introduced to an
already-running database without a fresh `data.db` — same pattern every other addition in
that file already follows.

### 3.4 The Node ↔ Python HTTP boundary

`pdmService.js` mirrors `forecastService.js`/`driftService.js`/`trendService.js`'s
`onNewProcessedRecord(data)` export, and gets added to `processedService.saveAndTrigger()`
as a fourth call in the same try/catch-isolated pattern already used for the other three —
a PdM scoring failure must never block or slow ingestion, exactly like a forecast/drift/trend
failure doesn't today:

```js
// processedService.js — saveAndTrigger(), alongside the existing three
try {
  pdmOnNewRecord(data);
} catch (err) {
  logger.error(`pdmService.onNewProcessedRecord failed: ${err.stack || err.message}`);
}
```

`pdmService.js` itself does a **fire-and-forget** async POST (does not block
`saveAndTrigger`'s return) to `PDM_SERVICE_URL` (from `.env`, not hardcoded — this is the
config-driven URL the earlier discussion called for, so pointing it at a different
container/CT later is a config change, not a code change):

```js
const PDM_SERVICE_URL = process.env.PDM_SERVICE_URL || 'http://localhost:8000';
```

with a short timeout (e.g. 2s) and a swallowed failure (logged, not thrown) — a slow or
down PdM service must never back up ingestion. On a successful response, `pdmService.js`
persists a `fault_events` row itself (Node owns all DB writes; Python never touches SQLite
directly, per the already-settled boundary) only when the response is `flagged: true`.

### 3.5 Python service shape

FastAPI, loaded once at container startup (no per-request import/reload):

- `POST /score` — body: the `processedRecord` JSON shape (mirror
  `processedService.js`'s `rowToProcessed()` output via a Pydantic model in `schemas.py` —
  this doubles as a schema contract that will loudly fail validation if Node's shape drifts
  from what Python expects, rather than silently misreading fields).
- `GET /health` — trivial liveness check, same spirit as the existing `/api/health`.
- `rules.py` holds the actual threshold logic as pure functions (input: metrics dict +
  thresholds config, output: the flag/confidence/triggeredRules shape from §3.2) — kept
  framework-free and directly unit-testable, same "pure functions, no framework" pattern
  `server/utils/validation.js` already follows for the same reason.
- `model.py` is a stub: a `score(record) -> None` that returns `None` today (no model
  loaded), with a clear docstring marking it as Tier 2's future entry point. `main.py`'s
  `/score` handler calls `rules.evaluate(record)` first; if/when `model.py` has something
  loaded, its output augments (not replaces) the rule verdict, per the tiered design agreed
  on earlier in this conversation.

### 3.6 HITL review endpoints

```
GET  /api/pdm/fault-events?status=PENDING_REVIEW    # list, filterable by status
GET  /api/pdm/fault-events/:id                       # one event + its buffer sample count
PATCH /api/pdm/fault-events/:id                       # HITL confirms/rejects/annotates:
                                                        #   { status, faultType, rootCause,
                                                        #     resolution, reviewedBy, notes,
                                                        #     faultEnd }
```

`PATCH` with `status: 'CONFIRMED'` and a `faultEnd` is what finalizes `bufferEnd` (=
`faultEnd` + 1 hour) — until then the buffer's trailing edge is genuinely unknown, since the
fault isn't resolved yet.

---

## 4. Work items

### 4.1 Database
- Add `fault_events` to `schema.sql` (§3.3).
- Add the matching idempotent creation check to `db.js`, consistent with the existing
  pattern for every other schema addition in that file.
- `faultEventModel.js` — prepared statements: insert, list-by-status, get-by-id, update
  (HITL patch), and the buffer-range query against `raw_telemetry`.

### 4.2 Node service layer
- `pdmService.js`: `onNewProcessedRecord(data)`, the fire-and-forget POST to
  `PDM_SERVICE_URL`, and `fault_events` row creation on a `flagged: true` response.
- Wire it into `processedService.saveAndTrigger()` (§3.4).
- `pdmController.js` + routes for the three HITL endpoints (§3.6).
- `.env.example`: add `PDM_SERVICE_URL=http://localhost:8000`.

### 4.3 Python service
- `pdm/app/schemas.py` — Pydantic models mirroring `processedRecord`.
- `pdm/app/thresholds.yaml` — initial values ported from `config.js`/`validation.js`,
  labeled as provisional.
- `pdm/app/rules.py` — pure threshold-evaluation functions + the confidence heuristic.
- `pdm/app/model.py` — stub only.
- `pdm/app/main.py` — FastAPI app, `/score`, `/health`.
- `pdm/requirements.txt` — `fastapi`, `uvicorn`, `pydantic`, `pyyaml`.
- `pdm/Dockerfile` — slim Python base, `uvicorn` entrypoint, non-root user.
- `pdm/tests/test_rules.py` — unit tests per rule (threshold crossed / not crossed,
  single-metric vs multi-metric confidence escalation).

### 4.4 Docker / compose
- `docker-compose.pdm.yml`, matching the existing `docker-compose.backend.yml` /
  `docker-compose.frontend.yml` split-file convention:
  ```yaml
  services:
    pdm:
      build: ./pdm
      ports:
        - "8000:8000"
      restart: unless-stopped
  ```
- Update `docker-compose.yml` (the combined local-dev file) to include the `pdm` service
  alongside `server`/`client`, with `PDM_SERVICE_URL=http://pdm:8000` set on the `server`
  service so the two containers can reach each other by Docker network name.

### 4.5 Tests
- `rules.py` unit tests (Python side, §4.3).
- A Node integration test: POST a `processedRecord` that should trigger a rule (e.g.
  vibration rate-of-change past threshold), confirm a `fault_events` row is created with
  `status = PENDING_REVIEW`.
- A Node test confirming `saveAndTrigger()` still returns successfully and stores the
  processed record even when `PDM_SERVICE_URL` is unreachable (the fire-and-forget/timeout
  contract from §3.4).

---

## 5. Verification

1. Start `pdm` (`docker compose -f docker-compose.pdm.yml up`) and confirm
   `GET http://localhost:8000/health` responds.
2. Start the backend with `PDM_SERVICE_URL` pointed at it; run the Node-RED simulator long
   enough to close several windows.
3. Force a rule violation (e.g. temporarily lower a threshold in `thresholds.yaml`, or feed
   the simulator a fault-profile burst) and confirm a `fault_events` row appears with
   `status = PENDING_REVIEW` and a populated `triggeredRules`.
4. Exercise the HITL endpoints: list pending events, `PATCH` one to `CONFIRMED` with a
   `faultType`/`rootCause`/`resolution`/`faultEnd`, confirm `bufferEnd` is set correctly
   (`faultEnd` + 1 hour) and the row moves out of the pending list.
5. Query the buffer directly (§3.3's `SELECT ... WHERE timestamp BETWEEN`) and confirm it
   returns the expected ~2-hour-plus span of `raw_telemetry` rows.
6. Stop the `pdm` container entirely and confirm ingestion (`POST /api/data`) keeps working
   without delay or error — the fire-and-forget contract must hold under a fully-down
   dependency, not just a slow one.

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| PdM scoring call blocks or slows ingestion | High | Fire-and-forget, short timeout, try/catch-isolated (§3.4); verified explicitly in §5.6 |
| Python service becomes a second DB writer | High | Never given DB credentials; only ever sees HTTP payloads (§3.4, already an existing decision) |
| Thresholds are guesses, not validated against real fault data | Medium — expected at this stage | Explicitly labeled provisional in `thresholds.yaml`; HITL-confirmed/rejected events are the feedback loop that should retune them over time |
| `processedRecord` shape drifts between Node and Python over time | Medium | Pydantic schema in `schemas.py` fails loudly on a mismatch instead of silently misreading fields |
| CSV buffer files re-proliferate as an ad hoc habit despite the DB-first design | Low | Buffers are DB time-range queries by default; CSV export is an explicit, on-demand endpoint, not the storage mechanism |
| `fault_events` added to `schema.sql` but `db.js`'s creation check forgotten, breaking existing dev databases | Low | Follow the exact existing pattern in `db.js` for every prior schema addition |

---

## 7. Interaction with the TimescaleDB migration, if both are in flight

These two plans don't depend on each other, but if PdM lands first and the Postgres
migration happens afterward: `fault_events` needs to be included in the Postgres
`001_init.sql` port (`docs/plan/2026-08-04-timescaledb-migration.md` §4.2), since it will
exist in SQLite by then and that migration's stated scope was "only the two existing
tables" at the time it was written — that scope note should be revisited to include
`fault_events` if this plan has already merged. No other interaction — `pdmService.js`'s
Node-side queries go through the same models/services layer the Postgres migration already
rewrites, so nothing PdM-specific needs special handling in that plan beyond this
schema-inclusion note.

---

## 8. Definition of done

- [ ] `fault_events` table exists, following the existing schema/migration-check pattern
- [ ] `pdmService.js` wired into `saveAndTrigger()`, fire-and-forget, never blocks ingestion
- [ ] Backend survives the PdM service being fully down (§5.6)
- [ ] Tier 1 rule engine flags a forced violation with correct `triggeredRules`/`confidence`
- [ ] HITL endpoints: list, get, confirm/reject/annotate all working
- [ ] Buffer range query returns the correct hour-before/fault/hour-after span
- [ ] Thresholds live in one configurable file, labeled provisional, sourced from existing
      Node-side constants
- [ ] `pdm/` container builds and runs via `docker-compose.pdm.yml`
- [ ] Python unit tests for `rules.py` pass
- [ ] No PdM code reads or writes SQLite directly from Python
