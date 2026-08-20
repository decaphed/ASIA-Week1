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
  returns the rule-engine verdict only. **§10 (added later) starts sketching what eventual
  Tier 2 training looks like — still discussion-only, not committed, doesn't change this
  bullet's status today.**
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
  "windowEnd": "2026-08-05T10:14:00.000Z",
  "thresholdsVersion": "1"
}
```

**`thresholdsVersion` must be in this response.** `fault_events.thresholdsVersion` (§3.3) is
sourced from `thresholds.yaml`'s `version:` field, which only Python ever reads — Node owns
the `fault_events` write (§3.4) but has no other way to learn which thresholds revision was
active for this verdict. `rules.evaluate()` (§3.5) must read the loaded `version:` value and
include it on every response, flagged or not, and `schemas.py`'s response Pydantic model must
declare it as a required field — without this, the column in §3.3's schema and the DoD line
that depends on it are unsatisfiable.

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
  -- NEGATIVE_SAMPLE rows, which don't go through review. The default only
  -- applies to FLAGGED inserts (§4.1's model insert must explicitly pass
  -- status = 'N/A' for the negative-sample variant) — a NOT NULL column with
  -- a PENDING_REVIEW default would otherwise put every negative sample into
  -- the HITL review queue, since the default fires whenever an insert
  -- doesn't specify the column, and nothing else prevents that.
  status                TEXT NOT NULL DEFAULT 'PENDING_REVIEW', -- PENDING_REVIEW | CONFIRMED | REJECTED | N/A (NEGATIVE_SAMPLE rows only)
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

Because `NEGATIVE_SAMPLE` rows get `status = 'N/A'`, never `'PENDING_REVIEW'` (§3.3's status
column note), the `<open-row condition>` below — keyed on `status = 'PENDING_REVIEW'` — can
never match a negative-sample row by construction; no separate `eventType = 'FLAGGED'` filter
is needed on top of the status check for this to be correct, but write the condition as
`status = 'PENDING_REVIEW'` explicitly rather than `eventType = 'FLAGGED'`, since status is
what actually encodes "still open."

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

---

## 10. [Addendum — discussion only, not committed] Tier 2 retraining via uploaded fault datasets, Python-owned

**Status: exploratory. Nothing below has a work-item breakdown, a DoD checklist entry, or an
implementation go-ahead. It captures a design conversation held after §1–§9 were written, once
"how does Tier 2 actually get retrained without drifting" became the live question. §1–§9
above are unchanged by this section.**

**Note on §0/§7's SQLite assumption:** §1–§9 were written when this repo still ran on
`better-sqlite3` and explicitly scoped themselves as independent of the (then-hypothetical)
TimescaleDB migration. That migration has since actually landed — `server/database/db.js` now
runs on `pg`/Postgres, and `fault_events` itself was ported in
`server/database/migrations/002_fault_events.up.sql`. This matters for §10.6 point 2 below:
several of the SQLite-specific constraints §3.4 originally reasoned from (single-writer model,
no safe second process) no longer apply the same way under Postgres.

### 10.1 The trigger for this section

The operator wants a manual escape hatch: upload a CSV of newly-observed fault data at any
time and have Tier 2 retrain on it, so the model doesn't go stale between whatever cadence
HITL naturally produces confirmed `fault_events`. Two decisions were made in discussion,
recorded here so they don't need re-litigating:

- **Retrain always trains from scratch on the full accumulated corpus, not an incremental
  fine-tune on just the new upload.** Fine-tuning-only risks catastrophic forgetting of older
  fault patterns — the whole point of this feature is to *prevent* drift, and training only on
  the newest data is itself a drift vector.
- **A retrained candidate is evaluated against a held-out set and compared to the currently
  live model before promotion — never auto-promoted.** A bad or mislabeled upload should
  degrade nothing until it's shown to actually help. See §10.5.
- **Model family stays Random Forest / XGBoost**, per the original scope in this doc's intro —
  not a sequence model. This resolves what was initially framed as a "will the model be
  confused by time gaps between faults" worry: see §10.2.

### 10.2 Why the time gap between buffers is a feature-computation concern, not a modeling one

Tier 2, as scoped, trains on **rows, not sequences** — one row per closed window, each row
already collapsed into the `featureSnapshot` shape this plan's §3.3 defined
(`precapFeaturesByMetric` + per-metric `metricStats`), with a label attached
(`faultType`/`status`, or "normal" for a `NEGATIVE_SAMPLE`). Random Forest/XGBoost consume a
shuffled bag of these rows — there is no notion of "the row before this one" unless a feature
is explicitly engineered to carry it, which nothing here does. A row from a March bearing
fault and a row from a July cavitation fault sit next to each other in the training set with
no more consequence than two unrelated patients' unrelated lab results sitting next to each
other in a medical dataset. **The model itself cannot be confused by a time gap between
buffers under this design.**

The gap only matters one step upstream, during **feature computation** — i.e. before a row
becomes a training example. Any rolling-window/rate-of-change/gap-fill computation run to
produce a window's features must never let its computation window span two different buffers'
worth of samples (this was the earlier `bufferId`-as-partition-key discussion). Once that
computation is done and each window has its finished, fixed-shape feature vector, the buffer
boundary has served its purpose and the model no longer needs to know about it. Concretely:
**`bufferId` (§10.3) partitions feature computation; it plays no role in how Random
Forest/XGBoost consumes the finished rows.**

If this ever moves to a sequence model (LSTM/Transformer/1D-CNN over raw samples) later, this
conclusion reverses — buffer boundaries would become load-bearing for training itself, not
just for feature computation, since a sequence model does learn from adjacency/order. Not a
concern today; flagged here so a future reader doesn't assume this section's reasoning still
holds if the model family ever changes.

### 10.3 `bufferId` already exists — it's `fault_events.id`

No new ID concept is needed. §3.3's schema already gives every buffer (fault period + 1h
before + 1h after) a stable identity: `fault_events.id`, with `bufferStart`/`bufferEnd`
delimiting its extent and `featureSnapshot` already computed per triggering window within it.
For **internally-sourced** training examples (Tier 1 flags confirmed by HITL, plus
`NEGATIVE_SAMPLE` rows), `fault_events.id` is the partition key feature computation already
respects by construction — each row's `featureSnapshot` was computed from exactly one window,
never spanning across a `fault_events` boundary, because `precapFeatures.js` operates on one
closed window at a time regardless.

The open question is what identity an **externally-uploaded** buffer gets (§10.4) — it has no
natural `fault_events.id` unless the upload process is defined to create one.

### 10.4 Resolved: raw sensor readings, Node keeps feature computation — and two separate entry points

**Decided in discussion:** uploaded "new fault data" is raw sensor readings (the same
6-metric-plus-status shape as `raw_telemetry`), not pre-aggregated features. Node stays the
sole owner of feature computation (`precapFeatures.js`/`aggregateWindow`/`computeQuality`) —
the same code already used for Tier 1, per §3.1's "don't recompute what Node already
produces" reasoning. Python's ML ownership is training and evaluation on the finished,
fixed-shape feature rows, not feature engineering itself. This resolves the "collides with
Python-only" tension from the original framing of this question: feature engineering was
arguably never an ML concern here anyway, since Tier 1's rules consume the exact same
pipeline output.

**Follow-up discussion surfaced that "new fault data" actually splits into two materially
different cases, which should be built as two separate entry points into the same corpus
rather than one upload feature trying to cover both:**

**Entry point 1 — a fault already sitting in `raw_telemetry`, just never flagged or reviewed.**
The pump was already running under this system's own ingest when the fault happened; Tier 1
either missed it or wasn't tuned to catch it, or it simply never went through HITL. This data
has *already* been validated once, at original ingest time (`validator.js`'s physics checks,
`missing.js`'s gap-fill, `outlier.js`'s capping already ran on it). Re-uploading it as a CSV
would mean re-parsing and re-validating data this system already trusts — wasted work and a
second, redundant path next to something §3.3 already solved. Instead, this should be a
**manual buffer entry** on top of the existing HITL/`fault_events` flow: an operator specifies
a time range (or the system already has an unreviewed candidate sitting around), a
`fault_events` row is created/confirmed over that range using the exact `SELECT * FROM
raw_telemetry WHERE timestamp BETWEEN :bufferStart AND :bufferEnd` reconstruction §3.3 already
defines, and feature computation runs against already-stored, already-trusted data. No file
upload, no untrusted-content scanning needed for this path at all.

**Status: implemented and live-verified** (backend/API only, per §1's UI scoping — no
screen was built). `POST /api/pdm/fault-events/manual-buffer`, gated on the same
`requireTrustedProxy` + `requireGroup(PDM_REVIEWER_GROUP)` boundary as the PATCH-confirm
endpoint, plus a mandatory `notes` justification field (a deliberate escalation over the PATCH
endpoint's optional `notes` — this action skips HITL review entirely, so the audit trail is
the only check left). Migration `004_fault_events_source_type.sql` added the `sourceType`
column (`TIER1_FLAGGED | NEGATIVE_SAMPLE | MANUAL_BUFFER | EXTERNAL_UPLOAD`) this paragraph's
provenance tagging needed. `faultEventService.js::createManualBufferEvent` resolves the
trigger window via an existing `processed_telemetry` row when one covers the range (Path A) or
reconstructs one through the same `POST /process-window` call live ingest uses when it doesn't
(Path B — e.g. `pdm` was down at the time), persisting via `saveProcessedReading` rather than
`saveAndTrigger` so a historical backfill doesn't re-fire forecast/drift/trend. A pre-write
overlap check against existing `fault_events` rows (409) and a resolved-window bounds check
against `[faultStart, faultEnd]` (400) guard against corrupting the corpus with a duplicate or
semantically-wrong entry — `processedTelemetryId` still has no enforced FK (§3.3's original
note), so these are the only things standing between a query bug and a silently-wrong row.
Tested: `server/scripts/tests/pdmManualBufferValidation.test.mjs` (13 cases, pure validation)
and `server/scripts/tests/faultEventService.manualBuffer.test.mjs` (5 cases, mocked model
layer — Path A, Path B, 409/422/400) both pass; a live smoke test against a real Postgres +
`pdm` stack (migration applied, real HTTP request through the running backend) also passed.

**Entry point 2 — genuinely external data.** A fault from before this system was deployed,
from a different site, captured by another tool, anything that never passed through this
system's own ingest. This has never been validated by anything, so it needs the real
scan/clean/preprocess/gate pipeline from the earlier upload-gate discussion — Node parses and
validates the CSV, runs it through the same feature computation, and only the finished feature
rows (in the identical fixed shape entry point 1 and live Tier 1 both produce) are eligible to
join the training corpus.

Both entry points should land in the same corpus (§10.5), each row tagged with its
provenance (`sourceType: TIER1_FLAGGED | MANUAL_BUFFER | EXTERNAL_UPLOAD`) so a bad
contribution from either path can be traced and excluded without touching the other.

**Resolved: neither entry point goes through HITL's `PENDING_REVIEW` gate.** §3.2's "never
fabricate confidence it doesn't have" reasoning is *why* Tier 1's automated flags need a human
reviewer — the rule engine isn't a trustworthy source of ground truth on its own. Entry points
1 and 2 are the opposite case: a human domain expert is directly asserting "this is a
[faultType] fault, here is the buffer," not an automated system's guess. Requiring a *second*
human to redundantly confirm the first human's assertion has little of the same safety value,
so `MANUAL_BUFFER` and `EXTERNAL_UPLOAD` rows are created with `status = 'CONFIRMED'`
immediately, `faultType`/`rootCause`/etc. supplied directly by the submitting operator at
creation time rather than filled in later by a reviewer. `PENDING_REVIEW` stays exclusively
for Tier 1's automated `FLAGGED` rows, where a genuine second opinion is the point.

This does **not** remove the statistical validation gate from the original upload-gate
discussion (excessive imputation, excessive outlier-capping, structural checks, etc.) — that
gate checks data *hygiene* ("is this a clean, well-formed buffer"), which is an orthogonal
question to "did a human confirm this is really a fault," and applies to both entry points
regardless of the HITL decision above.

### 10.4.1 Column mapping for external uploads (Entry point 2 only)

**Status: implemented.** Backend/API only, per §1's UI scoping — the mapping *screen* stays out
of scope, only the endpoints a future screen would call. Design went through the same
code-architect → ecc:code-reviewer pipeline as §10.4 Entry point 1 and §10.5, with explicit
attention to file-upload security (the first upload surface in this codebase). Decisions D10-D18:

- **D10:** an accepted upload never creates a `fault_events` row — `training_corpus`'s own
  schema comment already reserved `bufferId = "upload:<uploadId>:<windowIndex>"` with
  `faultEventId = NULL` for exactly this case (§10.5's D9). A new `external_uploads` table is
  the audit/metadata record instead; `fault_events`' one-snapshot shape doesn't fit a
  many-window upload.
- **D11 (resolves §10.6 item 3 — concrete numbers, not just "mechanism resolved"):** Stage C's
  composite `qualityScore` reject threshold is **< 70**, reusing `computeQuality`'s own
  existing GOOD≥90/FAIR≥70/POOR<70 banding rather than inventing a new number. Plus two
  floors, **`physicsPassRate ≥ 0.85`** and **`imputationRate ≤ 0.30`** — evaluated **per
  window**, not as a corpus-wide weighted mean (code-review HIGH finding, fixed before
  implementation: an aggregate-mean floor would let a batch of clean windows dilute a few
  genuinely bad ones into a passing average — exactly the gaming risk the composite score's own
  `AllSamplesInvalidError=0` handling already exists to prevent; the floors are supposed to be
  an independent backstop against that, so they can't be vulnerable to the same averaging).
- **D12:** external upload is the *only* path where quality is a hard accept/reject gate — live
  ingest and manual-buffer data were already validated once, at original capture, by this same
  pipeline; upload data never was.
- **D13:** vibration's unit list is `{mm/s, in/s}` — deliberately excludes `g` (acceleration),
  since converting to velocity needs the vibration frequency, which a scalar column can't supply.
- **D14 (known v1 limitation, explicit not silent):** Stage A requires a median inter-sample
  interval in `[0.5s, 5s]`. Stage C reuses `pdm/app/preprocessing/pipeline.py`'s
  `/process-window`, whose `missingRate` accounting is hardwired to `EXPECTED_SAMPLE_COUNT` at
  this system's own ~1Hz cadence — a materially slower-cadence historian export isn't supported
  without a resampling-aware Stage C mode this pass didn't build.
- **D15:** uploaded sample `status` is hardcoded `'RUNNING'` — no status-column mapping offered,
  staying within the 6-metric-only mapping scope.
- **D16:** a column >50% empty is auto-excluded from the Stage B mapping offer, not fatal to the
  whole file — only zero surviving non-timestamp columns fails Stage A outright.
- **D17:** `corpusMaterializationService.js::checkClassBalance` gained an `additionalCount`
  parameter (backward-compatible, verified against its two existing warn-mode callers) so the
  whole-corpus block-mode check can evaluate "if this upload's windows land" *before* any write,
  not write-then-detect-then-rollback.
- **D18 (security posture):** uploaded rows are staged in Postgres
  (`external_uploads."stagedRows"` JSONB) between the upload and confirm requests, not left on
  the container filesystem — the multer temp file is deleted in a `finally` block immediately
  after Stage A parsing, success or failure. `stagedRows` is cleared the moment an upload reaches
  any terminal state; `server/scripts/cleanupStaleUploads.js` purges anything abandoned in
  `AWAITING_MAPPING` past a TTL.

**File-upload security** (first such surface in this codebase — code-review flagged this for
elevated scrutiny): `multer`'s temp filename is **always** `crypto.randomUUID()` — never derived
from the client-supplied `originalname` (code-review HIGH finding, fixed: echoing a
client-controlled filename into a disk-storage path is the standard multer path-traversal
footgun; `originalname` is stored only as an audit metadata string, never used to construct a
filesystem path). `csv-parse` (RFC4180-correct, not a hand-rolled splitter) enforces a hard
row-count ceiling **mid-stream**, not after buffering the whole parse result — a file's on-disk
size limit (`PDM_UPLOAD_MAX_BYTES`) doesn't bound its parsed row count on its own. Extension +
MIME allowlist reject the obviously-wrong case before any bytes are parsed; real content
validation happens in Stage A against the actual parsed data.

**A gap closed during review, not originally in scope:** `EXTERNAL_UPLOAD` rows bypassing
`fault_events` entirely (D10) meant the existing `onFaultEventRejectedOrExcluded` retraction path
couldn't reach them — no undo mechanism existed for a mislabeled/fraudulent accepted upload.
Added `corpusMaterializationService.js::retractUpload(uploadId)` (deletes via the new
`corpusModel.js::deleteByUploadId`) as the `EXTERNAL_UPLOAD` equivalent.

**Files:** `server/database/migrations/006_external_uploads.sql`, `server/models/
externalUploadModel.js`, `server/utils/{externalUploadValidation,unitConversion,csvParse}.js`,
`server/middleware/uploadFile.js`, `server/services/externalUploadService.js`, `server/
controllers/externalUploadController.js`, `server/scripts/cleanupStaleUploads.js`. New deps:
`csv-parse`, `multer@2.x` (not 1.x — 1.x has known unpatched CVEs, checked via `npm audit`
before pinning). Endpoints: `POST /pdm/fault-events/external-upload` (Stage A, multipart),
`POST /pdm/fault-events/external-upload/:uploadId/confirm` (Stage B + C + materialization, JSON)
— same `requireTrustedProxy` + `requireGroup(PDM_REVIEWER_GROUP)` auth boundary as manual-buffer
and the HITL PATCH endpoint (§10.4's resolution: the human-trust model is identical across all
three CONFIRMED-creating paths; only the *data*-trust bar differs, enforced by Stage C).

**Tested:** 46 + 12 Node tests (`externalUploadValidation.test.mjs` — 15 Stage A/B pure-logic
cases; `unitConversion.test.mjs` — 10 conversion-math cases including D13's `g`-exclusion;
`externalUploadService.test.mjs` — 7 mocked-service cases, including the direct regression test
for the per-window-floor fix: a single bad window rejects the whole upload even when the
weighted-mean composite would have passed) plus the full existing suite, all green. No live-stack
integration test for this pass — same trust level manual-buffer and §10.5 had before their own
CT runs.

**Trigger for this subsection:** external candidate datasets evaluated during planning (a
diesel-engine CSV with `Engine_RPM`/`Lub_Oil_Pressure`/etc., and an anonymized 50-sensor pump
dataset with a `rul` column) both turned out to use different column names — and in one case,
no recoverable column identity at all — than this system's six metrics. Entry point 1 (manual
buffer over existing `raw_telemetry`, §10.4) never hits this problem, since that data is
already in this system's schema. Entry point 2 is the only path where an uploaded file's
column names won't match `flowRate/rpm/vibration/suctionPressure/dischargePressure/motorTemp`
out of the box, so mapping is scoped as part of Entry point 2's upload gate, not a separate
feature.

**Two-stage gate, resolved this way because physics-aware validation is impossible before
mapping — a range check against `pump-physics.yaml` needs to know a column *is*
`suctionPressure` before it can ask whether a value is a valid `suctionPressure` reading. So
the gate splits into what can be checked before mapping (structural/statistical hygiene, no
semantic knowledge required) and what can only be checked after (physical validity,
imputation, capping — all metric-specific).**

#### Stage A — structural gate, before the operator ever sees a mapping screen

Cheap, semantics-free checks that reject an obviously-unusable file before burdening the
operator with mapping it:

1. **Time-series precondition, checked first.** Confirm the file has a real timestamp column
   with regular-enough sampling to window. A file of independent snapshot rows with no time
   axis is rejected outright at this step — column mapping cannot manufacture a time axis that
   doesn't exist, and offering a mapping UI on a file that will fail this check wastes the
   operator's effort. This is the same defect that ruled out the diesel-engine CSV evaluated
   during planning: renaming its columns would not have fixed the missing time axis.
2. **Raw missing-value rate per column**, before any column has a known identity — a column
   that's mostly empty is a red flag regardless of what it turns out to represent. Reject
   above a threshold (concrete number still open, same status as item 3 below).
3. **Duplicate timestamp / duplicate row detection**, and a **minimum row count** floor — a
   file too short or too full of exact duplicates isn't worth mapping.

A file that fails Stage A never reaches the mapping screen at all.

#### Stage B — mapping (only reached once Stage A passes)

4. **Header extraction, mapped manually, not inferred.** Node parses the uploaded file's
   header row and presents the raw column names to the operator. The operator explicitly
   assigns each source column to one of the six known metrics, or marks it unused. No
   automatic name-similarity guessing (e.g. fuzzy-matching `Vbr` to `vibration`) — the mapping
   is only as trustworthy as the human asserting it, consistent with §10.4's reasoning that a
   domain expert is directly asserting ground truth for this entry point, not a second
   automated inference layer.
5. **Unmapped source columns are dropped, not guessed.** Any column the operator doesn't
   explicitly map is excluded from feature computation entirely — never silently folded in as
   an extra, uncalibrated dimension alongside the six metrics `precapFeaturesByMetric`/
   `metricStats` expect (§3.3's fixed composition). This is also why an anonymized-sensor file
   with no recoverable column identity (e.g. `sensor_00`...`sensor_51`, no data dictionary)
   fails this step for every column — an operator cannot honestly map a column they cannot
   identify, and a forced guess here is indistinguishable from fabricating a label.
6. **Unit declared and converted per mapped column, not inferred from the name match alone.**
   Each mapping also carries a declared source unit (from a short fixed list per metric — e.g.
   vibration in mm/s vs g, pressure in psi vs bar/kPa, temperature in °C vs °F). Node converts
   to this system's internal units at parse time, before feature computation. A correct name
   match with an unconverted unit mismatch is just as corrupting to the corpus as a wrong name
   match would be — both produce a `featureSnapshot` that doesn't mean what the rest of the
   corpus means by that field.
7. **Quick range sanity-check against `pump-physics.yaml`, immediately after mapping and unit
   conversion.** A fast, cheap pass over the mapped, converted values against the same
   `RANGES` `middleware/validateReading.js`/`validator.py` already use (§11.6.1) — this is a
   reasonableness check on the *mapping/unit choice itself*, not the full quality gate. Values
   wildly outside physically-reasoned bounds at this stage are a signal the mapping or declared
   unit is wrong, not that the source pump behaved impossibly — flagged back to the operator
   for re-confirmation before they move on, rather than waiting until Stage C to surface an
   obviously bad mapping.

#### Stage C — full physics-aware quality gate, after mapping is confirmed

This is where the operator's original ask lives: **reject the whole upload if too much of the
data is physically invalid, imputed, or capped, based on a quality score** — the thing that
was impossible before mapping (Stage A) but is now well-defined, because every column has a
known metric identity and unit.

8. **Run the mapped, converted data through the same preprocessing pipeline live ingest
   uses** — `pdm/app/preprocessing/missing.py` (gap-fill), `validator.py` (physics validity
   per sample), `outlier.py` (Hampel-filter capping), `quality.py` (`computeQuality`), per
   §11.6.2. Not a separate, upload-specific implementation — the exact same functions Tier 1
   scores live windows with, so an uploaded buffer's quality is measured on identical terms to
   what "clean data" already means everywhere else in this system.
9. **Compute an aggregate quality score for the file** from the same ingredients
   `computeQuality` already produces per window (physically-invalid rate, imputed-value rate,
   outlier-capped rate), rolled up across the whole upload rather than one 60-second window.
   **Reject the upload outright if the score falls below a threshold** — concrete numbers still
   open, this is what resolves §10.6 item 3 ("statistical rejection thresholds for an uploaded
   file... still need concrete numbers") as a real mechanism rather than a placeholder: the
   thresholds are stated in terms of the same physicsValid/imputed/capped rates
   `computeQuality` already tracks, not a new, upload-specific metric invented from scratch.
   A rejected file gets the score and the three underlying rates shown back to the operator, so
   "why was this rejected" is never a black box.
10. **Mapping-confidence tag persisted per column on the accepted upload's record.** Alongside
    the upload's existing `sourceType: EXTERNAL_UPLOAD` provenance (§10.4), store how each
    column was resolved — e.g. `EXACT_NAME_MATCH` (source header text already matched a known
    metric name/alias) vs `OPERATOR_OVERRIDE` (manually assigned, unverifiable from the name
    alone). A later investigation into a corpus-quality problem should be able to tell "this
    batch leaned on three operator overrides" apart from "this batch was self-evidently named,"
    without re-opening the original file.

**Not covered by this addendum:** the operator-facing form/screen for presenting extracted
headers and collecting the mapping. This subsection specifies the backend mechanism and
ordering only, consistent with §1's "no dashboard UI changes beyond what's needed" scoping for
the rest of this document.

### 10.5 Corpus, merge, and promotion

**Status: implemented.** Backend/data-pipeline infrastructure only (no UI, no Tier 2 model —
`pdm/app/model.py` stays a stub, deliberately, per this session's own priority order). Design
went through a code-architect blueprint, then an ecc:code-reviewer pass (software-engineering
soundness) and an ecc:mle-reviewer pass (ML-methodology soundness) in parallel, both against
the actual current schema — not the SQLite-era assumptions this section's original text below
still describes. The mle-reviewer pass returned a BLOCK verdict on the original sketch; three
HIGH-severity fixes were made before implementation, recorded here as decisions D1-D9:

- **D1 (§10.6 item 4, resolved):** label = `fault_events.faultType` for a `CONFIRMED` row
  (`TIER1_FLAGGED`/`MANUAL_BUFFER`/`EXTERNAL_UPLOAD`), or `'NORMAL'` for a `NEGATIVE_SAMPLE`
  row. `PENDING_REVIEW`/`REJECTED`/null-`faultType` rows are never materialized — status is
  eligibility, not label content. `'OTHER'` is a legitimate trainable label but is
  **structurally excluded from the promotion gate** (D8), not just optionally flaggable — a
  catch-all bucket is the worst combination of low-support and low-coherence for a per-class
  floor.
- **D2 (feature-recomputation, mle-review HIGH finding, fixed):** every window in a buffer is
  recomputed **uniformly** at materialization time — no "keep the trigger window's stored
  snapshot verbatim, recompute the rest" special case. Mixing a live-captured snapshot for one
  row with after-the-fact-recomputed snapshots for its buffer-mates was a silent intra-buffer
  feature-version skew risk (same physical event, different feature-code vintage, nothing to
  catch it). Every corpus row now carries its own `featureCodeVersion`
  (`processed_telemetry.preprocessingVersion`) so a discrepancy is at least detectable.
- **D3:** corpus lives in Postgres (`training_corpus`), Node-owned writes
  (`server/services/corpusMaterializationService.js`), Python reads via a read-only role
  (§10.6 item 2's already-settled resolution).
- **D4 (reproducibility, mle-review MEDIUM finding, fixed):** the content hash alone (computed
  at training kickoff) can't answer "what corpus produced this model" once `training_corpus`'s
  upsert-in-place rows have moved on — `training_runs.corpusRowManifest` now persists the exact
  `(bufferId, windowEnd, corpusRowVersion)` tuples the hash was computed over, not just the hash.
- **D5 (run/artifact metadata store):** originally sketched as Python's own SQLite store;
  code-reviewer flagged this as a second DB technology introduced for no real benefit once
  Python already needs a Postgres connection for D3's corpus read. **Changed to Postgres**
  (`training_runs` table, same migration as `training_corpus`) per explicit project-owner
  choice. Python still never writes it — `pdm/app/retrain.py` emits a JSON result to stdout;
  `server/scripts/recordTrainingRun.js` does the actual `INSERT`, keeping §3.4's "Python never
  writes application data" invariant unchanged even though pdm/ now has a live DB connection.
- **D6:** whole-corpus class-balance check (`corpusMaterializationService.js::checkClassBalance`)
  is warn-only for HITL-confirm/manual-buffer/negative-sample paths — discarding a
  human-confirmed real fault to preserve balance would mean throwing away real ground truth.
  Hard-block mode exists in the same function for the not-yet-built external-upload path, which
  already has its own per-file quality gate (§10.4.1 Stage C) capable of bouncing a bad batch.
- **D7 (split correctness, mle-review HIGH finding, fixed):** `evaluation/episodes.js` is
  ported to Python (`pdm/app/evaluation/episodes.py`), re-targeted at `bufferId` grouping
  instead of `dominantStatus` run-detection (corpus rows carry no `dominantStatus`). The port
  is **not** a literal transliteration: the JS original's per-row timestamp-cutoff split is only
  safe because detected runs are guaranteed non-overlapping; `fault_events` buffer time ranges
  are **not** guaranteed non-overlapping the same way (two different fault_events rows can have
  overlapping `[faultStart, faultEnd]` windows). The port assigns **whole buffers** to train/test
  by each buffer's own start timestamp, never per-row — this makes buffer-window overlap
  irrelevant to split safety by construction, with a defensive post-split assertion (no
  `bufferId` split across both sides) as a second line of defense. `NORMAL`/`NEGATIVE_SAMPLE`
  rows are routed by the exact same chronological cutoff as fault episodes, confirmed correct in
  review — an independent/random split for negatives would leak "future-relative-to-test-cutoff"
  normal examples into training.
- **D8 (promotion criterion, mle-review HIGH finding, fixed):** the original per-class floor
  used `tolerance=0.0` — candidate must beat champion on every fault label with sufficient
  held-out support, no slack. mle-review found this would likely block promotion indefinitely:
  at `min_support_per_class=5`, a single flipped held-out example swings recall by 20 points, so
  zero tolerance treats sampling noise as a permanent regression once real per-class support
  stays thin (which it will, for a long time — real confirmed faults arrive far slower than the
  synthetic corpus's). **Fixed with a support-scaled tolerance** (project-owner's choice among
  the reviewed options): wide at low support (~0.22 at n=5), tight at high support (~0.02 at
  n=500), approximating one standard error of a proportion estimate. The per-class floor itself
  (no averaging across classes — the whole point of D8) is unchanged.
- **D9:** `bufferId` is namespaced TEXT (`"fault_events:<id>"` today, `"upload:<id>:<n>"`
  reserved for the not-yet-built external-upload path); a separate `faultEventId` column carries
  a real enforced FK to `fault_events(id)` (unlike `processedTelemetryId`'s deliberately-
  unenforced FK elsewhere — `fault_events` is a plain `BIGSERIAL`, not a hypertable, so the
  TimescaleDB obstacle doesn't apply here). A `CHECK` constraint ties the two encodings together
  (code-reviewer MEDIUM finding, fixed) so they can never silently disagree.

**Files:** `server/database/migrations/005_training_corpus.sql` (`training_corpus` +
`training_runs`), `server/models/corpusModel.js`, `server/models/trainingRunModel.js`,
`server/services/corpusMaterializationService.js` (`resolveLabel`, `materializeBuffer`,
`materializeNegativeSample`, `checkClassBalance`, `onFaultEventConfirmed`,
`onFaultEventRejectedOrExcluded`), `server/utils/featureSnapshot.js` (extracted from
`faultEventService.js` to avoid a circular import once it started calling back into the new
corpus service), `server/scripts/recordTrainingRun.js`, `pdm/app/evaluation/episodes.py`,
`pdm/app/corpus.py`, `pdm/app/promotion.py`, `pdm/app/retrain.py`. Wired into
`faultEventService.js`'s `reviewFaultEvent` (explicit CONFIRMED-vs-correction branch, a
code-reviewer LOW finding fixed during implementation), `createManualBufferEvent`, and
`recordNegativeSample` — always fire-and-forget-but-caught, matching this repo's existing
Node↔Python/negative-sampling discipline (§3.3.1, §3.4).

**Tested:** 26 Node tests (`corpusMaterializationService.test.mjs` — `resolveLabel`'s 8 cases;
plus the pre-existing manual-buffer/validation suites, confirmed still green after the
`faultEventService.js` changes) and 26 Python tests (`test_episodes.py` — including the D7a
buffer-overlap and D7b NORMAL-routing regression tests; `test_promotion.py` — including the
"single flipped example at low support doesn't block" and "real regression at high support
still blocks" cases; `test_retrain.py` — end-to-end orchestration with a fake connection and
fixture `predict_fn`), all passing. No live-stack integration test was run for this pass (would
need real Postgres + a populated corpus, similar to §11's `verify-pdm-cutover.sh`) — the
model/service layer is exercised via mocks, same trust level as §10.4's implementation before
its own live verification.

Building on the earlier discussion (not yet reflected elsewhere in this doc):

- **A persistent training corpus accumulates over time**, one row per window, sourced from (i)
  confirmed `FLAGGED` `fault_events` rows, (ii) `NEGATIVE_SAMPLE` rows, and (iii) accepted
  uploaded buffers (once §10.4 is resolved), each row uniformly shaped: `featureSnapshot` +
  label + `bufferId` (`fault_events.id` for (i)/(ii); an upload-issued id for (iii), see below)
  + provenance (`uploadId`/`uploadedAt`/`uploadedBy` for uploaded rows, so a bad batch can be
  traced and excluded later without discarding the whole corpus).
- **Dedup on `bufferId`**, not on row content — re-uploading a buffer that's already in the
  corpus (by time range or an explicit re-upload) should update/replace, not duplicate-weight,
  that buffer's contribution.
- **Class balance must be watched across the whole corpus, not just within one upload.** If
  operators only ever upload fault examples (the natural instinct — "here's a new fault"), the
  corpus's fault:normal ratio drifts over successive retrains even though each individual
  upload is internally fine. A rejection/warning check belongs at accept-time on the
  **post-merge corpus balance**, not only on the uploaded file's own internal quality — this
  is different from, and additional to, the earlier per-file statistical rejection criteria
  (excessive imputation/capping) discussed for the upload gate itself.
- **Retrain-and-evaluate, not retrain-and-replace.** A retrain produces a candidate model,
  scored against a held-out split of the corpus — held out **by buffer**, not by row (splitting
  individual rows from the same buffer across train/test would leak information, since rows
  from the same fault period are correlated). This repo already has the right primitive for
  this: `evaluation/episodes.js`'s `walkForwardSplit`/`checkEvaluationGate`
  (`MIN_ONSET_EPISODES = 100`) was built for exactly this kind of buffer/episode-aware
  splitting, currently used for a different evaluation purpose — worth reusing rather than
  reinventing, once ported to (or called from) Python per whichever option §10.4 resolves to.
- **Champion/challenger promotion gate.** The candidate's held-out metrics (precision/recall
  per fault type at minimum, given class imbalance is expected) are compared against the
  currently-deployed model's metrics on the same held-out split. Promote only if the
  challenger is at least as good — never blindly promote just because a retrain completed.
  The previous model artifact is retained so a bad promotion can be rolled back.
- **Every retrained model artifact should be stamped with the corpus version it trained on**
  (e.g. a monotonic corpus version or content hash), mirroring `thresholdsVersion`'s already-
  established purpose in this doc (§3.1.1, §3.3) — reproducibility of "what data produced this
  model" was already a design value here; retraining doesn't get an exception.

### 10.6 Open questions carried forward

1. ~~§10.4's (a)/(b)/resolution-option choice~~ — **resolved**: raw sensor readings, two
   separate entry points (manual buffer over existing DB data, vs. external CSV upload)
   feeding one corpus, neither requiring HITL confirmation (§10.4's later resolution —
   `CONFIRMED` on creation, `PENDING_REVIEW` stays exclusive to Tier 1's automated flags).
   **Superseded by §11: feature computation itself moves to Python**, so "Node keeps feature
   computation" is no longer accurate as written here — see §11 for the corrected ownership.
2. ~~Does Python gain its own persistent storage for the training corpus~~ — **resolved,
   revised now that Postgres/TimescaleDB has actually landed (see the note at the top of §10):
   Python gets a read-only Postgres role against the same database**, not its own storage and
   not an HTTP export round-trip. §3.4's "stateless, no DB access" decision was reasoned from
   SQLite's single-writer model specifically for the live, per-window `/score` path — neither
   constraint applies to an occasional, read-only, batch training query under Postgres, which
   handles concurrent readers safely. Node remains the **only writer** — `fault_events`,
   `raw_telemetry`, and the corpus tables are never written by Python, only queried via a
   role with SELECT-only grants — so §3.4's actual invariant ("Python never writes application
   data") survives unchanged; only the narrower "no DB access at all" restriction is relaxed,
   and only for this batch/read path. Whatever model artifacts/training-run metadata Python
   *does* need to persist (trained model files, run metrics) are a separate concern from the
   corpus and can live in Python's own store without touching Node's tables at all.
3. ~~Statistical rejection thresholds for an uploaded file~~ — **resolved and implemented**
   (§10.4.1's D11): composite `qualityScore < 70` (reusing `computeQuality`'s existing
   GOOD/FAIR/POOR banding) plus two independent per-window floors,
   `physicsPassRate >= 0.85` and `imputationRate <= 0.30`.
4. ~~What counts as the label~~ — **resolved and implemented** (§10.5's D1):
   `fault_events.faultType` for a `CONFIRMED` row, `'NORMAL'` for a `NEGATIVE_SAMPLE` row;
   `status` is eligibility, not label content.
5. **Corpus seed state** — there is currently no Tier 2 corpus at all (per §1, Tier 2 has never
   been trained). The very first accepted upload and/or the first batch of HITL-confirmed
   `fault_events` effectively *become* the seed corpus; worth being explicit that "merge" is a
   no-op until a second contribution exists.
6. ~~Column-mapping UI~~ — **backend mechanism implemented** (§10.4.1); the operator-facing form
   itself remains out of scope, same as the rest of this document's UI deferrals (§1).

---

## 11. [Addendum — discussion only, not committed] Tier 1 feature computation moves to Python

**Status: exploratory, and materially larger in scope than §10.** §10 was about how Tier 2
gets retrained. This section is about who computes features **at all**, for **every**
closed window, live — which reaches past PdM into code this doc's original scope (§1–§9)
never touched: the dashboard, `forecastService`, `driftService`, `trendService`, all of which
read the same `processed_telemetry` row PdM's `precapFeaturesByMetric` comes from. Decided in
discussion: yes, move it, full pipeline, not just the PdM-relevant subset — see the reasoning
trail below for why the narrower option was rejected.

### 11.1 Why "just the PdM subset" was rejected

`precapFeatures.js`, `validator.js`, `outlier.js`, `missing.js`, and `quality.js` aren't
PdM-specific — they're stages of `preprocessing/pipeline.js`'s single pass over each closed
window, producing **one** `processed_telemetry` row consumed by the dashboard, forecast,
drift, and trend, in addition to Tier 1. Porting only "the PdM parts" to Python would mean two
independently-computed physics-validity flags and two quality scores — one feeding what
operators see on the dashboard, one feeding what PdM actually acts on, with no guarantee they
agree. That's the same duplication problem §10.4 already rejected for uploaded data, just
relocated to live data. The only way to actually eliminate it is for Python to own the whole
pipeline output, not a slice of it.

### 11.2 The new shape

- **Node** still does raw ingestion (`POST /api/data` unchanged), hard-rejects impossible
  values at the door (`middleware/validateReading.js`, unaffected — see §11.3), and still
  buffers incoming samples into windows — grouping samples into "this closes window X" has to
  happen near the wire regardless of where computation runs.
- **On window close**, instead of running the pipeline stages locally, Node POSTs a
  window-close payload to Python: the window's raw samples, plus the last sample of the
  *previous* window (the one piece of cross-window context `missing.js`'s gap-fill needs for
  continuity). This keeps Python stateless in the meaningful sense — no server-side memory
  between requests, Node just hands over the one piece of context needed each time.
- **Python** runs (ported) gap-fill → physics-validate → impute invalid runs → outlier-cap →
  aggregate → `precapFeatures` → quality → Tier 1 rule evaluation, and returns both the full
  `processed_telemetry` row shape and the Tier 1 verdict in one response.
- **Node** persists the returned row exactly where it does today, and calls
  forecast/drift/trend/`fault_events` exactly as before — those services don't change, they
  just now receive a row Python computed instead of Node.

This also strengthens §10: Tier 1 (live) and Tier 2 (training, from either entry point) now
run through the *same* Python feature-computation function regardless of whether the input is
a live window or a historical buffer — closing the reuse-analysis question §10 left open
about whether the corpus needs its own separate re-derivation path. It doesn't, under this
design; it's the same function, just called with different input.

### 11.3 What this breaks, and needs an explicit decision — not silently accepted

**Isolation is gone, and that was load-bearing on purpose.** §3.4 and §6's risk register
protected the dashboard/ingestion from a PdM outage *specifically* — "PdM scoring call blocks
or slows ingestion" and "Python service becomes a second DB writer" are both flagged High
severity because Python was designed to never be able to take anything else down with it.
Under this design, `processed_telemetry` itself isn't written without Python — a Python outage
now stops the dashboard, forecasting, and drift detection too, not just fault-flagging. This
needs one of:
  1. **Accept the coupling outright** — Python's uptime becomes as operationally critical as
     Node's, with monitoring to match, on the theory that eliminating duplication is worth it.
  2. **Decouple `raw_telemetry` from `processed_telemetry`'s dependency on Python** — raw
     ingestion keeps flowing regardless (it already doesn't touch Python), and window
     processing queues/retries against Python rather than blocking, so `processed_telemetry`
     falls behind during an outage and backfills once Python's back, rather than the whole
     write path stalling. Closer in spirit to §3.4's original "ingestion must never be
     blocked" principle, even though the *isolation* guarantee itself is gone either way.
  3. A Node-side degraded-mode fallback computation used only during an outage — likely not
     worth it, since it reintroduces exactly the second-implementation risk this migration
     exists to eliminate, just conditionally.
  No default is assumed here.

**Ingest-path latency/synchronicity is now a real question.** Today, closing a window and
computing its `processed_telemetry` row is in-process and synchronous — no network hop,
cheap. Under this design it's an HTTP call to Python. Whether that call sits inline in the
`POST /api/data` response path that happens to close a window (adding latency/failure
exposure to roughly 1-in-60 ingest requests, at the 60-second window cadence) or is decoupled
into an async job (preserving ingest latency, at the cost of a queue and a new "window pending
processing" state) is an open design decision, not yet made.

**`ingestLock.js`'s mutex was sized around a fast, synchronous in-process operation.** If
window-close processing runs under that lock at all going forward, it needs re-evaluating
against a slower, network-dependent operation — the same question as the point above, restated
at the concurrency-mechanism level.

**RANGES/physics constants need an actual canonical home now, not just a nice-to-have.**
`server/utils/validation.js`'s `RANGES` is used by `validator.js` (moving to Python) *and* by
`middleware/validateReading.js` (hard rejection at ingest, which must stay in Node — a bad
reading can't wait on a Python round trip before being rejected at the door). So RANGES is
needed in both languages regardless of this migration, not as a future possibility but as an
immediate requirement — the "duplicate vs. shared config" question flagged earlier in this
conversation (for the pump's physics ranges generally) is no longer optional to resolve.

### 11.4 What doesn't change

- Raw ingestion, `raw_telemetry` storage, and hard-rejection of impossible values
  (`middleware/validateReading.js`) stay in Node — these happen at the point of ingest
  regardless of where downstream feature computation lives.
- `fault_events`' schema, the HITL flow, and event coalescing (§3.3) are unaffected — this
  migration changes *who computes* `processed_telemetry`, not what gets stored about a fault.

### 11.5 Open questions — resolved

1. **Sync-in-request, resolved.** Node calls Python inline, synchronously, when a window
   closes — same short-timeout pattern already used for the existing PdM `/score` call
   (§3.4's ~2s budget). No new queue/worker infrastructure.
2. **On failure or timeout, skip the window — no retry queue, resolved.** The window is
   logged and dropped: no `processed_telemetry` row is written for it, but `raw_telemetry` is
   completely unaffected (it never depended on Python). This trades a durable-recovery
   guarantee for staying at the lowest infrastructure cost — chosen deliberately, given this
   migration is already being scoped as its own standalone piece of work (see the "just the
   Python change" framing this section was written under), not bundled with new job/worker
   infrastructure this codebase doesn't have yet (§4.5's note that no background-job pattern
   exists here today still applies). A gap in `processed_telemetry` during a Python outage is
   visible (dashboard shows missing data for that span, same as any other data gap this system
   already has to tolerate) rather than silently wrong — acceptable for now. A durable
   retry/backfill mechanism (the rejected "option 2" from §11.3) is a reasonable future
   enhancement once real operational data shows how often Python actually goes down; not
   built now.
3. **RANGES/physics constants — resolved: shared YAML config file.** A single file (e.g.
   `pump-physics.yaml`) checked into the repo, loaded by both Node and Python at startup —
   same pattern `thresholds.yaml` already establishes for Tier 1's rule thresholds. No RPC, no
   startup-order dependency between the two services, no duplicated hand-maintained constants.
4. **Parity testing — resolved as a required work item, not an open decision.** Before
   cutover: golden-value test fixtures running real/simulated raw windows through both the
   current JS pipeline and the Python port, asserting matching output (within float tolerance)
   across every field — aggregates, `precapFeatures`, quality scores, capped values, gap-fill
   results. Goes into the work-item breakdown once this section is scoped for implementation.
5. Scope note, not a decision: this section combined with §10 means the eventual work-item
   list for the full PdM-in-Python effort is substantially larger than §4's original items
   (§1–§9), which assumed Node-owned feature computation throughout and are now partially
   superseded. A future reader implementing this should read §10 and §11 alongside §4, not
   instead of it.

### 11.6 Work items (§11 only — §10's retraining/upload feature is out of scope for this
breakdown, per the "just the Python change for now" decision)

**11.6.1 Shared config**
- New `pump-physics.yaml` (repo root, or a location both `server/` and `pdm/` build contexts
  can reach) — the physics `RANGES` (min/max per metric) currently hardcoded in
  `server/utils/validation.js`, extracted into this file, in the same spirit as
  `thresholds.yaml`'s existing "provisional, labeled, versioned" style.
- `server/utils/validation.js`'s `RANGES` becomes populated by parsing this file at startup,
  not a hardcoded object — needs a YAML parser added to Node's dependencies (`server` has none
  today; `pdm` already depends on `pyyaml`).
- Both `server/Dockerfile` and `pdm/Dockerfile` need a `COPY` step for this file into their
  build context (or a shared bind-mount in `docker-compose.yml`, whichever this repo's existing
  multi-service file-sharing convention favors — check `docker-compose.pdm.yml`/
  `docker-compose.backend.yml` for precedent before picking).

**11.6.2 Python service (`pdm/app/`)**
- `pdm/app/preprocessing/` (new subpackage, mirroring `server/preprocessing/`'s module split
  so the port is traceable file-for-file against the JS original):
  - `missing.py` — port of `missing.js` (gap detection/fill; needs `prevSample` from the
    request payload for cross-window continuity, per §11.2).
  - `validator.py` — port of `validator.js`'s `validatePhysics`, reading `RANGES` from
    `pump-physics.yaml` (§11.6.1).
  - `outlier.py` — port of `outlier.js`'s Hampel-filter capping, including the
    abnormal-operation exclude-mask logic (§10.5's reminder: real fault signal must not be
    capped away).
  - `aggregation.py` — port of `aggregation.js::aggregateWindow`.
  - `precap_features.py` — port of `precapFeatures.js::computePrecapFeatures`.
  - `quality.py` — port of `quality.js::computeQuality`.
  - `pipeline.py` — new orchestration (not a port — `server/preprocessing/pipeline.js` is
    live-stream-stateful per the earlier reuse analysis in this doc; this is a fresh, stateless
    "run these stages in order over one window's samples" function) tying the above together
    and calling the already-existing `rules.py` for the Tier 1 verdict.
- `pdm/app/main.py` — new `POST /process-window` endpoint: body is `{windowSamples,
  prevSample, dtSec, windowEnd, ...}` (exact shape mirrors what `buffer.js` currently hands to
  `pipeline.js` internally — needs to be read directly off the current implementation, not
  guessed); response is `{processedRecord: <full processed_telemetry row shape>, tier1Verdict:
  {...}}` in one payload, replacing what `/score` did alone before. Whether `/score` is
  retired or kept as an internal-only path is an implementation-time call, not decided here.
- `pdm/app/schemas.py` — Pydantic request/response models for `/process-window`, so a shape
  mismatch with Node fails loudly (same reasoning §3.5 already applies to `/score`).
- `pdm/tests/` — unit tests per ported module (`test_missing.py`, `test_validator.py`,
  `test_outlier.py`, `test_aggregation.py`, `test_precap_features.py`, `test_quality.py`),
  independent of the parity tests in §11.6.5.

**11.6.3 Node service layer**
- `server/preprocessing/pipeline.js` — the local calls to `missing.js`/`validator.js`/
  `outlier.js`/`aggregation.js`/`precapFeatures.js`/`quality.js` are replaced with one
  synchronous HTTP call to `POST /process-window` (short timeout, ~2s, matching the existing
  `/score` budget per §11.5 item 1). `buffer.js` keeps doing what it does today — grouping raw
  samples into windows and knowing when one closes — only the *content* of window-close
  processing moves.
- **On failure/timeout: log and skip, no retry** (§11.5 item 2) — no `processed_telemetry`
  insert for that window, and downstream `forecastOnNewRecord`/`driftOnNewRecord`/
  `trendOnNewRecord`/PdM triggers for that window are skipped entirely (they have nothing to
  read yet). `raw_telemetry` is written regardless, unaffected by this failure path, same as
  every other PdM-related failure in this design.
- **`ingestLock.js` review, called out explicitly because it's easy to get wrong:** the HTTP
  call to Python must not execute while holding the lock that guards `buffer.js`'s state — if
  it does, every concurrent ingest request serializes behind one window's Python round-trip,
  which is a much worse regression than "the one request that closes a window gets slower."
  The lock should guard only the in-memory buffering/classification step; the Python call and
  the resulting DB write happen after it's released. Needs explicit verification this is how
  it's actually implemented, not assumed.
- **Correction, verified against the actual import graph (`grep` for every importer of each
  file) rather than assumed:** the original wording here claimed the whole six-file set (plus
  their sub-dependencies) stays "because other Node code still reads from some of it." That's
  only true for one of them. Checked file-by-file:
  - **`missing.js`, `validator.js`, `outlier.js`, `precapFeatures.js`, `quality.js` — each has
    exactly one importer in the entire codebase: `pipeline.js`.** No other file, and no test
    file, imports any of them directly. Once Phase 3 removes `pipeline.js`'s local calls to
    them, they are dead code, not "still legitimately depended on."
  - **`transition.js`** — imported only by `validator.js` and `missing.js`, both themselves in
    the orphaned set above. Dies transitively once those two are removed.
  - **`faultClassifier.js`** — imported only by `missing.js`, likewise in the orphaned set.
    Dies transitively too.
  - **`aggregation.js`** is the one genuine exception: its `round2` helper is imported
    independently by `historicalFeatures.js` (unrelated to PdM), and it has its own test file
    (`aggregation.dominantFaultType.test.mjs`). This one actually stays, on its own merits —
    not because of the original blanket reasoning.
  - `server/utils/validation.js`'s `RANGES`/hard-rejection reasoning was correct as stated —
    `middleware/validateReading.js` and `middleware/validateProcessed.js` both import it
    directly, independent of `pipeline.js`. This file stays regardless, unchanged from the
    original claim.
  - **Corrected disposition:** delete `missing.js`, `validator.js`, `outlier.js`,
    `precapFeatures.js`, `quality.js`, `transition.js`, and `faultClassifier.js` once the
    golden-value parity suite (§11.6.5) has confirmed the Python port and the cutover has
    landed — not before, since parity testing needs both implementations available to diff
    against. Keep `aggregation.js` permanently. This replaces the blanket "not deleted" claim
    with a concrete post-cutover cleanup step; see the new work item in §11.6.3 below and the
    updated DoD line in §11.7.
  - **Second correction, found while actually implementing the Phase 3 cutover (not caught by
    the import-graph grep above, which only checked `server/` source, not `server/scripts/`):**
    `server/scripts/parity/run_js_pipeline.mjs` — the golden-value parity suite's JS reference
    harness (§11.6.5), built to run the pre-cutover comparison — imports `validator.js` and
    `missing.js` directly, and transitively requires `outlier.js`/`precapFeatures.js`/
    `quality.js`/`transition.js`/`faultClassifier.js` through its own orchestration. **This
    file is NOT zero-importer just because `pipeline.js` stops calling the seven files
    directly** — deleting them without also retiring or rewriting `run_js_pipeline.mjs` breaks
    the parity suite with import errors. It must be removed (its one-time pre-cutover purpose
    is already served once cutover is confirmed) in the SAME cleanup pass as the seven
    preprocessing files, not treated as a separate/later step. `tests/parity/
    test_golden_values.py` and `tests/parity/fixtures.py` should be retired alongside it —
    once the seven files are gone there is nothing left for this suite to compare against.

**11.6.4 Docker / compose**
- `docker-compose.yml` / `docker-compose.backend.yml` / `docker-compose.pdm.yml`: no new
  services needed (both already exist from §4.4), but confirm `PDM_SERVICE_URL`'s existing
  ~2s-timeout fetch call is reused for `/process-window`, not a second, differently-configured
  HTTP client.
- `pump-physics.yaml` distribution to both containers (§11.6.1).

**11.6.5 Tests**
- **Golden-value parity suite** (§11.5 item 4) — the load-bearing test for this whole
  migration. A fixture set of raw windows (drawn from real `raw_telemetry` history and/or the
  Node-RED simulator, covering: normal operation, a gap requiring fill, a physics violation, an
  outlier requiring capping, an abnormal-operation window where capping must NOT occur) run
  through both the current JS pipeline and the new Python `/process-window` path, asserting
  matching output within float tolerance on every field — aggregates, `precapFeatures`,
  quality scores, capped values, gap-filled values. This must pass before cutover, not after.
- Integration test: force a window close while `pdm` is stopped — confirm `raw_telemetry`
  still gets the samples, no `processed_telemetry` row is written for that window, no
  unhandled rejection, and the *next* window (once `pdm` is back) processes normally.
- Concurrency test: multiple overlapping ingest requests during a window close — confirm
  ingest latency for requests *not* closing a window is unaffected by the Python round-trip
  (validates the `ingestLock.js` scoping point above).
- Confirm forecast/drift/trend/`fault_events` still fire correctly off a Python-sourced
  `processedRecord`, unchanged from how they fire off a Node-computed one today.

### 11.7 Definition of done

- [x] `pump-physics.yaml` exists; both Node and Python load `RANGES` from it, not a hardcoded
      copy in either language (§11.6.1). **Verified**: `server/utils/validation.js` and
      `pdm/app/physics.py` both load from the repo-root file.
- [x] `pdm/app/preprocessing/` contains a Python port of every stage `pipeline.js` currently
      runs (missing, physics validation, outlier capping, aggregation, precap features,
      quality), plus a new stateless orchestration function (§11.6.2). **Verified** present.
- [x] `POST /process-window` exists, Pydantic-validated request/response, returns both the
      full `processed_telemetry` row shape and the Tier 1 verdict in one call (§11.6.2).
      **Verified** in `pdm/app/main.py`.
- [x] Golden-value parity suite passes: Python's output matches the current JS pipeline's
      output within float tolerance across the fixture set described in §11.6.5, **before**
      `pipeline.js`'s local stage calls are removed. **Implemented and passing**
      (`pdm/tests/parity/`, 6 fixtures including one sourced from `data/pump-telemetry/` real
      corpus data, all green). **Process-gap note:** the seven JS reference modules and the
      JS harness this suite diffs against (`missing.js`, `validator.js`, `outlier.js`,
      `precapFeatures.js`, `quality.js`, `transition.js`, `faultClassifier.js`,
      `server/scripts/parity/run_js_pipeline.mjs`) had already been deleted in commit
      `1391c45`, before this suite was ever built or run — exactly the ordering §11.6.3's
      second correction warns against. They were restored from git history
      (`git show 1391c45~1:<path>`) specifically to build and run this suite, and remain
      reference-only (not reintegrated into `pipeline.js`'s live call graph). Delete them
      again, together with `pdm/tests/parity/`, once a live deployment separately confirms
      the cutover working end-to-end (the remaining unchecked lines below) — not before.
      **Real bug found and fixed by this suite:** the `real_running_window` fixture (sourced
      from real corpus data, not hand-synthesized) caught a genuine divergence —
      `aggregation.py`/`precap_features.py` used Python's builtin `sum()`, which on CPython
      3.12+ uses compensated (Neumaier) summation for floats, more accurate than JS's naive
      `.reduce((a,b) => a+b, 0)`. On this real window the true mean landed within float-noise
      of an exact `.xx5` rounding boundary, so the two implementations rounded to different
      values (JS 4.90, Python 4.91) — the exact class of divergence `FLOAT_TOLERANCE = 0.005`
      was tuned to catch. Fixed by adding `js_sum()` (naive left-to-right summation) to
      `_stats.py` and using it in both modules' mean/variance accumulation in place of the
      builtin. All 5 synthetic fixtures had already passed without this fix — only the real
      corpus-derived fixture exposed it, underscoring why §11.6.5 calls for a real-data
      fixture and not only hand-built edge cases.
- [x] `pipeline.js` calls `POST /process-window` synchronously in place of local computation;
      on failure/timeout, logs and skips the window — no `processed_telemetry` row, no
      downstream trigger calls, `raw_telemetry` unaffected (§11.6.3). **Implemented**; verified
      via `server/scripts/tests/pipelineProcessWindow.test.mjs` (mocked `sensorService`/
      `processedService`/`fetch`, no live Postgres/pdm needed) — NOT yet verified against a
      real deployed `pdm` service or a live Postgres integration run; that verification still
      needs to happen once actually deployed.
- [x] `ingestLock.js`'s critical section verified to exclude the Python HTTP call — confirmed
      via the concurrency test in §11.6.5, not just code inspection. **Verified**, but via the
      mocked test above (a slow mocked `fetch` proven not to block a concurrent non-window-
      closing `processSample()` call), not the live-traffic concurrency test §11.6.5 originally
      envisioned. `ingestLock.js` itself was not modified — only what `pipeline.js` places
      inside vs. outside `withLock()` changed.
- [x] Backend survives `pdm` being fully stopped during a window close: no crash, no unhandled
      rejection, `raw_telemetry` keeps flowing, the next window processes normally once `pdm`
      is back (§11.6.5). **Verified live** via `server/scripts/verify-pdm-cutover.sh` against a
      real Postgres + `pdm` + `backend` stack (run on the Proxmox Docker host, not mocks): no
      unhandled rejection while `pdm` was stopped, raw ingest kept accepting samples, and the
      next window processed normally once `pdm` restarted (`preprocessingVersion=v3-py`).
      The ingest-concurrency line above was verified live in the same run: 20 concurrent
      non-window-closing requests completed in 245ms total (well under the 5s serialization
      threshold), confirming `ingestLock.js`'s critical section does not serialize concurrent
      ingest behind the Python round-trip.
- [x] Post-cutover cleanup: `missing.js`, `validator.js`, `outlier.js`, `precapFeatures.js`,
      `quality.js`, `transition.js`, `faultClassifier.js`, `server/scripts/parity/
      run_js_pipeline.mjs`, and `pdm/tests/parity/` (`test_golden_values.py`/`fixtures.py`) all
      deleted together, in one pass, once a real deployment confirms the cutover working live
      via the two lines above. **Done**, after the live-verification script above passed.
      Zero-importer status was re-verified via repo-wide `grep` immediately before deletion —
      the only importers of the five orphaned preprocessing modules were `run_js_pipeline.mjs`
      itself and each other (`validator.js`/`missing.js` → `transition.js`/`faultClassifier.js`),
      all part of the same deletion set; nothing in the live call graph referenced any of them.
      `aggregation.js`, `buffer.js`, `ingestLock.js`, `server/utils/validation.js`, and
      `preprocessing/config.js` stay — each has a verified independent caller outside the
      deleted files' former call sites.
- [x] `raw_telemetry.physicsValid`/`provenance` semantic change (surfaced during Phase 3's
      design, not previously documented): Node's ingest path no longer computes these locally
      per-sample — every row Node writes directly now falls back to the DB defaults
      (`physicsValid=TRUE`, `provenance='MEASURED'`), regardless of what Python later
      determines for that sample within its audit window. **Re-verified** (repo-wide grep,
      post-cleanup): `sensorModel.js` only ever appears in an `INSERT` column list for these
      two columns; no `SELECT ... physicsValid` / `SELECT ... provenance` exists anywhere in
      `server/` — no dashboard/API consumer reads either column back out. Not an observed
      regression, but a real, permanent narrowing of `raw_telemetry`'s audit fidelity worth
      being aware of if a future feature ever wants real per-row physics-validity from the raw
      table itself. Accepted as-is; no further action needed unless that future feature arrives.
- [x] Python unit tests pass for every ported module (§11.6.2). **Verified**: `pytest pdm/tests/`
      — 50/50 passing (post-cleanup; the count is 6 lower than the 56 seen mid-migration because
      the golden-value parity tests were correctly deleted along with the restored JS reference
      files once live cutover was confirmed).
- [x] No PdM code writes to Postgres directly from Python (unchanged invariant from §3.4/§4,
      still holds — this migration adds a read path for §10's corpus, not a write path, and
      doesn't touch this invariant at all for the live `/process-window` call). **Verified**:
      no Postgres driver (`psycopg`/`asyncpg`/`sqlalchemy`) appears in `pdm/requirements.txt` or
      `pdm/requirements-dev.txt` — the invariant holds structurally, not just by convention.

---

## 12. Expanded fault taxonomy, and a correction: the simulator must not emit `faultType`

**Status: decided and implemented**, not exploratory like §9–§11. Two changes, made together
because the second was caught while implementing the first.

### 12.1 Four new fault types

The original three (`THERMAL`, `CAVITATION`, `BEARING`) were never meant to be exhaustive —
they were what the simulator happened to ship with. Four more are added, chosen specifically
because they produce a distinguishable signature using only this system's existing 6 metrics
(no new sensors required):

- **`IMPELLER_WEAR`** — erosion/damage/partial clog: flow and discharge pressure drop for the
  *same* rpm (efficiency loss, not a speed change); suction pressure ticks **up** slightly
  (flow backs up) — the opposite direction from `CAVITATION`'s suction collapse, which is what
  keeps the two distinguishable.
- **`SEAL_LEAK`** — mechanical seal wear/failure: almost entirely a discharge-pressure story,
  with negligible vibration/thermal signal. Deliberately the "quiet" fault — none of the
  original three produce a pressure-only signature, so without it a real seal failure would
  look like unexplained noise to Tier 1.
- **`MISALIGNMENT`** — shaft/coupling misalignment: vibration-dominant like `BEARING`, but a
  different ratio (smaller flow/pressure hit, temp rises from mechanical strain rather than
  friction). **Flagged as genuinely ambiguous against `BEARING`** with only these 6 scalar
  metrics (no vibration frequency spectrum, no motor current) — don't expect Tier 2 to cleanly
  separate the two without richer instrumentation eventually; this is a known, accepted
  limitation, not an oversight.
- **`DRY_RUN`** — pump loses prime / runs with no or partial fluid: the most severe,
  fastest-onset fault — flow/pressure collapse almost completely, rpm *rises* (no fluid load
  resisting the motor), temp climbs fast (no fluid to cool bearings/seals). Distinct from
  `CAVITATION` by rpm direction and speed of onset.

Per-metric deltas (applied at `faultSeverity = 1`, scaling linearly like the original three)
are in `node-red/flow.json`'s `gen_reading` function, `FAULT_PROFILES` object — kept in sync
by hand with this section if either changes.

**Files updated**, all enumerating the same set of fault type strings:
- `node-red/flow.json` (`gen_reading`'s `FAULT_PROFILES`) — drives the simulator's per-metric
  deviation shape for each type.
- `server/utils/validation.js` (`VALID_FAULT_TYPES`) — raw/processed telemetry ingest
  validation (`middleware/validateReading.js`/`validateProcessed.js`).
- `pdm/app/schemas.py` (`WindowSampleIn.faultType`, `ProcessedRecordOut.dominantFaultType`
  `Literal`s) — Python-side schema contract, §3.5/§11.6.2.
- `server/utils/pdmReviewValidation.js` (`FAULT_EVENT_FAULT_TYPES`) — HITL review PATCH
  validation, keeps `OTHER` as the trailing catch-all (§1's original reasoning for `OTHER`
  unchanged).
- `client/src/utils/constants.js` (`FAULT_TYPES` dropdown options) — HITL reviewer-facing
  labels in the review UI.
- `server/database/migrations/002_fault_events.up.sql`'s `faultType` column comment (no schema
  change needed — always been a plain `TEXT` column, no `CHECK` constraint enumerating values,
  per the note already in that migration).

No change needed to `pdm/app/preprocessing/fault_classifier.py` (SENSOR_FAULT vs
NOT_SENSOR_FAULT heuristic, §3.3) or `server/preprocessing/aggregation.js`'s
`dominantFaultType` tally — both already treat `faultType` as an opaque string keyed by
whatever's present, not a hardcoded three-value set.

### 12.2 Correction: the simulator was leaking ground truth into the live stream

**Caught while wiring in §12.1, but a pre-existing issue, not introduced by it.**
`gen_reading`'s `msg.payload` previously included `faultType: state.regime === 'FAULT' ?
state.faultType : null` — i.e. the simulator told the ingest pipeline exactly which fault type
was active, live, on every sample. That's not realistic: a real pump's sensors report readings
and operational status (`RUNNING`/`STOPPED`/`FAULT`), never a diagnosis — nothing in a real
system knows "this is a `BEARING` fault" until a human (or a trained model) says so. Leaking
the label into the raw stream also made Tier 1/Tier 2 trivial for simulator-sourced faults,
which defeats the point of building them.

**Fixed:** `gen_reading` still uses `FAULT_PROFILES` internally to pick which per-metric
deviation shape drives a given episode (so different fault episodes are still physically
distinct from each other), but `msg.payload` now only reports `status`, never `faultType`.
The diagnosis path is exactly what this doc already specifies elsewhere and needed no new
design:

1. Tier 1 (`pdm/app/rules.py`) flags a candidate window from the (now-undiagnosed) abnormal
   readings alone, same as always (§3.2).
2. A human reviewer confirms it via HITL and assigns the real `faultType` from the expanded
   set in §12.1 (§3.6's `PATCH /api/pdm/fault-events/:id`) — this is genuinely the first place
   a `faultType` should ever be assigned for simulator/live data, not the sensor stream.
3. **"Auto-labeled if it appears again"** — the operator's stated expectation for a repeat
   occurrence — is exactly what Tier 2 exists to do (§10): a reviewed `fault_events` row's
   `featureSnapshot` becomes a training example, and a trained Tier 2 model classifying a new
   candidate against that learned signature *is* the auto-labeling. No separate mechanism is
   being proposed here — this is a restatement of the plan's existing Tier 2 purpose, called
   out explicitly because it was raised as if it were a new requirement. Until Tier 2 is
   trained (§1: not yet), every occurrence — repeat or not — still goes through HITL review
   per (2); there is no nearer-term signature-matching shortcut in scope.

**`dominantFaultType` (aggregation.js) and `fault_classifier.py`'s upstream-diagnosed-fault
short-circuit are both affected, harmlessly.** Both already treat a missing/falsy `faultType`
as "unknown," not an error (`sample.status === 'FAULT' && sample.faultType` short-circuits
cleanly; `fault_classifier.py`'s explicit-diagnosis check simply never fires for
simulator-sourced runs now) — verified by reading both call sites, not assumed. This is the
correct behavior now: raw ingest genuinely has no diagnosis to offer, matching real telemetry.

---

## 13. Synthetic Tier 2 training corpus (`data/pump-telemetry/`)

**Status: generated and independently validated as a corpus; its role relative to Tier 2
training is exploratory, not decided (see §13.3's correction and §13.4–§13.5).** The corpus
itself is real and checked (§13.1–§13.2). What it's *for* is where this section originally
overreached: an earlier version of this addendum declared it resolves §1's "Explicitly NOT in
scope" bullet ("No Tier 2 model training or trained model artifact... there isn't enough labeled
fault data yet") — but §1 is this doc's committed base scope, not itself amended here, and every
other addendum in this doc is explicit when it supersedes earlier committed text (§10.6 item 1:
"Superseded by §11..."). Declaring §1 resolved from inside an addendum, without updating §1 to
say so, left the doc internally inconsistent — corrected in §13.3 below. Every public dataset
evaluated as an alternative during generation (a diesel-engine CSV, an anonymized 50-sensor pump
dataset, a loosely-pump-shaped CSV with only single-tick fault spikes, and a real but
burst-sampled/differently-instrumented academic pump rig — none checked into this repo) failed
at least one of: a real time axis, this system's exact 6 named metrics, or realistic multi-window
fault episodes — which is why a synthetic corpus generated from this system's own fault physics
(§12.1's `FAULT_PROFILES`) was built at all; that reasoning stands regardless of how §13.3
resolves.

### 13.1 What exists

- `scripts/generate_pump_telemetry.py` — generates the corpus, seeded (`SEED = 20260816`),
  reproducible bit-for-bit on re-run (verified).
- `scripts/validate_pump_telemetry.py` — re-derives every invariant from the *written files*,
  not the generator's in-memory state, so a generator bug can't hide behind a shared
  assumption. Independently re-run (not just read from its own output) as part of accepting
  this corpus — see §13.2.
- `data/pump-telemetry/date=YYYY-MM-DD/part-000.parquet` — **the training corpus itself.**
  7,776,000 rows, 90 days (`2026-05-01` to `2026-07-29`), 1 Hz, UTC, Hive-partitioned by day,
  zstd Parquet, ~73 MB on disk. This is the file to actually train Tier 2 against — read all
  90 partitions together (`pd.read_parquet("data/pump-telemetry")`).
- `data/pump-telemetry-episodes.csv` — companion manifest, one row per fault episode
  (`episodeId, faultType, startTimestamp, endTimestamp, durationSeconds, peakSeverity`). Used
  for evaluation (precision/recall/lead-time against known ground-truth fault windows,
  matching §10.5's champion/challenger held-out-by-buffer approach) and for validating the
  corpus itself without re-scanning 7.8M rows — not a training input on its own.
- `data/pump-telemetry-sample.csv` — a 3,284-row plain-CSV excerpt (one `DRY_RUN` episode),
  for eyeballing without a Parquet reader only. Too small and single-type to train on.
- `data/pump-telemetry-meta.json` — generation summary (seed, counts, bad weeks, per-type
  totals). Reference only, not a data input.
- `data/README.md` — full schema, generation methodology, and known-characteristics
  documentation for the corpus; see that file for details not repeated here.

### 13.2 Validation actually performed, not just claimed

`scripts/validate_pump_telemetry.py` was re-run directly (not assumed from `data/README.md`'s
self-reported figures) and every check passed:

- Structural: strictly-increasing 1-second timestamps, no gaps/duplicates, exactly 7,776,000
  rows, full 90-day coverage, no missing metric values, `status` always one of the three valid
  values.
- Values: every metric within its `pump-physics.yaml` range, exactly 1 decimal place
  throughout, `rpm` never falsely reads `0` outside `STOPPED`.
- Labels: `faultType` non-null iff `status = FAULT`, always a valid type, exactly one type per
  episode.
- Episodes: **zero isolated single-tick FAULT rows** — the exact failure mode that ruled out
  `pump_sensor_data_large.csv` earlier in this process does not occur here; 180 contiguous
  episodes; all 7 fault types present with ≥20 episodes each (`BEARING=26, CAVITATION=23,
  DRY_RUN=27, IMPELLER_WEAR=33, MISALIGNMENT=23, SEAL_LEAK=26, THERMAL=22`); every episode
  duration inside its band; a full ≥1-hour RUNNING buffer immediately before and after every
  episode, including inside bad weeks.
- Shutdowns: 61 `STOPPED` episodes, 20–299 s.
- Mix: `RUNNING` 96.87%, `FAULT` 3.06%, `STOPPED` 0.07%.
- Continuity: worst adjacent-second jump on any metric during steady `RUNNING` is 2.46% of
  full scale — no teleporting values, momentum is real.
- Manifest agreement: 180 manifest rows for 180 episodes, 0 mismatches against the telemetry.
- Bad-week clustering: weeks 1, 2, and 13 carry 28/28/24 episodes against a 10/week baseline
  in quiet weeks (mean 13.8/week) — matches §12's "roughly double" bad-week spec.

### 13.3 Correction: what this corpus is not, and why "train Tier 2 directly on it" overreached

**An earlier version of this section said to train Tier 2 against `data/pump-telemetry/`
directly and treat that as resolving §1's scope note.** On review, that's not adopted. Reasons:

- **§1 states Tier 2 training is out of scope because there isn't enough labeled fault data
  yet — a data-honesty argument, not merely a data-volume one.** This corpus doesn't add labeled
  *observations* of real fault behavior; every label in it is ground truth I asserted at
  generation time from a model I wrote (§12.1's `FAULT_PROFILES`, exact linear deltas per fault
  type). A model trained on it learns this system's own guess at fault physics, not evidence of
  what a real fault looks like. Reporting accuracy/precision/recall from that as if it
  establishes real-world Tier 2 performance risks exactly the kind of fabricated confidence §10.4
  already rules out for a different part of this design ("never fabricate confidence it doesn't
  have" — the reason Tier 1's automated flags need a human reviewer). The same principle applies
  here: a number this corpus produces is not evidence about the real pump.
- **§10.5's champion/challenger promotion gate is defined against a real held-out corpus** —
  confirmed `fault_events`/accepted uploads, split by buffer. A model whose only training and
  evaluation data is synthetic never passes through that gate in any meaningful sense; declaring
  it ready to train "Tier 2" proper skips the exact safety mechanism §10.5 was designed to
  enforce.
- **§10.4's two entry points (manual buffer over real `raw_telemetry`, validated external
  upload) are the only defined ways data joins the real corpus**, each with its own provenance
  tag (`sourceType`) precisely so a bad or synthetic contribution can be traced and excluded.
  This corpus fits neither entry point — it was never suggested it should — and no third entry
  point for synthetic data is proposed here or elsewhere.

**What the corpus is actually for:** developing and testing the Tier 2 *pipeline machinery* —
feature computation, splitting, evaluation reporting, the `model.py` wiring — before real fault
data exists in volume, addressing the gap §10.6 item 5 already named ("there is currently no
Tier 2 corpus at all") without claiming to fill it. §13.4 describes this scaffold; none of it has
been built. `MISALIGNMENT` vs `BEARING` separability remains a real, accepted limitation carried
over from §12.1 regardless of which framing is used — both are vibration-dominant with only these
6 scalar metrics, and no amount of additional synthetic data fixes that.

### 13.4 The deferred scaffold (design, not built)

A training scaffold consuming this corpus was designed in discussion but explicitly not built,
each step tied to an existing module to reuse rather than reinvent:

1. Load the corpus and its episode manifest.
2. Compute windowed features via `pdm/app/preprocessing/aggregation.py`, not a hand-rolled
   mean/std — consistent with §11's move of feature computation into Python and this doc's
   general "don't recompute what already exists" stance (§3.1, §10.4).
3. Build **two** labels side by side, to make §10.6 item 4 ("what counts as the label") concrete
   rather than resolve it by fiat:
   - a same-time diagnosis label (the row's own `status`/`faultType`) — "is a fault happening
     right now," and
   - a lead-time-shifted onset label ("does a fault start within the next N minutes") — the
     signal a genuine PdM system needs, distinct from diagnosis.
   The onset label needs a continuous per-row severity signal the corpus doesn't currently
   expose: `severity` today only exists internally during generation and surfaces solely as
   `peakSeverity` per episode in the manifest. A concrete, scoped follow-up this section records:
   add a per-row `severity` column to `data/pump-telemetry` (0.0 outside any episode, ramping
   smoothly 0→peak and back within one, from values already computed during generation, no new
   modeling needed), so the onset label can be built by shifting this column backward in time
   rather than inventing a new signal.
4. Split by episode using `server/preprocessing/evaluation/episodes.js`'s
   `walkForwardSplit`/`checkEvaluationGate` (`MIN_ONSET_EPISODES = 100`), per §10.5's own
   instruction to reuse this "rather than reinventing... once ported to (or called from)
   Python" — not a hand-rolled random split, which would leak correlated rows from the same
   episode across train/test. The synthetic corpus's 180 episodes clear `MIN_ONSET_EPISODES`,
   so it can exercise the gate logic itself even before real data does.
5. Train a baseline Random Forest/XGBoost on the onset label, per the doc's intro and §10.1's
   "model family stays Random Forest/XGBoost" decision.
6. Evaluate stratified by proximity-to-onset (early-window accuracy, not just overall accuracy —
   overall accuracy is flattered by easy late-episode rows, since severity ramps from 0) and by
   fault type (expecting, not chasing, the `MISALIGNMENT`/`BEARING` ambiguity §12.1 already
   calls out as a known limitation of these six scalar metrics).
7. Report results clearly labeled as trained on synthetic ground truth only — not a substitute
   for evaluation against real `fault_events` data, consistent with §10.5's champion/challenger
   gate being defined in terms of a real held-out corpus, not this one.
8. Wire the trained artifact into `pdm/app/model.py`'s `score()` stub as an augmenting, not
   replacing, verdict — per §3.5's existing tiered design. This is the eventual integration
   point already scaffolded there; nothing new needs to be invented for it.

### 13.5 Open items this does not resolve

This section narrows, but does not close, two items already open in §10.6:

- **Item 4 (what counts as the label)** — building the two label variants in §13.4 step 3 lets
  the choice be prototyped experimentally against a corpus with dense ground truth, but the real
  answer still depends on what `fault_events` ends up capturing once HITL review data
  accumulates, which this synthetic corpus cannot substitute for.
- **Item 5 (corpus seed state)** — §13.1–§13.2 give the Tier 2 *pipeline* something to develop
  and test against today; they do not seed the real training corpus, which per §10.6 item 5
  still only comes into existence once the first accepted upload and/or HITL-confirmed
  `fault_events` batch actually lands.

---

# Tier 2 Model Ops — artifacts, fitting, human-approved promotion, admin surface, monitoring

Closes the six things standing between §10.5's already-built retrain/promotion *infrastructure*
and an actually-deployed, actually-supervised Tier 2 model: a model artifact that exists and
gets loaded, code that fits one, a human decision point on promotion, an admin-only screen for
that decision, continuous monitoring of whatever is deployed, and admin-side access to the
already-built upload/mapping flow.

**Status:** planning only — nothing here has been executed yet. Matches the convention every
prior addendum in this document uses until reviewed and approved.

**Reference convention.** A bare `§x` refers to a section of this document. Decision IDs
continue this document's series (D1–D18 are taken; this section starts at **D19**).

**What this builds on, unchanged.** §10.5's corpus/split/promotion machinery
(`training_corpus`, `training_runs`, `corpusMaterializationService.js`, `trainingRunModel.js`,
`pdm/app/{corpus,promotion,retrain}.py`, `pdm/app/evaluation/episodes.py`,
`server/scripts/recordTrainingRun.js`), §10.4/§10.4.1's two corpus entry points and their
Stage A/B/C gate, §11's Python-owned feature computation, §12.1's 7-fault taxonomy,
and §3.4's "Python never writes application data" invariant. None of those decisions are
reopened here.

---

## 14.0 Preconditions and what was verified against the code, not assumed

Every claim below was checked against the actual repo before this section was written. Several
contradict what a reader would infer from §10.5's prose alone, and the plan depends on the
corrected version.

**§15 note:** items 1, 2, and 5 below describe the pre-model state this whole section (and
§15) exists to close — §15.1/D51 is what actually fits and loads a model and fixes item 5's
`/process-window` gap, for the bootstrap model specifically. Read as "true when §14 was
written, and true again for §14's own fitting path in §14.2 until §15.1 supersedes it for the
bootstrap"; not stale, just no longer describing the deployed end state once §15 lands.

1. **`pdm/app/model.py::score()` returns `None` unconditionally.** No artifact load, no
   feature vectorization, no model object. Confirmed.
2. **Nothing fits a model anywhere in the repo.** `retrain.py::run_retrain()` takes a
   `predict_fn` and never trains; `_main()` deliberately exits 1 with
   `"retrain.py's CLI entry point requires a trained model.py"`. Confirmed.
3. **`pdm/requirements.txt` has no ML stack** — `fastapi`, `uvicorn[standard]`, `pydantic`,
   `pyyaml`, `psycopg[binary]`. No numpy, scikit-learn, xgboost, joblib.
4. **`training_runs.artifactPath` exists and nothing writes or reads it.**
   `recordTrainingRun.js` passes `result.artifactPath ?? null`; `retrain.py`'s result dict has
   no `artifactPath` key at all, so it is always null today.
5. **The live scoring path no longer goes through `/score`.** Since §11's cutover,
   `pipeline.js` calls `POST /process-window`, whose response carries `tier1Verdict` computed by
   `preprocessing/pipeline.py:222` (`rules.evaluate(...)`), and `pdmService.js` uses that
   *precomputed* verdict rather than issuing its own `POST /score`.
   **`preprocessing/pipeline.py` never calls `model.score()`.** So a loaded Tier 2 model wired
   only into `main.py`'s `/score` handler would have **zero effect on live scoring** — the
   augmentation described in §3.5 is currently plumbed into the one endpoint the live path
   stopped using. This must be fixed in `/process-window`, not just `/score` (§14.3.4).
6. **`ScoreResponse` (pdm/app/schemas.py:51) declares only Tier 1 fields**, and both `/score`
   and `/process-window` bind it as a `response_model`. FastAPI's `response_model` *filters*
   undeclared keys, so `main.py:31`'s `verdict = {**verdict, **tier2_verdict}` merge would
   silently drop every Tier 2 field it adds. Confirmed by reading the model. Extending the
   schema is therefore mandatory, not cosmetic.
7. **No admin group concept exists anywhere.** The only Authentik group referenced in code is
   `PDM_REVIEWER_GROUP` (`server/routes/index.js:34`, default `'pdm-reviewers'`), used on the
   HITL PATCH, manual-buffer, and both external-upload routes. Repo-wide grep for
   `ADMIN_GROUP`/other `*_GROUP` constants returns nothing else (`METRIC_GROUPS` in
   `ReportsPage.jsx` is unrelated). The client has **no route guard of any kind** — `App.jsx`
   holds a `page` string in `useState` and renders every page unconditionally; there is no
   router.
8. **The client already knows the signed-in user's groups.** `GET /api/whoami`
   (`whoamiController.js`) echoes `req.identity` (`username`, `email`, `groups`), and `App.jsx:32`
   already polls it — `identity.groups[0]` is currently used as a cosmetic job-title stand-in in
   the sidebar.
9. **`recordTrainingRun.js`'s documented usage cannot work in the deployed topology.** Its
   header says `python -m pdm.app.retrain | node server/scripts/recordTrainingRun.js`, but
   `pdm/Dockerfile` is a `python:3.12-slim` image with no Node, and `server/`'s image has no
   Python — the two sides of that pipe live in different containers. It works only on a dev host
   with both toolchains. Any admin-triggered retrain needs a different transport (§14.4.5).
10. **`pdm` has no writable persistent storage.** `docker-compose.yml`'s `pdm` service mounts
    only `./pump-physics.yaml:ro`, has `cap_drop: ALL`, `mem_limit: 512m`, publishes no ports,
    and is on the `data` network only. `backend` is on `edge` + `data`, so `backend → pdm` works
    and nothing outside the stack can reach `pdm` at all.
11. **`pdm_corpus_readonly` is granted `SELECT` on `training_corpus` only**
    (`005_training_corpus.sql`'s conditional `GRANT`). It has no grant on `training_runs`.
12. **`training_runs` has no decision/approval columns** — `promoted BOOLEAN NOT NULL DEFAULT
    false`, `promotionReason TEXT NOT NULL`, `championRunIdAtEval`. No actor, no timestamp of
    promotion, no pending state, no artifact checksum. `getChampion()` is
    `WHERE promoted = true ORDER BY id DESC LIMIT 1`.
13. **No Tier 2 prediction is persisted anywhere.** Repo-wide grep: `fault_events` has no Tier 2
    columns (002/003/004 migrations add `autoLabeled`/`autoLabeledFromEventId`/`sourceType`
    only), and there is no predictions table. There is currently *nothing to monitor from*.
14. **The existing Stage A response is already a complete mapping-screen contract.**
    `externalUploadService.js::handleUpload` returns `{uploadId, headers, excludedColumns,
    detectedTimestampColumn, rowCount, medianIntervalSec, warnings}`; `confirmUpload` returns
    `{requiresConfirmation, rangeSanityWarnings}` on the Stage-B range soft gate and accepts
    `confirmRangeOverride`. No new upload backend is needed for the core flow (§14.8).
15. **`corpusMaterializationService.js::retractUpload(uploadId)` exists with no HTTP route.**
    The undo mechanism §10.4.1 added during review is currently uninvokable.
16. **`server/package.json`'s test script actively excludes PdM tests:**
    `node --test $(find scripts/tests -maxdepth 1 -name '*.test.mjs' ! -name '*pdm*' ! -name '*faultEvent*')`.
    A new test file named `...pdm...` or `...faultEvent...` will be silently skipped by
    `npm test` (§14.10.2).
17. **The client's fetch wrapper hardcodes a JSON content type.** `client/src/api/client.js:13`
    spreads `{'Content-Type': 'application/json', ...options.headers}` on every request — a
    multipart upload through it would send the wrong content type with no boundary (§14.8.3).

---

## 14.1 Scope

### In scope

1. **Artifact store + load path** (§14.3): where a trained model file lives, how
   `training_runs.artifactPath` points at it, how `pdm` loads the champion at startup and
   hot-reloads it on promotion, and what happens when it can't.
2. **Actual model fitting** (§14.2): a deterministic `featureSnapshot → feature vector`
   transform, a Random Forest (default) / XGBoost (config-gated) fit, and the artifact +
   metadata it writes. `retrain.py` gains a real training path while keeping its injectable
   `predict_fn` for tests.
3. **Human-approved promotion** (§14.4): `decide_promotion()` becomes a *recommendation*; a new
   `training_runs` decision lifecycle, admin approve/reject/rollback endpoints, single-champion
   enforcement, and a retrain job transport that works across the container boundary.
4. **Admin-only frontend page** (§14.7): `ModelOpsPage`, the exact auth boundary, and a new
   `PDM_ADMIN_GROUP` tier distinct from `PDM_REVIEWER_GROUP`.
5. **Continuous monitoring** (§14.6): six concrete metrics, a `tier2_predictions` table, where
   each metric is computed, and how it reaches the page.
6. **Training-data + mapping upload from the admin page** (§14.8): reusing §10.4.1's endpoints
   as-is, plus a list/retract surface and two small contract fixes.

### Explicitly NOT in scope

- **No change of model family.** Random Forest / XGBoost, per §10.1. No sequence model —
  §10.2's row-not-sequence reasoning is what makes the whole corpus/split design valid.
- **No onset / lead-time label.** This plan trains the *same-time diagnosis* label
  `training_corpus.label` already carries (§10.5 D1). §13.4 step 3 and §13.5's open
  item 4 (diagnosis vs. lead-time-shifted onset) stay open, and the `severity`-column follow-up
  §13.4 records is not built here. Reason: `training_corpus` has no per-row severity or
  onset signal, so an onset label cannot be built from it without new columns and a new
  materialization pass — a separate piece of work with its own ML review.
- **No hyperparameter search.** Fixed, versioned hyperparameters only (§14.2.4). Searching against
  the same held-out split the promotion gate uses would overfit the gate itself, and there is no
  third split to search against.
- **No automatic promotion, ever, under any recommendation.** §14.4.1.
- **No automatic rollback on a monitoring signal.** Monitoring displays; a human decides — same
  posture as promotion.
- **No alerting/paging.** No such infrastructure exists in this repo. Thresholds are rendered as
  chips on a page, not enforced.
- **No training on `data/pump-telemetry/`.** §13.3 settled this: the synthetic corpus is for
  exercising machinery, not for producing a model whose numbers get reported as evidence. It is
  not an entry point into `training_corpus` and this plan does not add one. It *is* usable to
  smoke-test §14.2's fitting code offline (§14.10.3).
- **No Tier 2 replacing Tier 1.** Tier 2 augments, never replaces, per §3.5. Tier 1 remains
  the sole flagging authority; Tier 2 contributes a predicted label and confidence alongside it.
- **No scheduler/cron for retraining.** Admin-triggered only. A cadence can be added later once
  there's evidence about how often the corpus actually grows.
- **No multi-pump support**, per §1.

---

## 14.2 Design: the fitting code

### 14.2.1 D19 — a separate, explicit `features.py`; no ad-hoc flattening at either call site

**§15 note — two feature spaces coexist, deliberately, not by accident.** This 54-feature
`FEATURE_ORDER` is what a model trained from `training_corpus` uses (admin-uploaded CSVs,
mapped/validated through §10.4's Stage A/B/C into a real `featureSnapshot` per row — §15.2/
D52). It is **not** what §15.1/D51's bootstrap model uses: `train.csv` has six raw values, no
window statistics to derive 54 features from, so the bootstrap model has its own, separate,
much smaller `FEATURE_ORDER` in the same-named `pdm/app/features.py` file. Whichever model is
currently the deployed champion determines which vector shape `model.py::score()` actually
builds at serve time — `metadata.json`'s persisted `feature_order` (this section, below) is
what tells the loader which one it's looking at, and the hard-fail-on-mismatch behavior this
section specifies is exactly what catches a champion swap that changes vector shape, not just
a code-vintage mismatch within one shape. This is a real architectural fact to keep straight
during implementation, not just documentation to reconcile.

`featureSnapshot` is a nested JSON object (§3.3's fixed composition: full
`precapFeaturesByMetric` + full `metricStats`, all six metrics, identical across event types).
A model needs an ordered numeric vector. That transform is the single highest-risk piece of
train/serve skew in this whole plan — if training orders features one way and live scoring
another, the model produces confident nonsense with no error anywhere.

New `pdm/app/features.py`, the **only** place that transform exists:

- `FEATURE_ORDER` is *derived*, not hand-typed: the sorted cross-product of the six metric names
  (from `pump-physics.yaml`, the existing shared source per §11.6.1) × the three
  `precapFeaturesByMetric` keys (`rawStdDev`, `rawRateOfChange`, `rawMaxExcursion`) and the six
  `metricStats` keys (`mean`, `median`, `min`, `max`, `stdDev`, `last`) — 6 × 9 = **54
  features**. Deriving it from the shared config means a metric added to `pump-physics.yaml`
  can't silently produce a differently-shaped vector on one side only.
- `to_vector(feature_snapshot, feature_order)` returns a `list[float]`, and **raises on a
  missing or non-numeric key** rather than substituting 0.0 or NaN. A silently-zeroed feature is
  indistinguishable from a real reading of zero for several of these metrics.
- **The exact `feature_order` list used at fit time is persisted in the artifact metadata**
  (§14.3.2) and re-read at load time, never recomputed from the current code. Loading an artifact
  whose stored order disagrees with the current `FEATURE_ORDER` is a hard load failure (§14.3.4) —
  that's a code-vintage mismatch, not something to paper over.
- Rows whose snapshot fails `to_vector` are **excluded from training and counted** in the run
  result (`skippedRowCount` + per-reason tally), never silently dropped. At serve time a failing
  snapshot means `score()` returns `None` for that window — Tier 1 is unaffected, exactly as if
  no model were loaded.

### 14.2.2 D20 — Random Forest is the default; XGBoost is config-gated, not a second code path

`pdm/app/training.py::fit_model(train_rows, *, config) -> FittedModel`, wrapping
`sklearn.ensemble.RandomForestClassifier` by default with
`PDM_MODEL_FAMILY=random_forest|xgboost` selecting the estimator. Reasoning:

- At the scale the promotion gate itself requires (§10.5: `MIN_ONSET_EPISODES = 100`
  fault-labeled buffers), with 54 tabular features and 8 classes of very uneven support, a
  Random Forest with `class_weight='balanced'` is the better-behaved default — no learning rate,
  no early-stopping split to carve out, no native-library build to pin.
- XGBoost stays available because §10.1 fixed the *family* as "Random Forest / XGBoost", and
  removing half of that would be a scope change made silently. It is a one-line estimator swap
  behind the same `FittedModel` interface, not a parallel pipeline.
- **Whichever is used is recorded per run** (`modelFamily` in the artifact metadata and in the
  training-run record), so a comparison between two runs can never quietly be a comparison
  between two families.

`FittedModel` exposes exactly two things: `predict(rows) -> list[str]` (the shape
`promotion.py::evaluate_candidate` already consumes — verified against its signature at
`promotion.py:81`, so **no change to `promotion.py` is required**) and `predict_with_confidence(row)`
returning `(label, probability)` for the live path.

### 14.2.3 D21 — `run_retrain()` keeps its injectable seam; training is a new default, not a replacement

`retrain.py::run_retrain()` currently takes `predict_fn` and is exercised by 26 passing Python
tests with fixture functions (§10.5's "Tested" note). Breaking that signature would throw
away the only test coverage the orchestration has.

New signature, backward-compatible:

```
run_retrain(conn, predict_fn=None, *, train_fn=training.fit_model,
            champion_metrics=None, champion_run_id=None,
            test_episode_fraction=0.2, artifact_root=None)
```

- `predict_fn is not None` → today's behavior exactly, no fitting, no artifact. Existing tests
  pass untouched.
- `predict_fn is None` → fit `train_fn(split["trainRows"])`, write the artifact (§14.3.2), and use
  the fitted model's `predict` as the `predict_fn` for `evaluate_candidate`.
- The result dict gains `artifactPath`, `artifactSha256`, `modelFamily`, `trainingConfigVersion`,
  `featureOrder`, `labelClasses`, `trainRowCount`, `testRowCount`, `skippedRowCount`, `seed`.
  `recordTrainingRun.js` already forwards `result.artifactPath ?? null`, so that one field needs
  no change there; the rest need new columns (§14.5.1).

The order of operations matters and is easy to get wrong: **the evaluation gate is checked
before anything is fitted** (unchanged — `check_evaluation_gate` before `walk_forward_split`),
and **the artifact is written before the promotion decision is computed**, because a
non-recommended candidate must still be inspectable and still be approvable by an admin
override (§14.4.1). A candidate whose artifact was never written is not a candidate an admin can
act on.

### 14.2.4 D22 — hyperparameters live in a versioned YAML, mirroring `thresholds.yaml`

`pdm/app/training_config.yaml`, with a top-level `version:` string bumped by hand on every
change — the same mechanism `thresholds.yaml` already established for Tier 1 (§3.1.1), for
the same reason: the value recorded on a run must identify the configuration, and it must not
require git at runtime. Contents: `modelFamily`, per-family hyperparameters, `seed`,
`classWeight`. `trainingConfigVersion` is recorded on every run.

Determinism: `random_state` from a single configured `seed`, `n_jobs: 1` by default. Two runs
over the same corpus manifest with the same config version must produce the same
`artifactSha256`. This is testable (§14.10.3) and is what makes "did the corpus change or did the
config change?" answerable after the fact — the same reproducibility value §10.5's D4
(`corpusRowManifest`) was added for.

### 14.2.5 D23 — no class is dropped for thin support

Every label present in the corpus is trained on, including `OTHER` and including a class with
two examples. Dropping a class would mean discarding human-confirmed ground truth (the same
reasoning as §10.5's D6, which made the class-balance check warn-only for human-sourced
paths). Thin support is handled where it was already handled: `decide_promotion`'s
`min_support_per_class` excludes such classes from the *decision* while still *reporting* them,
and `OTHER` is structurally excluded from the gate (D1/D8). No change to `promotion.py`.

---

## 14.3 Design: artifacts

### 14.3.1 D24 — artifacts are files on a `pdm`-owned volume; the DB holds the pointer, not the bytes

A new named volume `pdm_artifacts` mounted at `/artifacts` in the `pdm` service, with
`PDM_ARTIFACT_ROOT=/artifacts`. Not Postgres bytea, not the repo, not a bind-mount into
`server/`.

**This is not a violation of §3.4's invariant, and the plan must say so explicitly** because
the invariant gets cited constantly and a reader will otherwise flag this. The invariant, as
§10.6 item 2 restated it when the read-only corpus role landed, is *"Python never writes
**application data**"* — i.e. never writes `raw_telemetry`, `processed_telemetry`,
`fault_events`, `training_corpus`, or `training_runs`. A model artifact is not application data;
it is Python's own build output, written by the process that produced it, and every *database
row about it* is still written exclusively by Node (§14.4.5). §10.6 item 2 already anticipated
exactly this: *"Whatever model artifacts/training-run metadata Python does need to persist ...
can live in Python's own store without touching Node's tables at all."* This is that store.

Node never reads artifact bytes and never mounts the volume — it only ever handles the
`artifactPath` string. That keeps one owner for the artifact filesystem and avoids a second
process's permission model on the same directory.

### 14.3.2 D25 — layout, naming, and why the path can't contain the run id

```
/artifacts/
  runs/
    20260819T101500Z-a3f19c2b8d04/     # <trainedAt compact>-<corpusContentHash[:12]>
      model.joblib
      metadata.json
      SHA256SUM
```

`training_runs.artifactPath` stores the path **relative to `PDM_ARTIFACT_ROOT`**
(`runs/20260819T101500Z-a3f19c2b8d04/model.joblib`), not an absolute path — so remounting the
volume elsewhere, or moving `pdm` to its own CT (§1's intended deployment), doesn't
invalidate every historical row.

**Why the directory isn't keyed by `training_runs.id`:** the id doesn't exist yet when the
artifact is written. Python writes the artifact, hands the result to Node, and *Node* does the
`INSERT ... RETURNING id` (§14.4.5). Keying on the id would require either Python writing the row
(forbidden) or a rename round-trip after the insert (a new failure mode where the row points at
a path that no longer exists). `trainedAt` + corpus hash is unique in practice and is
independently meaningful — it answers "which corpus produced this" without a join.

`metadata.json` (authoritative, ships with the artifact) carries: `featureOrder`, `labelClasses`,
`modelFamily`, `trainingConfigVersion`, `seed`, `corpusContentHash`, `corpusRowCount`,
`featureCodeVersions` (the distinct `training_corpus.featureCodeVersion` values present in the
training rows — §10.5's D2 added that column precisely so a skew is detectable, and this is
where it becomes visible), `sklearnVersion`/`xgboostVersion`, `pythonVersion`, `trainedAt`,
`trainRowCount`/`testRowCount`/`skippedRowCount`.

The load-critical subset is **mirrored** into a new `training_runs."artifactMeta"` JSONB column
(§14.5.1) so the admin page and any investigation can answer "why won't this load" from one SQL
query, without the artifact volume. The sidecar remains authoritative on a mismatch, and a
mismatch is itself a reportable condition.

### 14.3.3 D26 — `pdm` reads its own champion pointer from `training_runs`; the read-only grant widens by one table

`pdm` needs to know which artifact is champion. Three options were considered:

1. **Grant `SELECT` on `training_runs` to `pdm_corpus_readonly`** and let `pdm` query it at
   startup.
2. Have Node push the champion to `pdm` over HTTP at Node's startup and on every promotion.
3. Have Node write a `champion.json` pointer into the artifact volume.

**Chosen: (1), with (2) as an additive hot-swap trigger, not as the source of truth.**

- (3) is rejected outright: it makes Node a writer to `pdm`'s filesystem, creating a second
  owner of that directory and a second source of truth alongside `training_runs.promoted`.
- (2) alone is rejected as the *only* mechanism because it makes `pdm`'s model state depend on a
  Node call: restart `pdm` and it serves Tier 1 only until Node happens to push again. That is a
  silent degradation, and §11.3 already established that this system prefers visible
  failure to silent wrongness.
- (1) does widen the read-only role's scope beyond the "scoped to `training_corpus` only"
  description in §10.6 item 2. That widening is deliberate and small: `training_runs` is
  metadata about `pdm`'s own runs, it is read-only, and it removes a startup-order dependency
  between two services. **The invariant that matters is untouched** — `pdm_corpus_readonly` gets
  `SELECT` and nothing else, and Python still never writes. Grant added in the same conditional
  `DO $$ ... $$` style `005_training_corpus.sql` already uses for `training_corpus`.

**Startup must be non-fatal.** `model.py` loads lazily and defensively: DB unreachable, no
promoted run, null `artifactPath`, missing file, checksum mismatch, or feature-order mismatch →
log the specific reason, leave the model unloaded, `score()` returns `None`, `/health` stays
`ok`. A Tier 2 problem must never take down `/process-window`, because since §11's cutover
that endpoint is on the critical path for `processed_telemetry`, the dashboard, forecast, drift
and trend (§11.3). This is the single most important behavioral constraint in this section.

### 14.3.4 D27 — Tier 2 augmentation goes into `/process-window`, not just `/score`

Per §14.0 items 5 and 6, the currently-scaffolded augmentation point is on the endpoint the live
path no longer uses, and the response model would strip the fields anyway. Both need fixing:

- `pdm/app/preprocessing/pipeline.py` — after `rules.evaluate(...)` at line 222, call
  `model.score(processed_record)` and merge a non-`None` result into `tier1_verdict` the same way
  `main.py:31` does. Keep `main.py`'s `/score` augmentation too, for the back-compat
  `POST /api/processed` path that `pdmService.js` still falls back to.
- **Better: extract the merge into one function** (`model.augment(verdict, processed_record)`)
  called from both places, so a third call site can't diverge. Two independent merges of the
  same two dicts is the same duplication problem §11.1 rejected for feature computation.
- `pdm/app/schemas.py::ScoreResponse` gains optional Tier 2 fields:
  `tier2Label`, `tier2Probability`, `tier2ModelRunId`, `tier2ArtifactSha256` (short form).
  All `Optional[...] = None`, so every existing consumer and every existing test is unaffected
  when no model is loaded. `ProcessWindowResponse.tier1Verdict` is typed as `ScoreResponse`
  (`schemas.py:194`), so it inherits these automatically — verified.
- **Naming note, deliberate:** the field on the wire stays `tier1Verdict` even once it carries
  Tier 2 fields, because renaming it would break `pipeline.js`, `pdmService.js`, and the parity
  fixtures for no functional gain. Its docstring must say "Tier 1 verdict, augmented with Tier 2
  fields when a model is loaded" so the name doesn't mislead. Flagged rather than silently left.
- `tier2ModelRunId` requires `model.py` to know which `training_runs.id` it loaded — it does,
  since D26 has it query `training_runs` for the champion. This is what makes §14.6's prediction
  monitoring attributable to a specific model.

### 14.3.5 D28 — hot reload on promotion, and the loaded-vs-champion mismatch is a first-class displayed state

- `POST /model/reload` on `pdm`: re-runs the champion lookup and swaps the in-memory model
  atomically (build fully, then rebind the module-level reference — never mutate in place while
  requests are in flight). Returns the resulting status.
- `GET /model/status` on `pdm`: `{loaded, runId, artifactPath, artifactSha256, loadedAt,
  lastLoadError, featureOrderHash, modelFamily}`.
- **Auth for these two endpoints is the network boundary, and that is sufficient here.** `pdm`
  publishes no ports and sits on the `data` network only (§14.0 item 10) — the only container that
  can reach it is `backend`. Adding a second auth mechanism inside `pdm` (a shared secret, a
  token) would be inventing one where none exists elsewhere in this service; `/score` and
  `/process-window` already rely on exactly this boundary. Stated explicitly so a reviewer
  doesn't read the omission as an oversight. **If `pdm` is ever moved to its own CT (§1) and
  reachable beyond a private network, this decision must be revisited** — noted in the risk
  register.
- Node calls `/model/reload` after a successful approval, fire-and-forget-**but-caught** with a
  2s timeout, matching the discipline §3.4 established and §10.5 reused.
- **If reload fails, the DB says champion X and `pdm` is still serving Y.** That mismatch is
  detected by comparing `GET /model/status`'s `runId` against `trainingRunModel.getChampion()`
  and is rendered as an explicit warning banner on the admin page (§14.7.3), with a manual "Reload
  model" button. A silent mismatch here would mean the admin believes they deployed something
  they didn't — the single worst failure mode this plan can produce.

### 14.3.6 D29 — artifact retention is `pdm`'s job, and never prunes a rollback target

During each retrain, `pdm` prunes artifacts beyond `PDM_ARTIFACT_KEEP_RUNS` (default 10), oldest
first, **never** deleting: the current champion, any run whose `promoted` was ever true (queried
via the D26 grant — a `promotedAt IS NOT NULL` check, §14.5.1), or anything newer than
`PDM_ARTIFACT_MIN_AGE_HOURS`. Rollback (§14.4.3) is only possible while the older artifact still
exists, so "retain previous artifacts so a bad promotion can be rolled back" (§10.5) is a
hard constraint on the pruner, not a nice-to-have.

Orphan sweep: an artifact directory with no corresponding `training_runs` row older than the
min-age (i.e. Python wrote it but Node's insert never happened — §14.4.5's crash window) is
deleted by the same pass.

---

## 14.4 Design: human-in-the-loop promotion

### 14.4.1 D30 — `decide_promotion()` becomes a recommendation, and is *necessary but not sufficient*

**§15 note:** everything below assumes champion and candidate share a label taxonomy — true
for every case this section was written against. §15.5/D55 resolves the one case that doesn't
(the planned binary-bootstrap → multi-class transition): `decide_promotion()` gains one
taxonomy-mismatch branch that bypasses the per-class floor with its own reason string, rather
than misreporting a taxonomy change as a regression. The mechanics/`recommendation`/override
rules below are otherwise unchanged, and the "`promotion.py` is not modified" line further
down is superseded by exactly that one addition — see §15.5 for the full mechanics.

The question posed was whether `decide_promotion()` stays authoritative with an admin override,
or becomes a recommendation an admin confirms. **Chosen: recommendation. No run is ever
promoted without an explicit human action.**

Reasoning, grounded in decisions this project already made:

- §10.5's own framing is *"Retrain-and-evaluate, not retrain-and-replace ... never blindly
  promote just because a retrain completed."* An automated gate that promotes on pass is still
  promote-on-completion from an operator's point of view — the gate is a floor on *metrics*, not
  a judgment about whether the corpus those metrics were computed over is trustworthy. Nothing
  in `decide_promotion()` can see that the last 30 corpus rows came from one operator's
  questionable upload.
- §10.5 D8 already loosened the gate to a support-scaled tolerance specifically so it
  *wouldn't* block forever at thin support. A gate that is deliberately generous is a poor sole
  authority for a deployment decision — the generosity was justified precisely because a human
  would be looking.
- Symmetry with the rest of this system: §3.2/§10.4 established that automated verdicts get
  human review and human assertions don't. A promotion decision is an automated verdict.

Mechanics:

- `decide_promotion()` output is stored as `recommendation` (boolean) + `promotionReason` +
  `perClassComparison`. **`promotion.py` is not modified.**
- A new run lands as `promotionStatus = 'PENDING_DECISION'` with `promoted = false`, regardless
  of recommendation.
- An admin may **approve against a negative recommendation** or **reject a positive one**. Either
  direction is an *override*, and an override requires a non-empty `decisionNotes` — the same
  escalation §10.4 applied to manual-buffer's mandatory `notes` ("this action skips review
  entirely, so the audit trail is the only check left"). A decision that *matches* the
  recommendation may have empty notes.
- **Rejecting is a real, recorded outcome, not a no-op.** A `REJECTED` run keeps its artifact
  until the pruner reaches it (so a decision can be revisited) but can never become champion
  without a fresh decision.

### 14.4.2 D31 — a stale comparison cannot be approved

`championRunIdAtEval` records which champion the candidate was compared against. If a *different*
run has been approved since (i.e. `championRunIdAtEval != ` the current champion's id), the
comparison on screen is against a model that is no longer deployed, and approving it would
deploy a candidate that was never evaluated against what it's replacing.

`POST .../approve` returns **409** in that case, with both ids and a message directing the admin
to re-run the retrain. This is the concurrency hazard of a two-actor system (a retrain job and an
approving human) and it is cheap to close at the write. Same instinct as §10.4's pre-write
overlap check (409) on manual buffers.

Additional approve preconditions, all 409/422 rather than silent: `promotionStatus` must be
`PENDING_DECISION`; `artifactPath` must be non-null; the artifact must load — verified by
calling `pdm`'s `POST /model/verify` (dry-run load, no swap) *before* flipping any DB state, so
an approval never leaves the system pointing at an unloadable artifact.

### 14.4.3 D32 — one champion, enforced by the database; rollback is re-approval of an older run

`getChampion()` today is `WHERE promoted = true ORDER BY id DESC LIMIT 1`. **This silently
breaks rollback**: re-promoting run 7 while run 9 was previously promoted would leave two rows
with `promoted = true`, and `ORDER BY id DESC` would still return run 9. Fixes, together:

- Add `promotedAt TIMESTAMPTZ`. `getChampion()` becomes
  `WHERE promoted = true ORDER BY "promotedAt" DESC NULLS LAST, id DESC LIMIT 1`.
- Enforce single-champion structurally: `CREATE UNIQUE INDEX ... ON training_runs ((true)) WHERE
  promoted` (partial unique index on a constant — the standard Postgres "at most one row
  satisfying this predicate" idiom). A bug that tries to promote two runs then fails loudly at
  the write instead of producing a system with two champions and an ordering-dependent answer.
- Approval/rollback happens in **one transaction**: demote the current champion
  (`promoted = false`, keep `promotedAt` as history), promote the target, insert an audit row.
  Reusing the ordering-by-`promotedAt` means a demoted-then-re-promoted run gets a fresh
  `promotedAt` and orders correctly.
- **Audit table `model_promotion_events`** (`runId`, `action` in
  `APPROVE | REJECT | ROLLBACK`, `actor`, `at`, `notes`, `recommendationAtDecision`,
  `championRunIdBefore`). `training_runs` holds current state; this holds history. Without it, a
  rollback overwrites the record of the promotion it's undoing, and "who deployed the model that
  was live last Tuesday" becomes unanswerable — the same reproducibility value §10.5's D4
  protected for corpora.
- `POST /api/pdm/model/runs/:id/rollback` is a distinct action from approve (different
  precondition: target must have a valid artifact and must have been `APPROVED` at some point;
  D31's stale-comparison check does **not** apply, because a rollback is explicitly a decision to
  go backwards, not a claim about a comparison).

### 14.4.4 D33 — `promoted` keeps its meaning; the new lifecycle column sits beside it

`promoted` stays "is (or was) this the champion", so `trainingRunModel.getChampion()` and
`corpusMaterializationService`'s callers need no semantic reinterpretation. `promotionStatus`
(`PENDING_DECISION | APPROVED | REJECTED | SUPERSEDED`) is the new lifecycle. `SUPERSEDED` is set
on the previous champion at approval time, so the history table isn't the only way to read "this
used to be live".

A migration backfill question that must be answered explicitly rather than defaulted: **existing
rows.** Any `training_runs` row already present (written by `recordTrainingRun.js` in the
current auto-decide flow) has `promoted` set by `decide_promotion()` with no human involved and
no artifact. Backfill: `recommendation = promoted`, `promotionStatus = 'REJECTED'`,
`promoted = false`, `promotedAt = NULL`, with a `decisionNotes` string stating it was
retroactively invalidated by this migration. Rationale: those runs have no artifact
(`artifactPath` is null for all of them, §14.0 item 4), so they cannot be champions in any
meaningful sense — leaving `promoted = true` on an artifact-less row would make `getChampion()`
return something `pdm` can never load, and D32's unique index would reject the migration outright
if more than one such row exists. This must be stated in the migration's header comment.

### 14.4.5 D34 — retrain runs as an HTTP job on `pdm`; Node still does every write

Per §14.0 item 9, the documented `python | node` pipe cannot work in the deployed topology. And a
retrain is a minutes-long operation, so it cannot ride the 2s-timeout fetch pattern the rest of
the Node↔Python boundary uses.

Chosen transport — deliberately the smallest thing that works, matching §11.5 item 2's
explicit preference for "lowest infrastructure cost" over new queue/worker infrastructure
(which §4.5 notes this codebase still doesn't have):

- `POST /retrain` on `pdm` → starts a FastAPI `BackgroundTasks` job in a **single in-process
  slot**. Returns `202 {jobId, startedAt}`. A second concurrent request gets **409** with the
  running job's id. Request body carries `championMetrics` and `championRunId`, sourced by Node
  from `trainingRunModel.getChampion()` — matching `run_retrain`'s existing contract
  (`retrain.py:41-55` documents exactly this: "Looked up via `trainingRunModel.getChampion()` on
  the Node side and passed through by the caller"). Keeping that contract means D26's grant is
  used only for the champion *artifact pointer*, not for metrics, and there's one source of truth
  for what the candidate was compared against.
- `GET /retrain/:jobId` → `{status: RUNNING|SUCCEEDED|FAILED|ABORTED, result?, error?}`. The
  `RetrainResult` is held in memory until read, then retained for a short TTL.
- **Node polls, then writes.** `POST /api/pdm/model/retrain` (admin) kicks the job and returns
  the `jobId`; the admin page polls `GET /api/pdm/model/retrain/:jobId` (a thin proxy), and on
  `SUCCEEDED` the **backend** performs the `training_runs` INSERT. Python never writes Postgres.
- The insert logic is **extracted from `recordTrainingRun.js` into
  `server/services/trainingRunService.js`**, so the CLI script and the new controller share one
  implementation. `recordTrainingRun.js` stays as a thin stdin wrapper — it's still the right
  tool for an offline/dev-host run and deleting it would remove the only path that works without
  the backend running.
- **Failure modes, stated because they're accepted rather than solved:** `pdm` restarting
  mid-job loses the job and its result; the artifact may already exist and becomes an orphan
  (swept by D29). `ABORTED` on `MIN_ONSET_EPISODES` not met (`RetrainAbortedError`) is a normal,
  displayed outcome, not an error — the page shows `episodeCount/required` from the gate. Node
  polling stops after `PDM_RETRAIN_POLL_TIMEOUT` and reports "job lost" rather than polling
  forever.

---

## 14.5 Work items — data layer

### 14.5.1 Migration `007_model_ops.sql`

`training_runs` — additive columns:

| Column | Type | Why |
|---|---|---|
| `recommendation` | BOOLEAN NOT NULL DEFAULT false | `decide_promotion()`'s output, separated from the human decision (D30) |
| `promotionStatus` | TEXT NOT NULL DEFAULT 'PENDING_DECISION' + CHECK | lifecycle (D33) |
| `promotedAt` | TIMESTAMPTZ | correct champion ordering + rollback (D32) |
| `decidedBy` / `decidedAt` / `decisionNotes` | TEXT / TIMESTAMPTZ / TEXT | audit of the human action (D30) |
| `artifactSha256` | TEXT | load-time integrity check (D25) |
| `artifactMeta` | JSONB | mirrored load-critical metadata (D25) |
| `perClassComparison` | JSONB | already computed by `decide_promotion` and currently thrown away — the comparison view's primary data source (§14.7.4) |
| `modelFamily` / `trainingConfigVersion` / `seed` | TEXT / TEXT / INTEGER | run comparability (D20, D22) |
| `trainRowCount` / `testRowCount` / `skippedRowCount` | INTEGER | evaluation context; skipped rows are a data-quality signal (D19) |

Plus: the partial unique index enforcing one champion (D32); the D33 backfill of existing rows,
with its reasoning in the header comment; `GRANT SELECT ON training_runs TO pdm_corpus_readonly`
in the same conditional `DO $$` form `005` uses (D26).

New `model_promotion_events` table (D32). New `tier2_predictions` table (§14.6.2). Down migration
drops the new tables and columns and reverses the grant.

### 14.5.2 Models

- `trainingRunModel.js` — `insertRun()` extended for the new columns; `getChampion()` reordered
  per D32; new `getRunById`, `listRunsWithDecision(n)`, and a **transactional**
  `decideRun({runId, action, actor, notes, ...})` that demotes/promotes/audits in one `BEGIN ...
  COMMIT`. This is the first place in this repo needing an explicit multi-statement transaction
  on a `pg` pool — it must take a client from the pool and release it in a `finally`, not use
  `pool.query` three times.
- New `modelPromotionEventModel.js` — insert + list by run.
- New `tier2PredictionModel.js` — insert; the four monitoring aggregate queries (§14.6).

### 14.5.3 Services

- New `server/services/trainingRunService.js` — the insert path extracted from
  `recordTrainingRun.js` (D34), plus `decide()` wrapping D31's preconditions and D32's
  transaction, plus the post-approval `pdm` reload call.
- New `server/services/modelMonitoringService.js` — §14.6's metric computation.
- `pdmService.js` — persist a `tier2_predictions` row when the verdict carries `tier2Label`
  (§14.6.2). Must follow the existing discipline exactly: caught, never allowed to affect
  ingestion, no new await inside the coalescing critical path.

### 14.5.4 Controllers + routes

New `server/controllers/modelOpsController.js`, all routes
`requireTrustedProxy` + `requireGroup(PDM_ADMIN_GROUP)`:

```
POST   /api/pdm/model/retrain                  # kick a job -> 202 {jobId}
GET    /api/pdm/model/retrain/:jobId           # proxy pdm's job status
GET    /api/pdm/model/runs                     # history + decisions
GET    /api/pdm/model/runs/:id                 # one run + perClassComparison + artifactMeta
GET    /api/pdm/model/champion                 # champion row + pdm's loaded status + mismatch flag
POST   /api/pdm/model/runs/:id/approve         # {notes} — D30/D31
POST   /api/pdm/model/runs/:id/reject          # {notes}
POST   /api/pdm/model/runs/:id/rollback        # {notes} — D32
POST   /api/pdm/model/reload                   # manual reload after a failed auto-reload (D28)
GET    /api/pdm/model/monitoring               # §14.6
GET    /api/pdm/external-upload                # list uploads (§14.8.4)
DELETE /api/pdm/external-upload/:uploadId      # retract (§14.8.4)
```

Route-ordering note, same trap §3.6's `/stats` hit: `/api/pdm/model/retrain` and
`/api/pdm/model/champion` must be registered before `/api/pdm/model/runs/:id` — they don't
actually collide (different segment counts) but the file's existing convention is
specific-before-generic and should be followed.

`PDM_ADMIN_GROUP` is declared next to `PDM_REVIEWER_GROUP` at the top of `routes/index.js`,
default `'pdm-admins'`, added to `.env.example` and `docker-compose.yml`'s `backend`
environment.

---

## 14.6 Design + work items: continuous monitoring

### 14.6.1 D35 — six metrics, all computed in Node, none of them requiring the model

Per §14.0 item 13 there is nothing to monitor today. Concretely measurable, with the honest caveat
each one needs:

1. **Champion staleness.** Days since `trainedAt`; corpus rows added since the champion's
   `corpusRowManifest` (a set difference on `(bufferId, windowEnd)` — this is exactly what §10.5's
   D4 persisted the manifest *for*), and how many of those are fault-labeled. Answers
   "is a retrain worth doing" without running one. Pure SQL.
2. **Tier 2 prediction volume + label distribution over time.** Daily counts per predicted label
   from `tier2_predictions`, next to the champion's training class prior (from `artifactMeta`).
   A live distribution diverging sharply from the training prior is the cheapest real drift
   signal available. Pure SQL.
3. **HITL agreement on reviewed windows.** Join `tier2_predictions.processedTelemetryId` to
   `fault_events.processedTelemetryId` for `status = 'CONFIRMED'` rows and compare
   `predictedLabel` to `faultType`; report a confusion breakdown. This is the Tier 2 analogue of
   §3.6's `GET /pdm/fault-events/stats` and belongs beside it conceptually.
   **Caveat that must be rendered on the page, not just written here:** ground truth only ever
   arrives for windows Tier 1 flagged (or a human manually entered), so this is *agreement on
   reviewed windows*, a biased sample — never "live accuracy". Labeling it accuracy would be
   exactly the fabricated confidence §13.3 refused for the synthetic corpus.
   Second caveat: §10.5's auto-labeling path (migration 003, `autoLabeled = true`) produces
   `CONFIRMED` rows no human actually reviewed. Those must be **excluded** from the agreement
   numerator/denominator, or the metric partly measures Tier 1's rule-matching against itself.
4. **Model input drift, per metric.** Mean/stddev of the six metrics over `processed_telemetry`
   for the last 7 days vs. the same statistics over the champion's training rows, reported as a
   standardized difference `|Δmean| / σ_train` per metric. Deliberately six interpretable
   numbers rather than a KS/PSI battery over 54 features — an admin has to be able to act on it.
   **Check before building:** a `driftService.js` already exists in this repo for a different
   purpose (`GET /api/drift`). Reuse it if its statistic is the right one; otherwise name this
   distinctly (`modelInputDrift`) and cross-reference, rather than shipping a second thing
   called "drift" with no stated relationship to the first.
5. **Corpus composition drift.** Class counts in `training_corpus` now vs. in the champion's
   manifest, broken down by `sourceType`. This is the whole-corpus balance concern §10.5
   raised ("if operators only ever upload fault examples...") made continuously visible instead
   of only checked at write time by `checkClassBalance`.
6. **Deployment integrity.** `pdm`'s `GET /model/status` vs. `getChampion()` — loaded run id,
   artifact checksum, `lastLoadError`, mismatch flag (D28).

**Where computed: Node, all six.** Every one is a SQL aggregate over Node-owned tables, and Node
is the only writer. Pushing any of it into Python would mean widening the read-only role further
(D26 widened it by exactly one table, on purpose) for no analytical benefit — none of these
metrics needs the model itself. One endpoint, `GET /api/pdm/model/monitoring`, returns all six;
the page polls it on a slow interval (60s, matching `faultEventStats`'s existing cadence in
`PredictionsPage.jsx`).

### 14.6.2 D36 — `tier2_predictions` is its own table, not columns on `fault_events`

Tier 2 predicts on **every** closed window; `fault_events` only has rows for flagged windows and
periodic negative samples. Hanging predictions off `fault_events` would discard the majority of
them and make metric 2 (distribution over time) impossible. (§15.3/D53 also puts
`tier2FaultStatus`/`tier2Confidence` on `fault_events` — that's additive, scoped to rows that
already exist for other reasons, not a replacement for this table; see §15.3's correction.)

```
tier2_predictions (
  id, "processedTelemetryId", "windowEnd",
  "predictedLabel", "probability",
  "modelRunId"      -- which training_runs row produced it (D27's tier2ModelRunId)
  "artifactSha256", "createdAt"
)
```

- Written by `pdmService.js` from the augmented verdict, in the same caught/never-blocking style
  as everything else on that path.
- Volume: one row per minute ≈ 525k/year — small, but unbounded. `processed_telemetry` is
  already a Timescale hypertable, so the convention for this exists; **verify** whether
  002/001's hypertable + retention pattern applies cleanly to a table with a `BIGSERIAL` primary
  key before committing to it (002's own header discusses why `fault_events` deliberately isn't
  one). Fallback: plain table + a prune in the existing `server/scripts/` cleanup style, matching
  `cleanupStaleUploads.js`.
- `processedTelemetryId` gets no enforced FK, consistent with `fault_events`' documented
  convention for referencing the hypertable (002's header).

---

## 14.7 Design + work items: the admin-only page

### 14.7.1 D37 — `PDM_ADMIN_GROUP` is a new, stricter tier; no group hierarchy in code

Investigated (§14.0 item 7): no admin concept exists. `PDM_REVIEWER_GROUP` is the only group any
code checks.

**Decision: introduce `PDM_ADMIN_GROUP` (default `'pdm-admins'`) as a distinct group, not a
rename of the reviewer group and not a superset implemented in code.**

- The trust claims are genuinely different in blast radius. A reviewer asserts ground truth about
  *one* fault event (§10.4's reasoning for why that needs no second reviewer). An admin
  changes which model classifies *every future window*. Gating the second on the first would
  mean everyone who can label a fault can also deploy a model.
- **No "admin implies reviewer" logic in code.** Each route declares exactly the group it needs.
  An operator who needs both capabilities is put in both groups in Authentik — configuration,
  not code. Implementing a hierarchy would be a second auth mechanism alongside
  `requireGroup()`, which the brief explicitly rules out and which this codebase has no
  precedent for.
- Consequence to handle deliberately, not discover later: **an admin who is not also a reviewer
  gets 403 from the upload endpoints** (which stay reviewer-gated, §14.8.2). The page must therefore
  gate the upload panel on the *reviewer* flag and the promotion panel on the *admin* flag,
  independently (§14.7.2).

### 14.7.2 D38 — the server is the boundary; `/whoami` computes the booleans so the group name never lives in the client

- Every new route: `requireTrustedProxy` + `requireGroup(PDM_ADMIN_GROUP)`. That is the real
  boundary. **Client-side gating is cosmetic** — it hides a nav item, nothing more, and must be
  documented as such in `App.jsx` so a future reader doesn't treat it as security.
- The client needs to know whether to show the page. Two options: a `VITE_PDM_ADMIN_GROUP` build
  arg, or have `/api/whoami` return derived booleans. **Chosen: derived booleans** —
  `whoamiController.js` returns `{...req.identity, isAdmin, isReviewer}` computed from the same
  env vars the routes use. One source of truth for the group names; a build-time copy in the
  client could drift from the server's and produce a UI that offers actions the API rejects.
  Small additive change; existing consumers of `/whoami` are unaffected.
- **The dev bypass must be stated in the plan** so it isn't mistaken for a hole later:
  `requireGroup()` and `requireTrustedProxy()` both call `next()` when `NODE_ENV` is
  `development` or `test` (`authentikIdentity.js:49-75`). `docker-compose.yml` sets
  `NODE_ENV: production` explicitly on `backend` for exactly this reason. `/whoami`'s derived
  booleans must mirror that bypass, or a local dev run will render a page whose API calls
  succeed but whose nav item is hidden.

### 14.7.3 D39 — one page, five panels, following the existing client conventions exactly

`client/src/pages/ModelOpsPage.jsx`, reached the same way every other page is: a new `page` id
in `App.jsx`'s `useState`, a new entry in `Sidebar.jsx`'s `PAGES` under a second nav heading
("Administration", alongside the existing "Monitor"), rendered only when `isAdmin`. No router is
introduced — `App.jsx` has never had one and adding one for a single page is scope creep with a
real regression surface. `usePolling` for data, `Card`/`CardLabel`/`buttonReset` for chrome,
inline styles, `memo` on the default export — matching `PredictionsPage.jsx` throughout.

Panels:

1. **Deployed model** — champion run id, `trainedAt`, `modelFamily`, corpus hash + row count,
   `decidedBy`/`decidedAt`, staleness (metric 1), and the loaded-vs-champion state from D28 with
   a "Reload model" button. Renders an explicit empty state ("No Tier 2 model is deployed — Tier
   1 rules only") rather than blanks, since that is the state on day one and for a long time
   after.
2. **Retrain** — evaluation-gate readiness (`episodeCount / MIN_ONSET_EPISODES`, disabling the
   button and explaining *why* when not met, since that will be the state until 100 fault
   buffers exist), a "Retrain now" button, and running-job status.
3. **Candidate vs champion** (§14.7.4) — the comparison view and the approve/reject action.
4. **Run history** — every run with recommendation, decision, actor, and corpus hash; a run
   row expands into its own comparison view; a previously-approved run offers "Roll back to
   this".
5. **Monitoring** — §14.6's six metrics.
6. **Training data upload** — §14.8, gated on `isReviewer`.

### 14.7.4 D40 — the comparison view leads with per-class, and labels `overallAccuracy` as non-decisive

Straight from `perClassComparison` (§14.5.1's new column) — one row per label:

| Label | Cand. precision | Champ. precision | Cand. recall | Champ. recall | Support (cand/champ) | Tolerance | Verdict |
|---|---|---|---|---|---|---|---|

- Excluded classes render with their reason, never omitted — `promotion.py` deliberately reports
  them (`{"included": false, "reason": "insufficient support" | "excluded from gate (OTHER)"}`),
  and dropping them from the UI would hide from the admin exactly what the gate couldn't judge.
- The `"candidate has zero support/predictions for a class the champion was evaluated on"` case
  gets its own prominent treatment — that's a forgotten-class regression, the most consequential
  single failure the gate detects.
- The recommendation banner shows `promotionReason` verbatim (it's written to be human-readable
  and is always populated, pass or fail).
- **`overallAccuracy` is displayed small and explicitly labeled "informational only — not part of
  the promotion gate."** `promotion.py`'s own comment says it is "NEVER used by
  decide_promotion — that's the whole point of the per-class floor: an aggregate can't hide a
  regression." A UI that leads with one number would reintroduce, at the human layer, exactly the
  failure mode D8's per-class floor was built to prevent. This is the same anchoring concern
  §3.2 raised about surfacing Tier 1's `confidence` to reviewers, applied to a different actor:
  the fix isn't hiding the number, it's not letting it be the headline.
- Approve/Reject buttons with a notes field that becomes **required** when the action contradicts
  the recommendation (D30), with the requirement stated in the UI before submission rather than
  surfaced as a 400.
- Corpus provenance for the candidate — row count and per-`sourceType` breakdown — sits beside
  the metrics, because "should I trust these numbers" is largely a question about where the
  corpus came from, and that context is the thing `decide_promotion()` structurally cannot see.

---

## 14.8 Design + work items: upload from the admin page

### 14.8.1 D41 — this is (a): expose the existing endpoints. No new upload/mapping backend.

The brief asks whether the admin-page upload is (a) a UI over the existing endpoints or (b) new
backend surface. **It is (a)**, and §14.0 item 14 is the evidence: `handleUpload`'s return value is
already precisely a mapping screen's input (surviving headers, auto-excluded columns, detected
timestamp column, row count, median interval, warnings), and `confirmUpload`'s
`requiresConfirmation` + `rangeSanityWarnings` + `confirmRangeOverride` is already a two-phase
"we think your mapping or units may be wrong, confirm to proceed" contract. §10.4.1 built
this deliberately as "the endpoints a future screen would call" and it holds up.

Building a second upload path would duplicate Stage A/B/C's gate — the exact duplication
§10.4/§11.1 rejected twice on principle, and the one place in this system where data hygiene is
a hard accept/reject gate (§10.4.1 D12). Nothing about a screen changes the data-trust
argument.

### 14.8.2 D42 — upload stays reviewer-gated; retraction is admin-gated

Uploading does not become an admin action just because the button now lives on an admin page.
§10.4.1's reasoning ("the human-trust model is identical across all three CONFIRMED-creating
paths; only the *data*-trust bar differs, enforced by Stage C") is unchanged, and raising the bar
would silently remove a capability existing reviewers have. `DELETE .../external-upload/:id`
(retract, §14.8.4) is **admin**-gated: it deletes corpus rows, which is a corpus-integrity action of
the same class as promotion, not a data-contribution action.

### 14.8.3 Two small contract fixes, both required

1. **Multipart through the client wrapper.** `client/src/api/client.js:13` unconditionally sets
   `Content-Type: application/json`. A `FormData` body needs the browser to set the header
   *including its generated boundary*. Fix: let `request()` omit the default when the body is a
   `FormData` instance (or when an explicit `undefined` content type is passed). Without this the
   upload fails with a Stage A parse error that looks like a bad file.
2. **Unit options must come from the server.** The per-metric allowed-unit lists live in
   `server/utils/unitConversion.js`, including §10.4.1 D13's deliberate exclusion of `g` for
   vibration. Hardcoding them in the client creates a second copy that can drift — and a drifted
   copy here corrupts the corpus silently (a wrong declared unit is, per §10.4.1 item 6,
   "just as corrupting as a wrong name match"). Fix: **embed a `mappingOptions` block in the
   Stage A response** (`{metrics: [{key, label, units: [...]}]}`) rather than adding a route —
   the list is only ever needed immediately after an upload, and zero new endpoints is the
   smaller change.

### 14.8.4 Genuinely new surface, and why it's justified

- `GET /api/pdm/external-upload` — list uploads with status/outcome. `external_uploads` has no
  read endpoint at all today, so an operator has no way to see that yesterday's upload was
  `STAGE_C_REJECTED` and why.
- `DELETE /api/pdm/external-upload/:uploadId` — calls the existing
  `corpusMaterializationService.js::retractUpload(uploadId)`. Per §14.0 item 15 that function was
  added during §10.4.1's review specifically as the `EXTERNAL_UPLOAD` equivalent of the
  `onFaultEventRejectedOrExcluded` retraction path, and it currently has **no way to be
  invoked**. A documented undo mechanism that can't be triggered isn't one.

### 14.8.5 Page flow

Upload file → Stage A result panel (row count, median interval, excluded columns, warnings) →
mapping table (one row per surviving column: metric dropdown / "unused", unit dropdown from
`mappingOptions`) → fault metadata (`faultType` from `client/src/utils/constants.js`'s existing
`FAULT_TYPES`, plus the mandatory `rootCause`/`resolution`/`notes` the controller already
requires) → confirm → either the range-sanity confirmation step (`rangeSanityWarnings`, with an
explicit override) or the Stage C outcome (accepted window count, or rejection with the composite
score and the three underlying rates — §10.4.1's item 9 requires "why was this rejected" never
be a black box, and the response already carries the numbers).

---

## 14.9 Work items — summary by layer

**Database:** `007_model_ops.sql` (§14.5.1) + down migration.

**Python (`pdm/`):**
- New `app/features.py` (D19), `app/training.py` (D20), `app/artifacts.py` (write/verify/load/prune
  — D25, D29), `app/training_config.yaml` (D22).
- `app/model.py` — real champion lookup + lazy defensive load + `score()` + `augment()` (D26,
  D27, D28).
- `app/retrain.py` — training path, artifact write, extended result, real CLI (D21, D34).
- `app/preprocessing/pipeline.py` — call `model.augment` after `rules.evaluate` (D27).
- `app/main.py` — `POST /retrain`, `GET /retrain/:jobId`, `GET /model/status`,
  `POST /model/reload`, `POST /model/verify`; use `model.augment` in `/score` (D27, D28, D34).
- `app/schemas.py` — Tier 2 fields on `ScoreResponse`; request/response models for the new
  endpoints (D27).
- `requirements.txt` — `scikit-learn`, `numpy`, `joblib` pinned; `xgboost` only if D20's
  config-gated path is exercised in v1 (decide at implementation time; pinning an unused native
  dep just grows the image).

**Node (`server/`):** models, services, controller, routes per §14.5.2–§14.5.4; `pdmService.js`
prediction persistence (§14.6.2); `whoamiController.js` derived booleans (D38); `routes/index.js`
`PDM_ADMIN_GROUP`.

**Client:** `pages/ModelOpsPage.jsx`; `App.jsx` page id + `isAdmin`/`isReviewer` wiring;
`Sidebar.jsx` Administration group + icon; `api/client.js` new methods + the FormData fix
(§14.8.3); reuse `utils/constants.js`'s `FAULT_TYPES`.

**Docker / config:** `pdm_artifacts` volume + `/artifacts` mount; `PDM_ARTIFACT_ROOT`,
`PDM_ARTIFACT_KEEP_RUNS`, `PDM_ARTIFACT_MIN_AGE_HOURS`, `PDM_MODEL_FAMILY`, `PDM_TRAIN_SEED` on
`pdm`; `PDM_ADMIN_GROUP`, `PDM_RETRAIN_POLL_TIMEOUT` on `backend`; all of the above in
`.env.example`. **`pdm`'s `mem_limit: 512m` needs raising** (sklearn + numpy + a fitted forest on
the full corpus in memory) — measure, then set; a container OOM-killed mid-retrain is a
confusing failure. The volume must be writable by the `pdm` user created in `pdm/Dockerfile`
(`useradd ... pdm`, `USER pdm`) — Docker named volumes are root-owned on first creation, so this
needs either an entrypoint `chown` or a matching uid, and must be verified on a **fresh volume**,
not an existing one. `cap_drop: ALL` is retained; nothing here needs a capability.

---

## 14.10 Tests

### 14.10.1 Python (`pdm/tests/`)
- `test_features.py` — order derived from `pump-physics.yaml` is stable and 54-long; missing key
  raises rather than defaults; a round-trip through a persisted `feature_order` reproduces the
  same vector from a reordered dict.
- `test_training.py` — fits on a small fixture corpus; two fits with the same seed and config
  produce byte-identical artifacts (D22); `predict` returns exactly one label per row (the
  contract `evaluate_candidate` asserts at `promotion.py:101`).
- `test_artifacts.py` — write/verify round-trip; corrupted byte fails the checksum; a
  `feature_order` mismatch refuses to load; the pruner never removes a champion or an
  ever-promoted run (D29).
- `test_model_load.py` — **the load-failure matrix**, and the most important suite here: DB
  unreachable, no promoted run, null `artifactPath`, missing file, bad checksum, feature-order
  mismatch → each leaves the model unloaded with a specific logged reason, `score()` returns
  `None`, and `/health` still returns ok (D26).
- `test_retrain.py` — extended: existing fixture-`predict_fn` cases unchanged (proving D21's
  seam held); new no-`predict_fn` case trains and returns an `artifactPath`;
  `RetrainAbortedError` still raised before any artifact is written.
- `test_augment.py` — `/process-window` carries Tier 2 fields when a model is loaded and is
  byte-identical to today's response when it isn't (the regression that protects §11's
  parity work).

### 14.10.2 Node (`server/scripts/tests/`)
- `trainingRunService` — approve happy path; approve with a stale `championRunIdAtEval` → 409
  (D31); approve against a negative recommendation without notes → 400, with notes → 200;
  approve/rollback leaves exactly one `promoted = true` row; the unique index rejects a
  double-promote attempt; an audit row is written for every decision.
- `modelMonitoringService` — each of §14.6's six aggregates against seeded rows, including the
  `autoLabeled` exclusion in metric 3 (that's a correctness bug waiting to happen, not a nicety).
- Retrain job proxy — `pdm` unreachable, 409 job-already-running, and a job that disappears
  (poll timeout) each produce a clean error, no unhandled rejection. Same discipline §5.6
  established.
- `pdmService` — a verdict carrying Tier 2 fields writes a `tier2_predictions` row; a failure
  writing it does not affect the `fault_events` path or ingestion.
- **Naming trap (§14.0 item 16):** `npm test`'s `find` excludes `*pdm*` and `*faultEvent*`. New test
  files must avoid those substrings **or** the script must be fixed. Fixing it is preferable —
  but it presumably excludes them for a reason (they need a live Postgres, or the `mock.module`
  compatibility issue commit `8a63403` addressed), so **determine that reason before changing
  it** rather than re-including a suite that then fails for everyone.

### 14.10.3 Offline smoke test using the synthetic corpus
`data/pump-telemetry/` cannot train a promotable model (§13.3, and §14.1's non-scope restates
it), but it is the right input for proving the *machinery* runs at realistic scale: a dev-only
script that windows a slice of it, shapes rows like `training_corpus` rows, and runs
`run_retrain` end-to-end including the artifact write. Any number it produces is labeled
synthetic and is never inserted into `training_runs`. This is precisely the role §13.3
assigned that corpus.

### 14.10.4 Live verification (against a real stack, like §11's `verify-pdm-cutover.sh`)
1. Fresh `pdm_artifacts` volume — confirm `pdm` can write to it as the non-root `pdm` user.
2. Boot with no promoted run — `/model/status` reports `loaded: false`, `/process-window` and the
   dashboard behave exactly as today.
3. Retrain from the admin page; confirm one `training_runs` row, `PENDING_DECISION`, non-null
   `artifactPath`, and an artifact on disk with a matching checksum.
4. Approve; confirm the DB transaction, the audit row, `pdm`'s auto-reload, `/model/status`
   reporting the new run id, and Tier 2 fields appearing on subsequent `/process-window`
   responses and in `tier2_predictions`.
5. Stop `pdm` mid-retrain; confirm the backend reports a lost job, writes no `training_runs` row,
   and the orphan artifact is swept.
6. Corrupt the champion artifact and restart `pdm`; confirm it starts, logs the checksum failure,
   serves Tier 1 only, and the admin page shows the mismatch banner.
7. Retrain again, approve, then roll back to the previous run; confirm `getChampion()` returns the
   rolled-back-to run (this is what D32's `promotedAt` ordering exists for) and `pdm` loads it.
8. Hit every new route as a reviewer-but-not-admin identity → 403; as an admin-but-not-reviewer
   identity, confirm the upload panel's 403 is handled as a message, not a crash.

---

## 14.11 Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Tier 2 wired only into `/score`, so a loaded model never affects live scoring | **High** | Augment in `preprocessing/pipeline.py` via one shared `model.augment()`; regression test asserts Tier 2 fields on `/process-window` (§14.0 item 5, D27) |
| `response_model=ScoreResponse` silently strips Tier 2 fields | **High** | Fields declared on `ScoreResponse`; the same test covers it (§14.0 item 6, D27) |
| Train/serve feature-order skew produces confident nonsense with no error | **High** | Single `features.py`; order persisted in the artifact and verified at load; mismatch is a hard load failure (D19, D25) |
| A Tier 2 load/scoring failure takes down `/process-window`, and with it `processed_telemetry`, the dashboard, forecast and drift | **High** | Defensive lazy load, every failure path returns `None`; the load-failure matrix is its own test suite (D26, §14.10.1). §11.3's coupling is exactly why this is High |
| DB says champion X, `pdm` serves Y, nobody knows | **High** | `GET /model/status` compared to `getChampion()`, mismatch banner + manual reload; never inferred from a successful approval (D28) |
| A model is deployed on a gate designed to be generous at thin support, with no human judgment | **High** | Promotion requires an explicit admin action; recommendation is necessary-but-not-sufficient (D30) |
| Admin approves a comparison against a champion that has since changed | **High** | 409 on stale `championRunIdAtEval` (D31) |
| Rollback silently doesn't work because `getChampion()` orders by id | **High** | `promotedAt` ordering + partial unique index + single transaction (D32) |
| Existing artifact-less `promoted = true` rows make `getChampion()` return something unloadable | Medium | Explicit migration backfill to `REJECTED`/`promoted = false`, reasoning in the migration header (D33) |
| Admin rubber-stamps on `overallAccuracy` and misses a minority-class regression | Medium | Per-class table is the headline; `overallAccuracy` rendered small and labeled non-decisive (D40) — the human-layer analogue of §3.2's anchoring concern |
| HITL-agreement metric is read as live accuracy when its sample is biased to flagged windows | Medium | Named "agreement on reviewed windows" in the API and on screen; `autoLabeled` rows excluded (D35 metric 3) |
| Widening `pdm_corpus_readonly` to `training_runs` erodes the read-only boundary by precedent | Medium | One table, `SELECT` only, in the same conditional grant style; the write invariant is untouched and restated (D26) |
| Approving deploys an artifact that turns out to be unloadable | Medium | `POST /model/verify` dry-run load before any DB state changes (D31) |
| `pdm` OOM-killed mid-retrain under `mem_limit: 512m` | Medium | Measure and raise before shipping; job reports FAILED rather than hanging (§14.9) |
| Named volume is root-owned; non-root `pdm` user can't write artifacts | Medium | Verified on a **fresh** volume in §14.10.4 step 1 — an existing volume can mask this |
| Artifact pruner deletes the rollback target | Medium | Pruner never removes a champion or an ever-promoted run; asserted in `test_artifacts.py` (D29) |
| Retrain job lost on `pdm` restart; orphan artifact left behind | Low — accepted | Poll timeout reports "job lost"; orphan sweep in the same prune pass (D34, D29). A durable queue is explicitly out of scope, consistent with §11.5 item 2 |
| Client's hardcoded JSON content type breaks multipart upload, surfacing as a confusing Stage A parse error | Medium | FormData exemption in `request()`; covered in §14.10.4 step 8's flow (§14.8.3) |
| Client's unit list drifts from `unitConversion.js`, silently corrupting the corpus | Medium | Units served in the Stage A response, never hardcoded client-side (§14.8.3) |
| New tests silently skipped by `npm test`'s `find` exclusions | Medium | Named around the exclusions, or the script fixed *after* establishing why the exclusions exist (§14.10.2) |
| `pdm`'s new control endpoints are unauthenticated at the application layer | Low today | Network boundary only (`data` network, no published ports) — same basis `/score` already relies on. **Must be revisited if `pdm` moves to its own CT** per §1 (D28) |
| A second thing called "drift" appears with no stated relation to `GET /api/drift` | Low | Reuse `driftService` or name it `modelInputDrift` and cross-reference (D35 metric 4) |
| An admin who isn't a reviewer sees an upload panel that 403s | Low | Panels gated independently on `isReviewer` / `isAdmin` (D37, D38) |
| `tier2_predictions` grows unbounded | Low | Retention policy or a prune script in `cleanupStaleUploads.js`'s style; hypertable suitability verified first (D36) |

---

## 14.12 Definition of done

**Fitting and artifacts**
- [ ] `features.py` derives a 54-feature order from `pump-physics.yaml`; a missing/non-numeric key raises; the order used at fit time is persisted in the artifact and verified at load
- [ ] `training.py` fits a Random Forest by default, XGBoost via `PDM_MODEL_FAMILY`, hyperparameters from a versioned `training_config.yaml`, and records `modelFamily`/`trainingConfigVersion`/`seed` on the run
- [ ] Two fits over the same corpus manifest and config version produce byte-identical artifacts
- [ ] No class is dropped for thin support; `promotion.py` is unmodified; `evaluate_candidate`'s `predict_fn` contract is unchanged
- [ ] Artifacts land on the `pdm_artifacts` volume under `<trainedAt>-<corpusHash>/`, with `metadata.json` + `SHA256SUM`; `training_runs.artifactPath` holds the path **relative** to `PDM_ARTIFACT_ROOT`
- [ ] The artifact is written before the promotion decision, so a non-recommended candidate is still inspectable and still approvable
- [ ] The pruner never removes the champion or any ever-promoted run; orphaned artifacts are swept
- [ ] Python still writes no Postgres table — verified by grep, not convention: no write SQL in `pdm/`, and `pdm_corpus_readonly` holds `SELECT` and nothing else

**Load and serving**
- [ ] `pdm` resolves its champion from `training_runs` at startup and loads the artifact; every failure mode leaves it unloaded with a specific logged reason, `score()` returning `None`, and `/health` ok
- [ ] Tier 2 augmentation happens in `/process-window` (the live path) as well as `/score`, through one shared `augment()`
- [ ] `ScoreResponse` declares the Tier 2 fields; a no-model response is byte-identical to today's
- [ ] `POST /model/reload` swaps atomically; `GET /model/status` reports loaded run id, checksum and last error
- [ ] Tier 1 remains the sole flagging authority; Tier 2 only adds a label + probability (§3.5)

**Promotion**
- [ ] No code path promotes a run without an explicit admin action
- [ ] `promotionStatus`/`recommendation`/`promotedAt`/`decidedBy`/`decidedAt`/`decisionNotes` exist and are populated
- [ ] Approving against the recommendation (either direction) requires non-empty notes; matching it does not
- [ ] Stale `championRunIdAtEval` → 409; null/unverifiable artifact → rejected before any DB write
- [ ] Exactly one `promoted = true` row is possible, enforced by a partial unique index, not application logic alone
- [ ] `getChampion()` orders by `promotedAt`; rolling back to an older run makes it champion and `pdm` loads it
- [ ] Every decision writes a `model_promotion_events` row; pre-existing artifact-less rows are backfilled per D33
- [ ] Retrain runs as an HTTP job on `pdm` (202/409/poll); Node performs the `training_runs` INSERT via a shared `trainingRunService`; `recordTrainingRun.js` still works standalone

**Admin page and auth**
- [ ] `PDM_ADMIN_GROUP` exists, defaults to `pdm-admins`, is distinct from `PDM_REVIEWER_GROUP`, and no code implements a group hierarchy
- [ ] Every new route is `requireTrustedProxy` + `requireGroup(PDM_ADMIN_GROUP)`; a reviewer-only identity gets 403 on all of them
- [ ] `/api/whoami` returns `isAdmin`/`isReviewer` derived server-side; the client never contains a group name; the client gate is documented as cosmetic
- [ ] `ModelOpsPage` renders all six panels, with real empty states for "no model deployed" and "evaluation gate not met"
- [ ] The comparison view leads with per-class metrics, shows excluded classes with their reasons, treats the forgotten-class case prominently, and labels `overallAccuracy` as non-decisive
- [ ] Run history shows recommendation vs. decision vs. actor, and offers rollback on previously-approved runs

**Monitoring**
- [ ] `tier2_predictions` is written on every window a loaded model scores, without ever affecting ingestion
- [ ] `GET /api/pdm/model/monitoring` returns all six metrics; every one is computed in Node
- [ ] Metric 3 excludes `autoLabeled` rows and is labeled "agreement on reviewed windows", never accuracy
- [ ] Metric 4 either reuses `driftService` or is named distinctly with the relationship stated
- [ ] The loaded-vs-champion mismatch is visible on the page, not only in logs

**Upload**
- [ ] Upload + mapping work end-to-end from the admin page against the **existing** §10.4.1 endpoints — no second upload/mapping backend
- [ ] Unit options come from the server's `unitConversion.js` via the Stage A response
- [ ] `request()` handles `FormData` without forcing a JSON content type
- [ ] Upload/confirm stay reviewer-gated; list and retract are admin-gated; retract invokes the existing `retractUpload()`
- [ ] A Stage C rejection shows the composite score and the three underlying rates

**Verification**
- [ ] Python unit suites pass, including the full load-failure matrix
- [ ] Node suites pass and are actually included in `npm test`
- [ ] §14.10.4's eight live-stack steps pass against a real Postgres + `pdm` + `backend` stack on a **fresh** artifact volume
- [ ] `pdm`'s memory limit measured and set; a retrain does not OOM

---

## 14.13 Open questions carried forward

1. **Label semantics — still open, deliberately.** This plan trains the same-time *diagnosis*
   label. §13.4 step 3 / §13.5 item 4's lead-time-shifted *onset* label — arguably the label
   a genuine PdM system needs — requires a per-row severity/onset signal `training_corpus` does
   not carry. Needs its own plan: new columns, a re-materialization pass, and an ML review of
   what "N minutes before onset" means for buffers whose boundaries are 1 hour either side of a
   human-declared fault window.
2. **Retrain cadence.** Admin-triggered only. Whether a schedule is warranted depends on how fast
   the corpus actually grows, which nobody knows yet. Revisit once metric 1 (staleness) has real
   history.
3. **`MISALIGNMENT` vs `BEARING` separability** — a known, accepted limitation of six scalar
   metrics (§12.1, restated in §13.3). Expect it in the per-class comparison; do not treat a
   persistent confusion between those two as a promotion blocker without richer instrumentation.
   Worth a note on the comparison panel so an admin isn't surprised by it every retrain.
4. **XGBoost in v1 or not.** D20 keeps the config seam; whether to pin the dependency before
   anything uses it is an implementation-time call, and the reasoning (image size vs. an unused
   native dep) should be recorded wherever it lands.
5. **Whether `tier2_predictions` should be a hypertable.** Depends on facts about
   `001`/`002`'s hypertable conventions that must be checked against the live schema, not
   assumed (D36).
6. **`pdm`'s application-layer auth**, if and when it moves to its own CT per §1. Today the
   `data`-network boundary is the whole story and that is stated, not assumed.
7. **Evaluation-gate reachability.** `MIN_ONSET_EPISODES = 100` fault-labeled buffers is a long
   way off from real HITL throughput, so §14.7.3's panel 2 will show "gate not met" for a long time
   and nothing in this plan produces a model until it's met. Whether that threshold is right for
   a first deployment (as opposed to a mature one) is an ML question §10.5 settled at 100 by
   porting the existing constant; it is worth re-asking with real numbers in hand, but not
   worth changing pre-emptively here.


---

## 14.14 ecc:mle-reviewer pass on §14 — findings and decisions D43–D50

**Verdict: BLOCK on first pass**, one finding above threshold (D43); everything else is a
refinement, not a blocker — matching this document's own §10.5 precedent (that pass also
returned BLOCK on its first sketch, over what became D8). Reviewed against §14.0–§14.13 as
written above; §1–§13 read for background only, not re-reviewed.

### D43 — BLOCK: the train/serve contract catches structural skew, not semantic skew

§14.2.1 (D19) persists `feature_order` in the artifact and hard-fails a load if it disagrees
with the current `FEATURE_ORDER` — this correctly catches a *shape* mismatch (wrong count, wrong
position, an added/removed metric). It does **not** catch a *semantics* mismatch: a feature whose
name and position stay identical while its underlying computation changes (e.g. `rawStdDev`'s
window, units, or clipping behavior shifts in a future `pump-physics.yaml` or feature-code
revision). §10.5's D2 built exactly this detector for the corpus side
(`training_corpus.featureCodeVersion` per row), and §14.3.2 already carries the artifact-side
half (`featureCodeVersions` in `metadata.json`) — but nothing in the load path (D26/D28) or the
serving path (D27) actually compares that stored value against the running feature code's
current version. Given §14.2.1 itself calls this "the single highest-risk piece of train/serve
skew in this whole plan," leaving the semantic half of that risk unchecked is a real gap, not an
optional refinement.

**Fix:** at model load, compare the running feature-code version (whatever §11 already stamps as
`processed_telemetry.preprocessingVersion`) against the artifact's recorded `featureCodeVersions`.
A live version not present in (or newer than) what the artifact trained on surfaces as a warning
on the admin page — extend D28's loaded-vs-champion mismatch banner (§14.3.5, §14.7.3) to also
carry a feature-code-version mismatch state, alongside the existing artifact-checksum mismatch
it already displays.

### D44 — training on classes down to n=2 under `class_weight='balanced'` (refinement, not blocking)

D23's reasoning (parity with §10.5 D6 — don't discard human-confirmed ground truth) is sound for
whether to *include* rare rows in the corpus, but doesn't address a second question: a class with
2 training examples under `class_weight='balanced'` gets a per-sample weight inversely
proportional to its frequency, large enough to warp splits elsewhere in the tree, not just "learn
that class poorly." §14.2.5 addresses this only at the *decision* layer
(`min_support_per_class` excludes it from the gate), never at the *fitting* layer. Sub-BLOCK
because the human-approval gate (D30) and the per-class comparison table (D40) are very likely to
surface the symptom directly (a well-supported class's recall regressing) rather than letting it
deploy silently.

**Optional fix:** cap `class_weight` per class (e.g. `min(computed_balanced_weight, cap)`), or at
minimum state explicitly in §14.2.2 that `class_weight='balanced'` at thin support is a known,
accepted risk mitigated only by the human-gate comparison table, not by the fitting code itself.

### D45 — no hyperparameter search is justified; OOB scoring is a free partial mitigation not currently used

§14.1's "no hyperparameter search" reasoning (no third split exists; searching against the
promotion split would overfit the gate) is correct. But `RandomForestClassifier(oob_score=True)`
gives a free generalization estimate from the exact bootstrap-out-of-bag rows already implicit in
`train_rows`, at no extra split cost. Not a substitute for search and doesn't change any
promotion decision, but it's cheap and currently unused.

**Optional fix:** set `oob_score=True` on the RandomForest path (note XGBoost has no direct
equivalent), record `oobAccuracy`/`oobScorePerClass` in `metadata.json` where practical, surface
it on the comparison panel (§14.7.4) as informational-only — same "informational, not
gate-decisive" treatment §14.7.4 already gives `overallAccuracy` (D40), so it doesn't reintroduce
an anchoring risk.

### D46 — the comparison table gives the human less information than `promotion.py` already computes internally

§14.7.4 (D40)'s human-gated promotion design holds up well overall: leading with per-class
metrics, demoting `overallAccuracy`, showing excluded classes with reasons, and surfacing corpus
provenance are all substantive mitigations, not cosmetic reordering — provenance in particular is
exactly the kind of judgment a human can make that the automated gate structurally cannot.
But `promotion.py`'s support-scaled tolerance (§10.5 D8: "~0.22 at n=5, ~0.02 at n=500") already
computes, internally, how much noise a given support level implies — and the comparison table
surfaces only a raw `Support (cand/champ)` number, forcing the admin to mentally reconstruct
"n=5 means ±22 points of noise" with no aid. The plan is asking a human to do a job the automated
gate's own arithmetic already does better.

**Fix:** surface D8's already-computed tolerance value per class/support level directly in the
comparison table (e.g. "recall 80% ± 22pp at n=5") rather than a bare support count. A UI change
over an already-computed value, not a new statistical component.

### D47 — monitoring metric 3 (HITL agreement) has a second, unaddressed bias source

§14.6.1 metric 3 already flags and excludes `autoLabeled=true` rows (self-comparison bias) and is
correctly labeled "agreement on reviewed windows," never accuracy. The second bias is structural
and unaddressed: ground truth only ever exists for Tier-1-*flagged* windows, so this metric can
only ever measure agreement on the subset of windows Tier 1's rules already suspected. Tier 2's
behavior on windows Tier 1 never flags — plausibly the majority, and exactly the population where
a Tier 2 model would add the most value or do the most damage — is invisible to every one of the
six metrics; metric 2 (label distribution) has no ground truth to compare against, and metric 3
has ground truth only on the flagged subset. Not fixable by adjusting metric 3's SQL — it's a
structural blind spot, not a computation bug.

**Fix:** add an explicit caveat string to the monitoring panel (§14.7.3 panel 5) stating that
Tier 2's behavior on windows Tier 1 never flags is not measured by any current metric, and that
metric 3 measures agreement only on the intersection of "flagged by Tier 1" and "later confirmed
by a human" — a subset of a subset. No new machinery, just an honest label, matching the
discipline metric 3's first caveat already applies.

### D48 — monitoring metric 4 (drift) is marginal-only; the consequence for a tree ensemble should be stated explicitly

The `|Δmean|/σ_train` per-metric reduction (six numbers instead of a 54-feature KS/PSI battery)
is a reasonable human-facing tradeoff, correctly justified as "an admin has to be able to act on
it." But a Random Forest / XGBoost splits on joint structure implicitly — drift in the
*correlation* between two metrics (e.g. vibration and temperature moving together in a new way,
each individually still within its historical marginal mean/stddev) is invisible to six
independent per-metric statistics but can still shift which leaf a row lands in and therefore the
predicted label. Not a reason to build a heavier detector now; the tradeoff still holds. But the
plan should say so explicitly, so a future "metric 4 looked fine but the model degraded" incident
isn't mistaken for the monitoring system being broken rather than doing exactly what it was
scoped to do.

**Fix:** one sentence in §14.6.1 metric 4 (and its risk-register row) stating the marginal-only
scope explicitly, parallel to how metric 3's bias is already stated.

### D49 — no prediction-confidence / calibration monitoring metric exists among the six

`tier2_predictions` (D36) already stores `probability` per prediction — the raw material for this
already exists — but none of the six metrics uses it. A shift in the distribution of `probability`
over time (the model becoming systematically more or less confident, or confidence collapsing
toward the decision boundary for a specific label) is one of the cheapest and most actionable
degradation signals available for a deployed classifier, cheaper than metric 4's drift
computation, sitting unused in a column the plan is already writing. Not a BLOCK — nothing about
deploying without it is unsafe, since Tier 1 remains authoritative and D30 keeps promotion
human-gated — but it's the most concrete gap in "six metrics" claiming to be "continuous
monitoring."

**Fix:** add a seventh metric (or fold into metric 2) — daily mean/percentile of
`tier2_predictions.probability`, optionally split by predicted label, computed the same way as
the other five (pure SQL over `tier2_predictions`, no model access needed) — consistent with
D35's "none of them requiring the model" design constraint.

### D50 — determinism (D22) is well-handled; version-pin discipline should be stated explicitly

§14.2.4's determinism design is more careful than most: `n_jobs: 1` removes thread-scheduling
float-summation nondeterminism (the dominant hidden nondeterminism source for parallelized
RF/XGBoost fits), and the byte-identical-artifact test (§14.10.1) is the right verification. One
gap: §14.9 says scikit-learn/numpy/joblib are "pinned" but doesn't state whether that means an
exact pin (`==`) versus a compatible-release pin (`~=`) — scikit-learn has changed RF
tie-breaking/default-criteria behavior across minor versions historically, and D22's
byte-identical-artifact claim is load-bearing for "did the corpus change or did the config
change" reproducibility.

**Fix:** state explicitly in §14.2.4 or §14.9 that scikit-learn/numpy/xgboost are exact-pinned
(`==`), not range-pinned, and that a version bump is itself a `trainingConfigVersion`-triggering
event (already implied by `sklearnVersion` being recorded in `metadata.json` per D25 — just make
the pin discipline explicit next to the determinism claim).

### What passed review without a finding

- **D30's human-gated promotion design** (§14.4.1, §14.7.4/D40): substantively addresses the
  asymmetry between an automated gate and a human reviewer (per-class headline, demoted
  `overallAccuracy`, excluded-class transparency, corpus provenance) rather than just relocating
  the same statistical fragility. Not reopened, aside from D46's information-surfacing gap above.
- **D21's reuse of `evaluation/episodes.py`/`promotion.py` under a real, non-fixture classifier**:
  `evaluate_candidate`'s `predict(rows) -> list[str]` contract is explicitly verified against the
  actual `promotion.py` signature before being relied on, and D19's fail-hard-on-bad-feature
  design (raise, don't silently zero) matters specifically because a real classifier — unlike the
  fixture `predict_fn`s that were the only prior caller — actually consumes the feature vector.
  No gap found here beyond D43 above.

### Net effect on §14

D43 should be treated the same way §10.5 treated D8 — a required fix before implementation, not
an optional refinement. D44–D50 are recorded as refinements; none blocks implementation on their
own, but D46/D47/D49 in particular are cheap (UI/label/one-more-SQL-metric changes over data the
plan already computes or persists) and worth folding in during implementation rather than
deferring, since they close gaps identified against this plan's own stated goals rather than
introducing new scope.

---

## 15. Real training data arrives: bootstrap from a CSV, Tier 2 gets its own review queue

**Status:** planning only — nothing here has been executed yet.

**Trigger:** the project owner supplied a real labeled dataset (`train.csv`, 15,627 rows: six
raw metric readings — `Engine_rpm`→`rpm`, `suctionPressure`, `dischargePressure`, `flowRate`,
`motorTemp`, `vibration` — plus a binary `Engine_Condition` label, no timestamp, no
fault-type breakdown, no episode/buffer structure). This section is the single record of what
changes because of that; it supersedes/refines the relevant pieces of §10–§14 below and
should be read as the current state, not those sections' original text.

### 15.1 D51 — Tier 2 bootstraps from `train.csv`, outside `training_corpus`

`train.csv`'s shape doesn't fit `training_corpus` (no timestamp, no window structure, six raw
values instead of the 54-feature `precapFeaturesByMetric`/`metricStats` snapshot) — forcing it
through that pipeline would mean fabricating 48 features that were never collected. Instead:

- New `pdm/app/features.py`: a fixed, hand-written `FEATURE_ORDER = ["rpm",
  "suctionPressure", "dischargePressure", "flowRate", "motorTemp", "vibration"]`, matching
  `train.csv`'s columns 1:1. `to_vector()` raises on a missing/non-numeric field — same
  "no silent zero-fill" principle §14.2.1 (D19) already established.
- New `pdm/app/training.py::fit_model(train_csv_path, *, config) -> FittedModel` — loads the
  CSV directly, does a **stratified** train/test split (not walk-forward; there's no time
  axis here to leak across), fits `RandomForestClassifier` (default) / XGBoost
  (config-gated, per §14.2.2/D20's family choice, unchanged), and writes `model.joblib` +
  `metadata.json` to the same artifact store §14.3 already specced (`pdm_artifacts` volume,
  `training_runs.artifactPath`) — this is just the *first* artifact that ever lands there,
  not a different storage mechanism.
- `pdm/app/model.py` stops being a permanent stub: loads the artifact once at startup (mirrors
  `thresholds.yaml`'s load-once pattern) and `score(record)` returns
  `{"tier2FaultStatus": 0 | 1, "tier2Confidence": float}` — **an integer 0/1, not a boolean**,
  deliberately matching `train.csv`'s own `Engine_Condition` encoding end to end, so there's
  no boolean↔0/1 translation anywhere between training, serving, and persistence (§15.3).
  `None` if the artifact failed to load — Tier 1 unaffected, same fallback posture as always.
- `ScoreResponse` (`schemas.py`) gains these two fields as optional — the same fix §14.0
  item 6 already flagged as mandatory (FastAPI's `response_model` silently drops undeclared
  keys), just against this smaller field set rather than the full 54-feature one.
- `preprocessing/pipeline.py`'s `/process-window` path must actually call `model.score()` —
  §14.0 item 5's finding (the live path stopped calling `/score` and never invokes
  `model.score()` at all) still applies verbatim and must be fixed regardless of training
  source.

### 15.2 D52 — all retraining after the bootstrap is admin-CSV-upload-driven; §10/§14's machinery is confirmed in scope, not deleted

An earlier pass through this decision considered deleting `training_corpus`, its
materialization, `promotion.py`'s champion/challenger gate, the artifact store, and §14's
admin page entirely, on the assumption that future retraining would just be "swap in a new
flat CSV, refit, redeploy" with no comparison step. That assumption doesn't hold: the actual
requirement is a champion/challenger workflow driven from the dashboard — an admin uploads a
CSV, it's mapped/preprocessed/validated, a candidate is fit, and it's compared against the
currently-deployed model before a human promotes it. That's exactly what §10.4 (Stage A/B/C
upload), §10.5 (`training_corpus`, evaluation gate, promotion), and §14 (fitting, artifact
store, admin approve/reject/rollback page) already provide. **None of it is removed.**

- Retraining flow, confirmed: admin uploads a CSV from the dashboard → Stage A (structural
  validation) → Stage B (column mapping, unit/range checks) → Stage C (physics-aware quality
  gate, reusing `/process-window`) → materializes into `training_corpus` → `retrain.py` fits a
  candidate → `promotion.py` compares it against the champion → human approves/rejects/rolls
  back from §14.7's admin page.
- **Open item to resolve at implementation time:** `corpusMaterializationService.js`
  materializes `training_corpus` rows from `fault_events`, but `externalUploadService.js`
  already has its own materialization step for admin-uploaded CSVs (§10.4 D10). Confirm
  whether `corpusMaterializationService.js` is still exercised by anything under this design,
  or whether it's now dead code duplicating what the upload service already does.
- **Split strategy for admin-uploaded training rows:** they do carry a real timestamp
  (Stage A/B requires one), so §10.5's walk-forward/episode split *could* still apply — but a
  plain stratified split may be simpler and sufficient at this project's scale. Decide at
  implementation time; `check_evaluation_gate`'s minimum-row-count purpose is kept either way.
- §1's "dedicated `pdm-python` CT" language is stale — actual topology is **one Proxmox CT
  running the whole application, with one Docker container per component** (server, client,
  pdm, node-red, db, etc.), not a CT per service. `pdm` stays its own container/service;
  nothing about how it's built or reached over HTTP changes.

### 15.3 D53 — Tier 2's verdict is persisted, not just returned over HTTP; §14.6.2's `tier2_predictions` is the every-window log, `fault_events` is not

**Correction to this section's original text:** it said `tier2FaultStatus`/`tier2Confidence`
get written to `fault_events` "on every scored window." That's wrong, and §14.6.2/D36 already
explains why: Tier 2 scores every closed window, but `fault_events` only ever has rows for
flagged windows and periodic negative samples (§3.3.1) — even after §15.4/D54 lets Tier 2 open
its own rows, most quiet windows (Tier 1 silent, Tier 2 predicting 0) still have no
`fault_events` row to attach anything to. Hanging a per-window Tier 2 log off `fault_events`
would silently drop most of it, exactly the failure mode D36 was written to avoid.

**Corrected design — two separate, non-contradicting things:**

- **Every-window log:** `tier2_predictions` (§14.6.2, unchanged) is where Tier 2's output for
  every closed window actually lives — `predictedLabel`, `probability`, keyed by
  `processedTelemetryId`. This is what monitoring (§14.6.1) reads from.
- **On a `fault_events` row specifically** (one exists — Tier 1 flagged it, Tier 2 flagged it
  per §15.4, or it's a negative sample): `tier2FaultStatus INTEGER` (0/1, nullable) and
  `tier2Confidence REAL` are still added as columns, populated from the same verdict at the
  moment that row is written/extended — this is the value a HITL reviewer sees next to a
  specific event, not a substitute for the complete log. No interaction with
  `fault_events.status`'s `PENDING_REVIEW`/`CONFIRMED`/`REJECTED`/`N/A` lifecycle (§3.3), which
  stays HITL-owned and untouched by this.

### 15.4 D54 — Tier 2 gets its own Predicted Faults review queue

**Why:** Tier 1 only fires once a hard threshold is actually crossed — it's reactive. Tier 2
is the genuinely predictive layer: it can flag a suspicious multivariate pattern before any
single metric breaches Tier 1's fixed limits. Under §3.5's original design, Tier 2's output
was only ever columns bolted onto whatever row Tier 1 happened to create — a window Tier 2
flags on its own, with Tier 1 silent, never reached a human at all. §3.5's "Tier 2 augments,
never replaces, the rule verdict" stays true for the *scoring response*, but it no longer
means "Tier 2 has no review path of its own."

- `fault_events` gains `predictionSource TEXT NOT NULL DEFAULT 'TIER1_RULE'` —
  `TIER1_RULE` | `TIER2_MODEL` | `BOTH`. A Tier-2-only flag opens its own row
  (`predictionSource = 'TIER2_MODEL'`), through the same coalescing logic (§3.3.2) so a
  sustained Tier 2 flag doesn't spam duplicates either. A window where both flag opens/extends
  one row with `predictionSource = 'BOTH'`. `tier2FaultStatus`/`tier2Confidence` (§15.3) stay
  as columns on the row regardless — useful context, just no longer the only visibility Tier 2
  gets.
- **Dashboard: a "Predicted Faults" tab** — lists `PENDING_REVIEW` rows where
  `predictionSource` includes `TIER2_MODEL`, showing the actual metric readings behind the
  flag (e.g. `motorTemp = 180`), not a black-box score — a person can eyeball the numbers and
  judge for themselves. A read surface over the existing HITL endpoints (§3.6), not a new
  backend concept.
- **Review labels the fault properly, not just confirm/reject:** the reviewer picks the actual
  `faultType`, writes `rootCause`, writes `resolution` — all already existing `fault_events`
  columns, no schema change needed there. On save, `status` moves `PENDING_REVIEW` →
  `CONFIRMED`, and the UI groups `CONFIRMED` rows under an **"Escalated"** view — what actually
  notifies maintenance to act. No new `status` value; "Escalated" is a dashboard-level grouping
  of `CONFIRMED` rows, not a new backend state.
- **This is the path toward multi-class Tier 2, not just binary.** Every escalated row is a
  real labeled example with an actual fault-type label, not just 0/1 — exactly what
  `training_corpus` materialization accumulates, and exactly the per-class support
  `promotion.py`'s `min_support_per_class` gate (§10.5) was built to require before trusting a
  class. **Explicitly conditional, not a deadline:** the binary bootstrap model (§15.1) stays
  the deployed baseline until there's enough labeled diversity *per fault type* to train a
  trustworthy multi-class classifier. `OTHER` remains the catch-all for anything that doesn't
  cleanly fit an existing type (§10.5 D1), unchanged.

### 15.5 D55 — resolved: a label-taxonomy mismatch bypasses the per-class gate and is reported as such, not as a regression

**Chosen: detect the mismatch explicitly in `decide_promotion()` and give it its own reason
string — a light version of both options previously listed, not a new `promotionStatus` state
or admin-facing UI concept.** Reasoning:

- D30 already made promotion **always** require an explicit human action, regardless of what
  `recommendation` says — "no run is ever promoted without an explicit human action" applies
  identically whether the gate passed, failed, or (this case) didn't apply. So bypassing the
  per-class floor on a taxonomy change doesn't weaken the actual safeguard; the human still
  clicks approve or reject either way, on either kind of decision. Building a whole separate
  `promotionStatus` value for this (the previously-listed second option) would add a new
  lifecycle state, new UI branching, and new tests for a case that changes *why* a human is
  deciding, not *whether* one is.
- Silently reusing the existing "no champion yet" path was rejected as the resolution, though:
  it would print "no champion yet — first candidate promotes unconditionally" next to a
  comparison table that has an actual champion sitting right there, which is actively
  misleading to the admin looking at the page — they'd reasonably wonder why the system thinks
  there's no champion. The fix needs its own honest reason string, not a borrowed one.
- Partial-overlap reconciliation (comparing on a shared "no fault" label while treating the
  rest as incomparable) was considered and rejected as unnecessary complexity: this transition
  happens once, deliberately, under direct human supervision — building careful partial-set
  logic for a rare, supervised event isn't worth the extra code path and its own tests. **Any**
  label-set difference between champion and candidate — not just full disjointness — triggers
  the same bypass.

**Mechanics — this is the one place §14.4.1's "`promotion.py` is not modified" claim doesn't
hold; `decide_promotion()` gains one new branch, nothing else in the module changes:**

```python
def decide_promotion(candidate, champion, *, min_support_per_class=..., margin_factor=...):
    if champion is None:
        return PromotionDecision(promote=True, reason="no champion yet — ...", per_class_comparison={})

    champion_labels = set(champion.per_class) - EXCLUDED_FROM_GATE
    candidate_labels = set(candidate.per_class) - EXCLUDED_FROM_GATE
    if champion_labels != candidate_labels:
        return PromotionDecision(
            promote=True,
            reason=(
                "candidate's label taxonomy differs from the champion's "
                f"(champion: {sorted(champion_labels)}, candidate: {sorted(candidate_labels)}) — "
                "per-class gate not applicable; treat as a new baseline under human review"
            ),
            per_class_comparison={},  # side-by-side per-class metrics for BOTH still shown
        )                             # on the admin page from EvalMetrics directly, not this dict

    # existing per-class comparison loop, unchanged, for the same-taxonomy case
    ...
```

- `recommendation` comes back `True` here, same as "no champion" — but the **reason string is
  distinct**, so the admin page can render it as its own visible state ("taxonomy changed —
  gate bypassed, review manually") rather than looking identical to a genuine first promotion.
  This is a display-layer distinction (§14.7.4's comparison panel reads `reason`), not a new
  backend enum.
- `per_class_comparison` is empty for this case — there is no meaningful pairwise comparison to
  show — but §14.7.4's panel still has `EvalMetrics.per_class` for *both* candidate and
  champion independently (already computed by `evaluate_candidate()`, already passed to
  `decide_promotion()`), so the admin page shows each model's own per-class numbers
  side-by-side without pretending they're comparable pairs. No new data is needed to render
  this; it's a rendering choice on data already available.
- **Bootstrap labeling, settled as part of this resolution:** `train.csv`'s binary label is
  emitted as `"NORMAL"` / `"FAULT"` (not bare `"0"`/`"1"`) from `training.py`'s `FittedModel`,
  so a reader of `training_runs` history can tell at a glance what a given run's labels meant
  without cross-referencing which model generation produced it. This does **not** attempt
  partial-overlap comparison against the multi-class taxonomy's `NORMAL`/`OTHER`-style labels
  even if the strings happen to coincide later — per the rejected-partial-overlap reasoning
  above, any set difference still triggers the bypass branch, deliberately, even a
  single-label one.
- This resolution only ever fires for a genuine taxonomy change. The ordinary binary
  bootstrap→binary-retrain path (§15.2/D52, admin CSV uploads that stay binary) never hits this
  branch — `champion_labels == candidate_labels` for every same-taxonomy comparison, and
  §14.4's existing per-class floor applies exactly as originally designed.

### 15.6 Definition of done

**Bootstrap:**
- [ ] `pdm/app/model.py` loads a real artifact fit from `train.csv` and returns a non-None verdict
- [ ] `pdm/app/features.py`'s 6-field `FEATURE_ORDER` matches `train.csv` columns exactly, mapped to this codebase's existing metric names
- [ ] `/process-window` actually calls `model.score()` (§14.0 item 5's gap, fixed)
- [ ] `ScoreResponse` schema extended with `tier2FaultStatus` (int 0/1) and `tier2Confidence`, verified they survive `response_model` filtering
- [ ] `tier2_predictions` (§14.6.2) is the every-window Tier 2 log; `fault_events.tier2FaultStatus`/`tier2Confidence` columns added via migration and populated only on rows that already exist (§15.3's correction — not "every scored window")

**Retraining (§10.5/§14's existing work items apply; not repeated here):**
- [ ] Admin CSV upload (§10.4/§14.8) → `training_corpus` materialization → `retrain.py` → `promotion.py` champion/challenger comparison → admin approve/reject/rollback (§14.4/§14.7) all function end-to-end
- [ ] `corpusMaterializationService.js`'s role confirmed against `externalUploadService.js`'s own materialization step — dead code removed if redundant, kept if not
- [ ] Split strategy for admin-uploaded training data decided (walk-forward vs. row-count floor)

**Predicted Faults review queue:**
- [ ] `fault_events.predictionSource` column added (`TIER1_RULE`/`TIER2_MODEL`/`BOTH`), populated correctly for Tier-2-only, Tier-1-only, and both-flag windows
- [ ] A Tier-2-only flag opens its own coalescing-aware `fault_events` row, independent of Tier 1
- [ ] Dashboard "Predicted Faults" tab lists Tier-2-sourced `PENDING_REVIEW` rows with the raw metric readings shown
- [ ] Reviewer can set `faultType`/`rootCause`/`resolution` and the row surfaces under an "Escalated" view once `CONFIRMED`
- [ ] Escalated, labeled rows flow into `training_corpus` materialization same as any other confirmed event

**Unaffected:**
- [ ] Tier 1 verdict, `fault_events.status` HITL lifecycle, and the HITL review endpoints are unchanged
- [ ] §1's CT topology note corrected to "one CT, one Docker container per component"

**Not required for §15 itself, but needed before the eventual binary→multi-class transition (§15.5/D55):**
- [ ] `decide_promotion()`'s taxonomy-mismatch branch implemented (compares `champion_labels`/`candidate_labels` sets, bypasses the per-class floor with its own reason string, per §15.5)
- [ ] Admin comparison page renders the taxonomy-mismatch reason as its own visible state, and shows each model's independent per-class metrics side-by-side when `per_class_comparison` is empty for this reason
- [ ] `training.py`'s bootstrap fit emits `"NORMAL"`/`"FAULT"` labels, not bare `"0"`/`"1"`
