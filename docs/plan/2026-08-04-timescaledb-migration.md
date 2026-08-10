# SQLite → TimescaleDB Migration — Implementation Plan

Repo-side work for moving the database off the backend CT's local disk
(`better-sqlite3`, `server/data.db`) onto PostgreSQL 16 + TimescaleDB, and replacing the
imperative `ALTER TABLE` list in `server/database/db.js` with a real, file-based migration
history.

**Status:** planning only — nothing here has been executed yet.

---

## 0. Preconditions (already done outside this repo)

This plan assumes the database server is already running and reachable. Do not attempt to
provision it — infrastructure setup is handled separately.

- PostgreSQL 16 + TimescaleDB running on a dedicated Proxmox CT (`pdm-db`, `10.10.10.15`).
- Database `pump_telemetry` exists, owned by role `pdm_app`, with the `timescaledb`
  extension enabled.
- Connections from the backend CT (`10.10.10.12`) are permitted.
- The connection string is available as `DATABASE_URL` and works:
  ```
  postgres://pdm_app:PASSWORD@10.10.10.15:5432/pump_telemetry
  ```

**Verify this before starting.** If `psql "$DATABASE_URL" -c "SELECT 1;"` fails, stop —
that is an infrastructure problem, not something to work around in application code.

**Shared instance with Authentik:** this same Postgres/TimescaleDB instance also hosts
Authentik's `authentik_db` (its own database + role, `authentik_svc`), provisioned per
`docs/plan/2026-08-09-authentik-split-ct.md` — that plan supersedes, for this split-CT
topology, the container-based assumption in the earlier
`docs/superpowers/specs/2026-08-06-authentik-integration-design.md`. See that plan's §5.1
for the init script and manual live-volume provisioning procedure.

---

## 1. Scope

### In scope
- A 1:1 port of the two existing tables — `raw_telemetry` and `processed_telemetry` — to
  Postgres, converted to Timescale hypertables.
- `node-pg-migrate` as the migration mechanism, replacing `schema.sql` and the hand-written
  `ALTER TABLE` checks in `db.js`.
- Rewriting the Node data-access layer (`db.js`, the three models, and every caller) from
  synchronous `better-sqlite3` to asynchronous `pg`.
- Docker / compose / env changes for the backend.

### Explicitly NOT in scope
Predictive maintenance is a **later phase** and must not appear in this work:

- No `fault_events` / `pdm_scores` / HITL tables.
- No `pdmService.js`, no `/score` HTTP boundary, no Python service, no `pdm/` directory.
- No data migration from the old `data.db` — that is a separate, manual step.
- No compression or retention policies — a tuning decision for later, once real data volume
  is known.

### Why
The trigger is architectural, not load-driven: a `.db` file on the backend CT's disk does
not fit the CT-per-concern layout the rest of the system uses, and migrating while the
dataset is small and there is no production traffic is the cheapest this will ever be.

---

## 2. Target repo layout

```
server/
├── database/
│   ├── db.js                  # rewritten: pg.Pool, no schema/DDL logic at all
│   ├── migrations/            # NEW — node-pg-migrate
│   │   └── 001_init.sql       # raw_telemetry + processed_telemetry, translated 1:1
│   └── schema.sql             # DELETED (its content becomes 001_init.sql)
├── models/                    # same three files, queries rewritten async + $1 params
├── services/                  # same logic, now awaiting model calls
├── preprocessing/             # pipeline.js becomes async (see §4 — the main risk)
├── controllers/               # await the now-async services
└── scripts/                   # qualityReport / backfill / evaluate also use db directly
```

Data flow is unchanged end to end: Node-RED → `POST /api/data` → preprocessing pipeline →
60s window closes → aggregated row written. The only difference is that the write lands on
a Postgres server across the network instead of a local file.

---

## 3. Decisions already made

| Decision | Choice | Rationale |
|---|---|---|
| DB engine | PostgreSQL 16 + TimescaleDB | Timescale is a Postgres extension, so going straight to it avoids a second migration later |
| Migration tool | `node-pg-migrate` | Plain SQL files, no ORM, fits the codebase's "SQL lives in one place" style |
| Column naming | Keep camelCase, double-quoted | Avoids touching every property name in models/services/controllers/client |
| Driver | `pg` (node-postgres) | Standard, pure JS — also removes the native-build toolchain from the Dockerfile |
| Initial migration content | Only the two existing tables | A pure, verifiable port; nothing new to second-guess if something looks wrong afterwards |

---

## 4. Work items

Grouped into commits that can each be reviewed on their own.

### 4.1 Dependencies and configuration

- Add `pg` and `node-pg-migrate` to `server/package.json`; remove `better-sqlite3`.
- Add scripts:
  ```json
  "migrate": "node-pg-migrate -m database/migrations",
  "migrate:up": "node-pg-migrate up -m database/migrations",
  "migrate:down": "node-pg-migrate down -m database/migrations"
  ```
- Update `server/.env.example` and the root `.env.example`: add `DATABASE_URL`, delete
  `DB_PATH`.
- The real `.env` is gitignored and holds the password. **Never** hardcode the connection
  string in compose files, migrations, or source.

### 4.2 `001_init.sql` — the 1:1 schema port

Translate `server/database/schema.sql` exactly. Two tables only. Type mapping:

| SQLite | Postgres | Affects |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL` | see the hypertable PK constraint below |
| `REAL` | `DOUBLE PRECISION` | all metric and stat columns |
| `TEXT` (ISO-8601 timestamp) | `TIMESTAMPTZ` | `timestamp`, `windowStart`, `windowEnd`, `preprocessingTimestamp` |
| `INTEGER` used as boolean | `BOOLEAN` | `physicsValid`, `abnormalOperation`, `isImputed` |
| `TEXT` holding JSON | `JSONB` | `physicsViolations`, `unfilledMetrics`, `outliersByMetric`, `violationsByMetric`, `precapFeaturesByMetric`, `historicalFeaturesByMetric` |
| `TEXT` (plain) | `TEXT` | `status`, `faultType`, `provenance`, `dominantStatus`, `dominantFaultType`, `qualityLabel`, `preprocessingVersion` |

Preserve every column, every `NOT NULL`, and every `DEFAULT` from the current schema —
including the **nullable metric columns** on `raw_telemetry`. An `IMPUTED` row may
legitimately leave a metric null when its gap exceeds that metric's interpolation ceiling
(see `preprocessing/missing.js`); the SQLite table-rebuild block at the bottom of `db.js`
exists precisely to repair databases that got this wrong, so do not reintroduce the bug.

Keep the comments. The existing `schema.sql` documents *why* columns exist, and that
context is worth more than the file it currently lives in.

**Hypertable primary-key constraint:** Timescale requires that any `PRIMARY KEY` or
`UNIQUE` index include the partitioning column. `id BIGSERIAL PRIMARY KEY` alone will make
`create_hypertable` fail. Use a composite key:

```sql
CREATE TABLE raw_telemetry (
  id          BIGSERIAL,
  ...
  "timestamp" TIMESTAMPTZ NOT NULL,
  ...
  PRIMARY KEY (id, "timestamp")
);
SELECT create_hypertable('raw_telemetry', 'timestamp');
CREATE INDEX ON raw_telemetry ("timestamp" DESC);
```

Same shape for `processed_telemetry`, partitioned on its `timestamp` (= windowEnd) column,
keeping the existing `(windowStart, windowEnd)` index. Default chunk interval (7 days) is
fine.

Delete `server/database/schema.sql` once its content lives in the migration.

### 4.3 `db.js` rewrite

Replace the entire file. The new version should be *small*: create and export a `pg.Pool`
built from `DATABASE_URL`, and keep `isDatabaseHealthy()` (now async) for `/api/health`.

Everything else currently in `db.js` — reading `schema.sql`, the ~15 `ALTER TABLE ADD COLUMN`
checks, the `PRAGMA table_info` inspections, the `raw_telemetry` table-rebuild block — is
**deleted, not ported**. That entire mechanism is what `node-pg-migrate` replaces.
Migrations must never run implicitly at app boot; they are an explicit `npm run migrate:up`
step.

Rewrite the header comment. The current one explains why synchronous `better-sqlite3` was
chosen, which becomes actively misleading once it is a pool.

Add sane pool settings (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`) and a pool
`error` handler — a network DB drops connections in ways a local file never could.

### 4.4 Models

`sensorModel.js`, `processedModel.js`, and `forecastModel.js` currently build module-level
prepared statements at import time (`const insertStmt = db.prepare(...)`). That pattern does
not carry over — `pg` parameterizes per query. Convert each statement into an `async`
function calling `pool.query(text, values)`.

Mechanical changes:
- `@namedParam` and `?` → `$1, $2, …` positional parameters.
- `.get()` → `(await pool.query(...)).rows[0] ?? null`
- `.all()` → `(await pool.query(...)).rows`
- `.run()` → `await pool.query(...)`; where `lastInsertRowid` was used, add `RETURNING id`.
- **Quote every camelCase identifier.** Unquoted `flowRate` folds to `flowrate` in Postgres
  and silently returns `undefined` on every row.

Three behavioural differences that cause subtle, non-crashing bugs if missed:

1. **`TIMESTAMPTZ` returns a JS `Date`, not a string.** The codebase assumes ISO strings
   throughout (`Date.parse(sample.timestamp)` in `pipeline.js`, string comparisons in
   `buffer.js`, ISO strings in every API response the client consumes). Normalise at the
   model boundary — `.toISOString()` in the row-mapping functions — or register a `pg` type
   parser for OID 1184. Pick one and apply it consistently; never leave some paths
   returning `Date` and others strings.
2. **`JSONB` returns already-parsed objects.** `processedService.rowToProcessed()` currently
   does `row.outliersByMetric ? JSON.parse(row.outliersByMetric) : null`, which will throw
   on an object. Remove those `JSON.parse` calls, and correspondingly stop
   `JSON.stringify`-ing on the way in — `pg` serialises objects to `jsonb` directly.
3. **`BOOLEAN` returns `true`/`false`, not `1`/`0`.** Any check comparing against `1`, or
   writing `1`/`0`, needs updating.

### 4.5 The sync → async ripple — highest-risk item

`better-sqlite3` is synchronous and the preprocessing pipeline was built on that
assumption. Making the DB async changes control flow well beyond the data layer:

- `sensorService.saveReading()` and `processedService.saveAndTrigger()` become async.
- `preprocessing/pipeline.js` — `ingestSample()`, `processClosedWindow()`, `processSample()`,
  and `runBackgroundSweep()` all become async, because they call the above.
- `controllers/dataController.js` and `processedController.js` must `await` them.
- The `onNewProcessedRecord()` hooks in `forecastService` / `driftService` / `trendService`,
  and their `start*Loop()` timers, need auditing for the same reason.
- `server.js`'s `setInterval(runBackgroundSweep, …)` now fires an async function — unhandled
  rejections must be caught explicitly and overlapping executions prevented.
- `scripts/qualityReport.js`, `scripts/backfillHistoricalFeatures.js`, and
  `scripts/evaluateFaultPrediction.js` import `db` directly and need the same treatment.

**The real hazard is concurrency, not syntax.** `processSample()` currently relies on
synchronous execution for correctness: it reads `getLastSample()`, computes gap fills
against it, then commits — and nothing can interleave, because JavaScript is single-threaded
and every DB call returns immediately. Once `await` appears inside that sequence, two
overlapping `POST /api/data` requests can interleave and corrupt the window buffer's state,
producing duplicated fill rows, wrong window boundaries, or a `getLastSample()` that is
stale by the time it is used.

**Mitigation: serialise the ingestion path.** Add a promise-chain mutex so `processSample()`
calls execute strictly one at a time, and make `runBackgroundSweep()` take the same lock so
a sweep can never run concurrently with an ingest. This preserves the ordering guarantee the
pipeline was designed around.

This needs a regression test: fire N concurrent `POST /api/data` requests with sequential
timestamps and assert the resulting `raw_telemetry` rows and window boundaries match the
sequential case exactly.

Do not skip this. It is the one part of the migration that can produce silently wrong data
rather than an obvious error.

**Note for future multi-pump support (not this phase):** the schema currently has no
`pumpId`/`pumpName` concept — `raw_telemetry` and `processed_telemetry` assume a single
stream. When multi-pump support is eventually added, that requires its own schema migration
*and* a change to this mutex: swap the single global lock for one lock per `pumpId`, keyed
by pump, so different pumps' ingestion can proceed in parallel and only same-pump readings
are serialised against each other. Do the mutex keying change in the same piece of work as
the multi-pump schema migration, not now — a single global lock is correct and sufficient
for the current single-pump setup.

### 4.6 Docker

- `server/Dockerfile`: drop `apk add --no-cache python3 make g++`. Those exist solely to
  compile `better-sqlite3`'s native addon; `pg` is pure JS. Smaller image, faster builds.
- `docker-compose.backend.yml` and `docker-compose.yml`: remove `DB_PATH` and the
  `server_data` volume; add `DATABASE_URL` sourced from `.env`.
- Confirm the backend container can reach the DB from *inside* Docker, not just from the
  CT's shell.

---

## 5. Verification

Run in order; each step gates the next.

1. `npm run migrate:up` succeeds against the real database, then in `psql`:
   ```sql
   \dt
   SELECT hypertable_name FROM timescaledb_information.hypertables;
   ```
   Both tables must appear, and both must be hypertables.
2. `node --test server/scripts/tests/` — these are pure preprocessing tests
   (`aggregation.dominantFaultType`) with no DB dependency, so they must pass unchanged. If
   they break, something from the async conversion leaked into preprocessing logic that
   should have stayed synchronous.
3. The new concurrency regression test from §4.5 passes.
4. Start the backend, point the Node-RED simulator at it, and let it run until **at least
   three windows have closed**. Verify:
   - `raw_telemetry` fills at ~1 Hz,
   - `processed_telemetry` gains one row per minute,
   - the dashboard renders live / history / stats / forecast / drift / trend without errors.
5. `GET /api/health` reports the database as healthy.

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Concurrent ingest corrupting window-buffer state once the pipeline is async | **High — silent data corruption** | Mutex on `processSample`/`runBackgroundSweep` (§4.5) + regression test |
| Unquoted camelCase identifiers folding to lowercase | High — silent `undefined` on every row | Quote all identifiers; caught by the live-traffic check (§5.4) |
| `TIMESTAMPTZ` returning `Date` where ISO strings are assumed | High | Normalise at the model boundary (§4.4.1) |
| `JSON.parse` on already-parsed JSONB | Medium — throws, so at least it is loud | Remove parse/stringify pairs (§4.4.2) |
| `create_hypertable` rejecting a non-composite PK | Low — fails immediately at migration time | Composite `(id, "timestamp")` PK (§4.2) |
| Backend now has a network dependency it did not have before | Medium | Pool error handling and connection timeouts (§4.3) |
| Password committed to the repo | High | `DATABASE_URL` lives in `.env` only (§4.1) |

---

## 7. What this unblocks (context only — not this phase)

Once the DB is a real server rather than a file, the constraint that would keep a future
Python PdM service from accessing the database directly disappears, and fault-buffer /
HITL-labelling tables can be added as their own numbered migration. **None of that is part
of this work** — it is noted only so the choices above (composite keys, JSONB over TEXT,
hypertables, a migrations directory that accepts new numbered files) are understood as
deliberate rather than incidental.

---

## 8. Definition of done

- [ ] `001_init.sql` applies cleanly; both tables exist as hypertables
- [ ] `schema.sql` deleted; no DDL or `ALTER TABLE` logic remains in `db.js`
- [ ] `better-sqlite3` removed from `package.json`; native build deps removed from the Dockerfile
- [ ] All models, services, controllers, and scripts converted to async `pg`
- [ ] Ingestion path serialised, with a passing concurrency regression test
- [ ] Existing preprocessing tests still pass
- [ ] Backend serves live simulator traffic; ≥3 windows close correctly; dashboard renders
- [ ] `GET /api/health` reports healthy
