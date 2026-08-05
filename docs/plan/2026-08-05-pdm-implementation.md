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
│   └── schema.sql              # + fault_events table (see §4.2) — a plain CREATE TABLE IF NOT
│                                #   EXISTS is sufficient; no db.js ALTER TABLE work needed
│                                #   for a brand-new table (see §4.1 note)
├── models/
│   └── faultEventModel.js      # NEW — mirrors processedModel.js's role for the new table
├── services/
│   ├── processedService.js     # saveAndTrigger() gains a 4th onNewProcessedRecord call
│   ├── pdmService.js           # NEW — onNewProcessedRecord hook, HTTP call to pdm/, persists verdict
│   └── faultEventService.js    # NEW — sits between pdmController/pdmService and faultEventModel,
│                                #   matching this repo's controller→service→model layering
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

**Porting `MAX_RAMP_RATE_PER_SECOND` is not a direct copy — the statistics don't match.**
`MAX_RAMP_RATE_PER_SECOND` is an *instantaneous* per-second ceiling (the largest single-tick
jump `validator.js` will tolerate before flagging a physics violation). `rawRateOfChange` in
`precapFeaturesByMetric` is a *mean* of tick-to-tick differences averaged across the entire
60-sample window. A window's mean rate of change will almost always sit far below the
instantaneous max — most of a window is quiet, even one carrying a real fault — so seeding
`rateOfChangeMax` directly from `MAX_RAMP_RATE_PER_SECOND`'s values means the rule will
rarely if ever fire. `rules.py` must state and apply an explicit derivation (e.g. a
documented fraction of the instantaneous ceiling, tuned against a few known-fault windows
from the simulator, not the raw constant itself). `motorTemp` also has no entry in
`MAX_RAMP_RATE_PER_SECOND` at all — its `rateOfChangeMax` needs its own reasoned starting
value (temperature moves slowly; a strict ceiling here is appropriate), not a silent gap.

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

**Don't surface `confidence` prominently in the eventual review UI.** If a reviewer sees
Tier 1's own confidence score while labeling an event, they're prone to anchor on it and
rubber-stamp high-confidence flags rather than independently judging the data — which would
launder Tier 1's own bias into what's supposed to be ground-truth training data. Keep
`confidence` available (e.g. in a details panel, not the headline), and separately track how
often HITL's outcome agrees with Tier 1's confidence level — that agreement rate is a useful
signal for retuning thresholds later, distinct from the review itself. This only matters once
the review UI (deferred, per §1) gets built, but the `fault_events` schema already captures
what's needed for it (`confidence` + `status` on the same row).

### 3.3 Why `fault_events` is a table, not CSV files

Per the tech lead's original idea, fault buffers were going to be separate CSV files
(hour-before + fault period + hour-after) to enrich a future training set. Storing the
*buffer content* as a duplicate copy is unnecessary — `raw_telemetry` already has every
sample in that range. All `fault_events` needs to store is the **time range** and the HITL
metadata; the buffer is reconstructed on demand with a single timestamp query.

```sql
CREATE TABLE IF NOT EXISTS fault_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- FK to the window that triggered this (or, for a periodically-sampled
  -- negative example — see below — the window it was sampled from). A real
  -- foreign key, not a timestamp-string match, so a row can never silently
  -- point at the wrong window if two windows share a timestamp collision.
  processedTelemetryId INTEGER NOT NULL REFERENCES processed_telemetry(id),

  -- What Tier 1 (or a human, for a manually-logged fault) flagged.
  -- eventType distinguishes an actual flag from a periodically-sampled
  -- "normal" window banked as a negative training example (see §3.3.1) —
  -- without this, Tier 2 would train on flagged windows only and never see
  -- a confirmed-normal example.
  eventType             TEXT NOT NULL DEFAULT 'FLAGGED', -- FLAGGED | NEGATIVE_SAMPLE
  detectedAt            TEXT NOT NULL,          -- ISO timestamp the flag/sample was raised
  triggerWindowEnd      TEXT NOT NULL,          -- processed_telemetry.timestamp that triggered this
  lastSeenWindowEnd     TEXT,                   -- bumped on every coalescing extension (§3.3.2); an open
                                                  -- PENDING_REVIEW row is only extendable while this stays
                                                  -- within the lookback bound of the current window
  triggeredRules        TEXT,                   -- JSON array, e.g. ["vibration.rateOfChange"]; null for NEGATIVE_SAMPLE
  confidence            TEXT,                   -- LOW | MEDIUM | HIGH (Tier 1's own read); null for NEGATIVE_SAMPLE

  -- Snapshot of exactly what Tier 1 saw at flag time. Captured now because
  -- it CANNOT be reconstructed later: if precapFeatures.js's windowing or
  -- the thresholds change before Tier 2 is trained, an offline recompute
  -- from raw_telemetry would silently disagree with what the rule engine
  -- actually acted on (train/serve skew). This is the feature vector Tier 2
  -- trains against, not a raw_telemetry re-derivation.
  --
  -- Composition is fixed and identical for BOTH eventTypes — this is not
  -- "the metric(s) that triggered," it's every metric, every time, so
  -- FLAGGED and NEGATIVE_SAMPLE rows produce the same feature dimensionality
  -- for Tier 2 training. Exactly:
  --   { precapFeaturesByMetric,   // verbatim, all six metrics
  --     metricStats: { <metric>: { mean, median, min, max, stdDev, last } for all six metrics } }
  -- i.e. the full precapFeaturesByMetric object plus the full per-metric
  -- stats block off processedRecord — never a per-metric subset, even
  -- though only one or two metrics triggered a rule on a FLAGGED row.
  featureSnapshot       TEXT NOT NULL,          -- JSON, fixed shape above, captured identically for FLAGGED and NEGATIVE_SAMPLE
  thresholdsVersion      TEXT,                   -- the `version:` string read from thresholds.yaml itself (see §3.1.1) —
                                                  -- not a git SHA or file mtime, so it's stable across deploys and doesn't
                                                  -- require git at runtime; bumped manually by whoever retunes the file

  -- Buffer boundaries — an hour before the fault, the fault period itself, and
  -- an hour after it's resolved. bufferEnd is only known once the fault is
  -- resolved, so it's nullable until HITL closes the event out. Null for
  -- NEGATIVE_SAMPLE rows, which have no fault period to bracket.
  faultStart            TEXT,
  faultEnd              TEXT,
  bufferStart           TEXT,                   -- faultStart minus 1 hour
  bufferEnd             TEXT,                   -- faultEnd plus 1 hour, once known

  -- HITL fields — null until a human reviews it. Not applicable to
  -- NEGATIVE_SAMPLE rows, which don't go through review.
  status                TEXT NOT NULL DEFAULT 'PENDING_REVIEW', -- PENDING_REVIEW | CONFIRMED | REJECTED | (N/A for NEGATIVE_SAMPLE)
  faultType              TEXT,                   -- THERMAL | CAVITATION | BEARING | OTHER, HITL's call
  rootCause              TEXT,
  resolution              TEXT,
  reviewedBy              TEXT,
  reviewedAt              TEXT,
  notes                   TEXT,

  createdAt               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fault_events_status ON fault_events (status);
CREATE INDEX IF NOT EXISTS idx_fault_events_buffer ON fault_events (bufferStart, bufferEnd);
CREATE INDEX IF NOT EXISTS idx_fault_events_processed ON fault_events (processedTelemetryId);
```

**3.3.1 Negative examples.** A rule engine only ever produces `fault_events` rows for windows
it flagged — Tier 2 would otherwise train on zero confirmed-normal examples and have no
actual decision boundary to learn. Add a periodic sample, gated by two required conditions:
  1. `dominantStatus = 'RUNNING'` and no triggered rules on the current window (unchanged), AND
  2. **no open `FLAGGED` event exists at sample time** (see §3.3.2 for "open") — a fault that
     transiently clears for one window is still inside its fault period, and banking a
     `NEGATIVE_SAMPLE` there would plant a mislabeled row inside real fault data. This check
     runs in the response handler, after Tier 1's verdict is known, not at ingest time.

Cadence: env-configurable (`PDM_NEGATIVE_SAMPLE_RATE`, default 1-in-60, i.e. roughly one
per hour at the 60-second window cadence) rather than hardcoded, so §5.7's verification step
and any future tuning don't require a code change. The counter is in-process (reset on
restart) — acceptable for this phase since under-sampling by a few windows after a restart
has no correctness impact, only a minor density one; note this explicitly rather than silently
relying on it.

**Sampling scheme — ship simple, upgrade later.** V1 is plain time-uniform sampling per the
cadence above — that alone already solves the "zero negative examples" problem, which is the
actual blocker for eventually training Tier 2, and is enough to unblock this plan's DoD.

**Checked against the actual simulator, not a hypothetical.** `node-red/flow.json`'s
`gen_reading` function (the only telemetry source this system currently has) drives every
metric off a single scalar `load`, mean-reverting toward one fixed `loadTarget = 0.5` for the
entire duration of `RUNNING` — there is no persistent high-flow/low-flow regime split in this
generator for time-uniform sampling to under-represent; that concern, as originally stated,
was targeting a distinction this data source doesn't produce. The one real transient regime it
does have is the ramp-up after a `STOPPED` episode ends (`loadTarget` drops to `0.02` during
`STOPPED`, then reverts back to `0.5` at `loadSpeed = 0.06`/tick — roughly a one-minute climb
once `RUNNING` resumes, driven by `state.regimeTicksLeft`/`state.regime` in `gen_reading`).
Time-uniform sampling does capture this transient, just proportionally to how rarely it
occurs rather than deliberately oversampled — acceptable for v1, since deliberately
oversampling it would require tracking "windows since last STOPPED," not a flow/RPM bucket.

**If regime-aware sampling is ever built, key it off "windows since last STOPPED,"** — the
real transient this generator (and the pipeline's own `dominantStatus` field) already expose
— **not a static flow/RPM range**, which was the original proposal and would target a
regime this simulator doesn't have. This is a statement about the current simulator, not a
permanent claim: real operational data may expose genuinely distinct setpoints (e.g. two
different demand profiles a real plant runs at different times) that this simulator doesn't
model, so the bucketing question should be re-asked against real telemetry once it exists,
not assumed closed. Track this as a documented near-term follow-up, not a requirement of
this plan's Definition of Done.

`pdmService.js` banks the `NEGATIVE_SAMPLE` row with the same `featureSnapshot` capture as a
real flag (§3.3's fixed composition — full `precapFeaturesByMetric` + full `metricStats`,
not conditioned on `eventType`), skipping the HITL review fields entirely. This is cheap to
add now and, like the feature snapshot itself, effectively impossible to backfill later.

A negative-sample DB write failure must be caught inside `faultEventService.js`'s
negative-sample path the same way the scoring POST's rejection is caught (§3.4) — it must
never propagate up and affect ingestion.

**3.3.2 Event coalescing.** Without dedup, a single fault spanning multiple consecutive
windows (e.g. a 30-minute fault = 30 closed windows) produces 30 separate `PENDING_REVIEW`
rows instead of one. "Open" is defined precisely, not just as `status = 'PENDING_REVIEW'`:
a `PENDING_REVIEW` row is only eligible to extend if its `lastSeenWindowEnd` (bumped on every
extension) is within a bounded lookback of the current window (e.g. 3 consecutive windows / 3
minutes at the 60-second cadence — a fault that clears for longer than this is treated as
resolved, and a later re-trigger opens a *new* row, even if the old one is still sitting
unreviewed). Without this bound, a fault reviewed a week late would silently absorb every
unrelated flag raised in between.

"Same trigger condition" means: the new window's `triggeredRules` set and the open row's
`triggeredRules` set share at least one rule on the same metric — not any-overlap across
unrelated metrics, which would wrongly merge two independent multi-metric faults into one row.

**On the "atomic statement" requirement below.** Under the current stack — synchronous
`better-sqlite3`, single-threaded Node — two overlapping `/score` responses cannot actually
interleave mid-check as long as the "find an open row, then extend-or-insert" logic runs as
one function with no `await` between the read and the write; JS does not preempt a synchronous
block. So the specific race this section guards against isn't live today in quite the way
"responses can return out of order and race" implies on its own. The real exposure is
narrower but still worth closing: (a) it's an easy, easy-to-miss mistake to later add an
innocuous `await` between the check and the write (e.g. for logging, or a follow-up query)
and silently reintroduce the race, and (b) if the TimescaleDB migration (see §7) lands and
this table's queries become async, the exact same interleaving hazard the ingestion mutex was
built to prevent (see that plan's §4.5) applies here too. Using a single atomic
`UPDATE ... WHERE <open-row condition> RETURNING id`-then-`INSERT`-if-zero-rows statement
costs nothing extra today and removes the failure mode in both cases — keep it as the
implementation, just understand it as future-proofing plus defense against an accidental
future `await`, not a fix for an active race in the current synchronous setup.

Before creating a new `fault_events` row, `pdmService.js`/`faultEventService.js` extend the
matching open row's `faultEnd`/`triggerWindowEnd`/`lastSeenWindowEnd` instead of inserting a
new one. A new row is only created when no such open event exists per the definition above.

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

Add this table in `schema.sql`, following the file's existing style. **No `db.js` ALTER TABLE
work is needed for `fault_events` itself.** `db.js` runs the entire `schema.sql` — including
`CREATE TABLE IF NOT EXISTS` — on every boot; the great majority of the `ALTER TABLE` blocks
elsewhere in that file exist only to add a *column* to a table that already existed before the
column did (one block does a full table rebuild for a NOT-NULL-drop case, `db.js:141-175`, but
that's a different, unrelated migration and not a pattern `fault_events` needs). `fault_events`
is an entirely new table, so `CREATE TABLE IF NOT EXISTS` alone already handles both a fresh
`data.db` and an existing one with no further work.

**One real `db.js` change IS needed: FK enforcement.** `processedTelemetryId REFERENCES
processed_telemetry(id)` is the first foreign key in this schema — `processed_telemetry` and
`raw_telemetry` are deliberately joined by time-range today, not FK, per that table's own
comment in `schema.sql`. better-sqlite3 does not enable FK enforcement by default, and `db.js`
never runs `PRAGMA foreign_keys = ON` — so as written, the `REFERENCES` clause is
**documentation only**; nothing stops a bug from inserting an orphaned `processedTelemetryId`.
Add `db.pragma('foreign_keys = ON')` in `db.js` alongside the existing `journal_mode = WAL`
pragma (§4.1 work item), and confirm during implementation that no existing code path deletes
or renumbers `processed_telemetry` rows in a way this would newly reject. If enabling it turns
out to be riskier than expected once other tables are considered, the fallback is to state
explicitly in this section that the FK is advisory/documentation-only — but default to turning
it on rather than leaving the claim in §3.3's comment silently false.

### 3.4 The Node ↔ Python HTTP boundary

**Payload shape — this is load-bearing, get it right.** `saveAndTrigger()` calls
`forecastOnNewRecord(data)`, `driftOnNewRecord(data)`, and `trendOnNewRecord(data)` with
`data` — the **flat, pre-insert object** (the same shape `pipeline.js` builds and
`processedController.js`'s manual POST path passes straight through as `req.body`; see that
controller's own comment: "req.body is already flat... same flat shape forecastService/
driftService read"). It is *not* the nested `rowToProcessed()` shape (`metrics.flowRate.mean`,
etc.) — that nested shape only exists on read, built from a DB row, and critically has no
`id` field, since it's constructed before the insert's `RETURNING`/`lastInsertRowid` exists.

`fault_events.processedTelemetryId` needs a real row id, which the flat pre-insert `data`
object doesn't carry (it's built before the insert's `lastInsertRowid` exists) — but the
`/score` POST body (§3.5) must stay the **flat** shape, same as forecast/drift/trend's `data`.
`saveProcessedReading()`'s return value (`record`, the `rowToProcessed()` **nested** shape) has
`id` but not the flat fields — passing `record` alone to `pdmOnNewRecord` and then trying to
build the flat POST body from it doesn't work; the nested and flat shapes aren't
interconvertible without re-flattening logic this plan doesn't otherwise need.

Resolution: `pdmOnNewRecord` receives **both** pieces explicitly, not one object doing double
duty — `pdmOnNewRecord(data, record.id)`. `data` is exactly what forecast/drift/trend already
receive (flat, used verbatim as the `/score` POST body — no shape drift from the other three
services' contract), and `record.id` is the one extra piece of information PdM alone needs, for
`processedTelemetryId`. This keeps "what gets POSTed to Python" and "what gets written to
`fault_events`" each sourced from an unambiguous single place, rather than one nested object
that has to be partially read one way and partially another.

`pdmService.js` gets added to `processedService.saveAndTrigger()` as a fourth call in the
same try/catch-isolated pattern already used for the other three — a PdM scoring failure
must never block or slow ingestion, exactly like a forecast/drift/trend failure doesn't
today:

```js
// processedService.js — saveAndTrigger(), alongside the existing three
try {
  pdmOnNewRecord(data, record.id); // data: flat, same shape the other three get; record.id: the
                                    // one extra value PdM needs, for fault_events.processedTelemetryId
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

with a short timeout (e.g. 2s). **The `try/catch` above only guards a synchronous throw —
it does not catch a rejected promise from an async fire-and-forget call.** `pdmService.js`'s
own async POST must attach its own `.catch()` (or the calling function must `await` it inside
its own try/catch) so a network failure or timeout becomes a logged error, not an unhandled
promise rejection — this is exactly the failure mode §5.6's "PdM service is fully down" test
is meant to exercise, and an unhandled rejection would make that test pass for the wrong
reason (Node not crashing) while masking a real bug. On a successful response, `pdmService.js`
persists a `fault_events` row itself (Node owns all DB writes; Python never touches SQLite
directly, per the already-settled boundary) only when the response is `flagged: true` — see
§3.3.1 for the separate negative-sampling path, and §3.3.2 for coalescing against an
already-open event before inserting a new row.

### 3.5 Python service shape

FastAPI, loaded once at container startup (no per-request import/reload):

- `POST /score` — body: the **flat pre-insert `processedRecord` shape** (see §3.4 — this is
  `data`/the object `pipeline.js` builds, e.g. `flowRateMean`, `dominantStatus`, flat fields —
  not the nested `rowToProcessed()` API-response shape). Mirror it via a Pydantic model in
  `schemas.py`, which doubles as a schema contract that will loudly fail validation if Node's
  shape drifts from what Python expects, rather than silently misreading fields.
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
GET  /api/pdm/fault-events/stats                      # confidence/status agreement breakdown (below)
```

**`GET /api/pdm/fault-events/stats`.** §3.2 says HITL-outcome agreement with Tier 1's own
`confidence` should be tracked as a retuning signal — without a concrete endpoint that intent
doesn't happen. This is a trivial `GROUP BY confidence, status` over `eventType = 'FLAGGED'`
rows (e.g. `{ confidence: "HIGH", CONFIRMED: 12, REJECTED: 1 }` per confidence level), owned by
`faultEventService.js`/`faultEventModel.js` like the other HITL endpoints. Not a dashboard —
just the raw counts; a UI on top of it is out of scope per §1.

`PATCH` with `status: 'CONFIRMED'` and a `faultEnd` is what finalizes `bufferEnd` (=
`faultEnd` + 1 hour) — until then the buffer's trailing edge is genuinely unknown, since the
fault isn't resolved yet.

---

## 4. Work items

### 4.1 Database
- Add `fault_events` to `schema.sql` (§3.3), including the `NEGATIVE_SAMPLE` `eventType`,
  `featureSnapshot` (fixed composition, §3.3), `thresholdsVersion`, `lastSeenWindowEnd`
  (§3.3.2), and `processedTelemetryId` FK.
- `db.js`: add `db.pragma('foreign_keys = ON')` so the FK is actually enforced, not just
  documentation (§3.3's note) — verify no existing delete/renumber path breaks under it.
- `faultEventModel.js` — prepared statements: insert (flag and negative-sample variants), an
  **atomic** find-open-and-extend-or-none statement for coalescing (§3.3.2 — single statement,
  not select-then-branch, per that section's note on why this is future-proofing rather than
  fixing an active race today), list-by-status, get-by-id, update (HITL patch), the
  confidence/status aggregate query (§3.6's `/stats`), and the buffer-range query against
  `raw_telemetry`.

### 4.2 Node service layer
- `faultEventService.js` — sits between `pdmController.js`/`pdmService.js` and
  `faultEventModel.js`, matching this repo's controller→service→model layering (every other
  controller calls a service, never a model directly). Owns: creating a flagged event (calling
  the model's atomic coalescing statement), creating a negative sample (gated by the two
  conditions in §3.3.1, including "no open FLAGGED event"), applying a HITL review patch, and
  the `/stats` aggregate.
- `pdmService.js`: `onNewProcessedRecord(data, processedTelemetryId)` (§3.4 — takes the flat
  `data` used verbatim as the `/score` POST body, plus the insert's `id` separately, not one
  object serving both purposes), the fire-and-forget POST via global `fetch` with
  `AbortSignal.timeout(2000)` (Node ≥18 required — record this in `server/package.json`'s
  `engines` field) and its own `.catch()` (§3.4), the periodic negative-sample trigger
  (§3.3.1, cadence from `PDM_NEGATIVE_SAMPLE_RATE`), and calls into `faultEventService.js`
  rather than `faultEventModel.js` directly.
- Wire it into `processedService.saveAndTrigger()` (§3.4).
- `pdmController.js` + routes for the four HITL endpoints (§3.6, including `/stats`), calling
  `faultEventService.js`.
- `.env.example`: add `PDM_SERVICE_URL=http://localhost:8000` and
  `PDM_NEGATIVE_SAMPLE_RATE=60`.

### 4.3 Python service
- `pdm/app/schemas.py` — Pydantic models mirroring `processedRecord`.
- `pdm/app/thresholds.yaml` — initial values ported from `config.js`/`validation.js`,
  labeled as provisional, plus a top-level `version:` string (e.g. `"1"`) bumped manually on
  every retune — this is what `thresholdsVersion` on `fault_events` rows is read from (§3.3).
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
- `docker-compose.backend.yml` and the root `.env.example` also need `PDM_SERVICE_URL` wired
  in — that compose file is the actual deployment target once PdM runs on its own CT (per
  §1's note), so the split-CT case needs this env var set explicitly, not just the combined
  local-dev file.

### 4.5 Tests

**No Node test infrastructure exists yet.** `server/scripts/tests/` currently holds exactly
two files (`aggregation.dominantFaultType.test.mjs` and its integration counterpart), run
directly via `node --test <file>` — there's no `npm test` script in `package.json`, no test
runner config, and no HTTP-integration test pattern (spinning up the Express app + hitting
routes) anywhere in the repo yet. The items below are not "add a test to the existing suite"
— they require standing up that pattern first (likely `node:test` + `supertest` or a
lightweight `createApp()` + real HTTP calls, matching the "no framework unless needed" style
the rest of the backend follows). Scope this explicitly rather than assuming it exists.

- `rules.py` unit tests (Python side, §4.3).
- A Node integration test: POST a `processedRecord` that should trigger a rule (e.g.
  vibration rate-of-change past threshold), confirm a `fault_events` row is created with
  `status = PENDING_REVIEW`, `eventType = FLAGGED`, a non-null `featureSnapshot` matching the
  fixed composition in §3.3, and the correct `processedTelemetryId`.
- A coalescing test: two consecutive triggering windows for the same rule produce one
  `fault_events` row with an extended `triggerWindowEnd`/`lastSeenWindowEnd`, not two rows
  (§3.3.2); a third triggering window arriving *after* the lookback bound opens a new row
  instead of extending the stale one.
- A negative-sample suppression test: force a rule violation, then force a window that would
  otherwise qualify as a negative sample while the event is still open (§3.3.1) — confirm no
  `NEGATIVE_SAMPLE` row is created until the event closes.
- A Node test confirming `saveAndTrigger()` still returns successfully and stores the
  processed record even when `PDM_SERVICE_URL` is unreachable, and that the rejected fetch
  promise is caught rather than becoming an unhandled rejection (§3.4).
- A `/stats` test: seed a few CONFIRMED/REJECTED rows at different `confidence` levels,
  confirm the aggregate counts match (§3.6).
- Add an `npm test` script (or equivalent) to `server/package.json` if standing up this
  infrastructure, so `npm test` becomes the one command that runs everything — currently
  there is none.

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
   dependency, not just a slow one. Also confirm no unhandled promise rejection appears in
   the backend's logs/process during this step (§3.4).
7. Confirm a periodic `NEGATIVE_SAMPLE` row appears during normal (non-fault) simulator
   operation, with a populated `featureSnapshot` and no HITL fields set (§3.3.1). Confirm no
   `NEGATIVE_SAMPLE` row appears while a `fault_events` row is open (§3.3.1's suppression rule).
8. Force two triggering windows in a row and confirm one `fault_events` row, not two
   (§3.3.2); wait past the coalescing lookback bound and force a third — confirm it opens a
   new row rather than extending the stale one.
9. `PATCH` several events to CONFIRMED/REJECTED at different `confidence` levels, then
   `GET /api/pdm/fault-events/stats` and confirm the counts match (§3.6).

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| PdM scoring call blocks or slows ingestion | High | Fire-and-forget, short timeout, try/catch-isolated (§3.4); verified explicitly in §5.6 |
| Python service becomes a second DB writer | High | Never given DB credentials; only ever sees HTTP payloads (§3.4, already an existing decision) |
| Unhandled promise rejection from the async POST crashes/degrades the process | High | `.catch()` on the fire-and-forget call itself, not just the outer sync try/catch (§3.4); explicitly tested (§5.6) |
| `fault_events` feature vector can't be reconstructed later if `precapFeatures.js` or thresholds change before Tier 2 is trained | High | `featureSnapshot` + `thresholdsVersion` captured at flag time, not derived later (§3.3) |
| No confirmed-normal examples for future Tier 2 training | High | Periodic `NEGATIVE_SAMPLE` rows banked alongside flags (§3.3.1) |
| `rateOfChangeMax` seeded from an instantaneous ceiling never fires against a windowed mean | High | Explicit derivation documented and tuned against known-fault windows, not a raw constant copy (§3.1.1) |
| A single multi-window fault produces one `fault_events` row per window instead of one | Medium | Coalescing check against an already-open event before insert (§3.3.2) |
| Reviewer anchors on Tier 1's own confidence score, laundering its bias into HITL labels | Medium | Don't surface `confidence` prominently in the future review UI (§3.2) |
| Thresholds are guesses, not validated against real fault data | Medium — expected at this stage | Explicitly labeled provisional in `thresholds.yaml`; HITL-confirmed/rejected events are the feedback loop that should retune them over time |
| `processedRecord` shape drifts between Node and Python over time | Medium | Pydantic schema in `schemas.py` fails loudly on a mismatch instead of silently misreading fields |
| `pdmController.js` calls `faultEventModel.js` directly, breaking this repo's controller→service→model layering | Low | `faultEventService.js` added as the missing layer (§4.2) |
| `processedTelemetryId` FK is unenforced (better-sqlite3 defaults FK checks off, `db.js` never turns them on) | Medium | `db.pragma('foreign_keys = ON')` added explicitly (§4.1) |
| An accidental future `await` between coalescing's read and write reintroduces a race; the same interleaving hazard applies if the TimescaleDB migration lands and this table's queries become async | Low today, Medium if the DB later goes async | Atomic find-open-and-extend-or-insert statement written from the start, not select-then-branch (§3.3.2) |
| Coalescing has no staleness bound; a fault left unreviewed absorbs unrelated later flags | Medium | Bounded lookback (e.g. 3 windows) before treating a fault as resolved (§3.3.2) |
| A `NEGATIVE_SAMPLE` row gets banked inside a fault that transiently clears for one window | Medium | Sampling suppressed while any `FLAGGED` event is open (§3.3.1) |
| `featureSnapshot` composition differs between FLAGGED and NEGATIVE_SAMPLE rows, giving Tier 2 inconsistent feature dimensionality across classes | Medium | Fixed, eventType-independent composition specified explicitly (§3.3) |
| HITL-agreement tracking (§3.2) stays a stated intention with no endpoint, so it silently never gets built | Medium | `GET /api/pdm/fault-events/stats` added as a concrete deliverable (§3.6, §4.2, DoD) |
| Negative sampling is time-uniform | None against the current simulator — verified no persistent flow/RPM regime split exists in `gen_reading` to under-sample (§3.3.1); revisit if real operational data exposes distinct setpoints the simulator doesn't model | Time-uniform sampling ships for v1; regime-bucketed sampling (keyed off windows-since-STOPPED, not a static flow/RPM bucket) tracked as a documented follow-up, not a DoD requirement (§3.3.1, §9) |
| CSV buffer files re-proliferate as an ad hoc habit despite the DB-first design | Low | Buffers are DB time-range queries by default; CSV export is an explicit, on-demand endpoint, not the storage mechanism |
| No auth on HITL write endpoints, no kill switch on the rule engine | Low — accepted for now | Internal-only tool at this stage; revisit before any external/production exposure |

---

## 7. Interaction with the TimescaleDB migration, if both are in flight

These two plans don't depend on each other, but if PdM lands first and the Postgres
migration happens afterward: `fault_events` needs to be included in the Postgres
`001_init.sql` port (`docs/plan/2026-08-04-timescaledb-migration.md` §4.2), since it will
exist in SQLite by then and that migration's stated scope was "only the two existing
tables" at the time it was written — that scope note should be revisited to include
`fault_events` if this plan has already merged. Also revisit §3.3.2's coalescing statement at
that point — its atomicity guarantee currently rests on synchronous `better-sqlite3` plus
single-threaded Node (see that section's note); an async Postgres driver reintroduces the same
class of interleaving hazard the TimescaleDB plan's §4.5 ingestion mutex already exists to
prevent, and the coalescing statement should be re-verified against that migration's async
rewrite rather than assumed to still be safe unchanged. No other interaction — `pdmService.js`'s
Node-side queries go through the same models/services layer the Postgres migration already
rewrites, so nothing else PdM-specific needs special handling in that plan beyond these two
notes.

---

## 8. Definition of done

- [ ] `fault_events` table exists via `schema.sql` alone (no `db.js` ALTER TABLE work needed for the table itself)
- [ ] `db.js` runs `PRAGMA foreign_keys = ON`; `processedTelemetryId` is actually enforced, not just documentation (§3.3, §4.1)
- [ ] `faultEventService.js` exists; `pdmController.js` never calls `faultEventModel.js` directly
- [ ] `pdmService.js` receives `(data, processedTelemetryId)` — flat POST body and the FK id sourced unambiguously, not one nested object read two ways (§3.4)
- [ ] `pdmService.js` wired into `saveAndTrigger()`, fire-and-forget, never blocks ingestion
- [ ] The fire-and-forget POST has its own `.catch()` — no unhandled rejection under a fully-down PdM service (§5.6)
- [ ] Backend survives the PdM service being fully down (§5.6)
- [ ] Tier 1 rule engine flags a forced violation with correct `triggeredRules`/`confidence`,
      and the `fault_events` row's `processedTelemetryId` correctly references the triggering window
- [ ] `featureSnapshot` (fixed composition, identical across eventTypes) and `thresholdsVersion`
      (read from `thresholds.yaml`'s `version:` field) are captured on every flagged and negative-sample row
- [ ] Periodic `NEGATIVE_SAMPLE` rows are created during normal operation (time-uniform for v1)
      and suppressed while any event is open (§3.3.1, §5.7)
- [ ] A multi-window fault coalesces into one row via an atomic statement, not a racy
      select-then-branch, and a stale fault beyond the lookback bound opens a new row instead
      of extending it (§3.3.2)
- [ ] `GET /api/pdm/fault-events/stats` returns confidence/status agreement counts (§3.6)
- [ ] HITL endpoints: list, get, confirm/reject/annotate all working
- [ ] Buffer range query returns the correct hour-before/fault/hour-after span
- [ ] Thresholds live in one configurable file, labeled provisional, with an explicit and
      documented derivation from the Node-side constants (not a direct copy — §3.1.1), and a
      `version:` field for `thresholdsVersion` to reference
- [ ] `pdm/` container builds and runs via `docker-compose.pdm.yml`
- [ ] `PDM_SERVICE_URL` and `PDM_NEGATIVE_SAMPLE_RATE` wired into `docker-compose.backend.yml`
      and the root `.env.example`, not just the combined local-dev compose file
- [ ] Node test infrastructure stood up (`npm test` runs something); rule-trigger, coalescing
      (including the stale-fault/new-row case), negative-sample suppression, PdM-service-down,
      and `/stats` tests all pass
- [ ] Python unit tests for `rules.py` pass
- [ ] No PdM code reads or writes SQLite directly from Python

---

## 9. Deferred: regime-bucketed negative sampling

Not required against the current simulator — verified against `node-red/flow.json`'s
`gen_reading`, which drives `RUNNING` telemetry off a single mean-reverting `load` scalar
with one fixed target, i.e. no persistent high/low-flow regime split exists in this data
source to under-sample (§3.3.1). If revisited later, key it off "windows since the last
`STOPPED` episode" (the one real transient this generator has, via `dominantStatus`), not a
static `flowRateMean`/`rpmMean` bucket. Re-open this question once real operational
telemetry exists — it may expose genuinely distinct operating setpoints the simulator
doesn't model. Not required for this plan's Definition of Done.
