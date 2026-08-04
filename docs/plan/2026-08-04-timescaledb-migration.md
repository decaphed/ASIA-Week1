# SQLite → TimescaleDB Migration Plan

Moves the database off the backend CT's local disk (`better-sqlite3`, `server/data.db`)
onto a dedicated Proxmox CT running PostgreSQL 16 + TimescaleDB, and replaces the
imperative `ALTER TABLE` migration list in `server/database/db.js` with a real,
file-based migration history.

**Status:** planning only — nothing in this document has been executed yet.

---

## 0. Scope

### In scope
- New Proxmox CT (`pdm-db`) running PostgreSQL 16 + TimescaleDB.
- A 1:1 port of the two existing tables — `raw_telemetry` and `processed_telemetry` — to
  Postgres, converted to Timescale hypertables.
- `node-pg-migrate` as the migration mechanism, replacing `schema.sql` + the hand-written
  `ALTER TABLE` checks in `db.js`.
- Rewriting the Node data-access layer (`db.js`, the three models, and every caller) from
  synchronous `better-sqlite3` to asynchronous `pg`.
- Docker/compose/env changes for the backend.

### Explicitly NOT in scope
Predictive maintenance is a **later phase** and must not appear in this work:

- No `fault_events` / `pdm_scores` / HITL tables.
- No `pdmService.js`, no `/score` HTTP boundary, no Python service, no `pdm/` directory.
- No new CT for the PdM/ML service.

The only concession to that future phase is *naming and placement* — the DB CT is called
`pdm-db` because PdM will eventually be its main consumer, and the migrations directory is
structured so PdM tables can be added later as their own numbered migration. Nothing else
about PdM belongs in this change.

### Why now
The trigger is architectural, not load-driven: a `.db` file living on the backend CT's disk
does not fit the CT-per-concern layout the rest of the system already uses, and migrating
while the dataset is small and there is no production traffic is the cheapest this will
ever be. Postgres and self-hosted TimescaleDB are both free, so cost is not a factor.

---

## 1. Target state

### Proxmox CT layout

```
Proxmox host
├── CT: frontend            (unchanged)
├── CT: node-red            (unchanged — POSTs samples to backend)
├── CT: backend (10.10.10.12)  — Express in Docker; no DB file, connects over the network
└── CT: pdm-db  (NEW)          — PostgreSQL 16 + TimescaleDB, owns `pump_telemetry`
```

Data flow is unchanged end to end. Node-RED → `POST /api/data` → preprocessing pipeline →
60s window closes → aggregated row written. The only difference is that the write lands on
a Postgres server across the network instead of a local file.

### Repo layout

```
server/
├── database/
│   ├── db.js                  # rewritten: pg.Pool, no schema/DDL logic at all
│   ├── migrations/            # NEW — node-pg-migrate
│   │   └── 001_init.sql       # raw_telemetry + processed_telemetry, translated 1:1
│   └── schema.sql             # DELETED (its content becomes 001_init.sql)
├── models/                    # same three files, queries rewritten async + $1 params
├── services/                  # same logic, now awaiting model calls
├── preprocessing/             # pipeline.js becomes async (see §6 — the main risk)
├── controllers/               # await the now-async services
└── scripts/                   # qualityReport / backfill / evaluate also use db directly
```

---

## 2. Decisions already made

| Decision | Choice | Rationale |
|---|---|---|
| DB engine | PostgreSQL 16 + TimescaleDB | Timescale is a Postgres extension, so going straight to it avoids a second migration later. Vanilla Postgres semantics from day one. |
| CT template | **Ubuntu 22.04 standard** | Matches the existing three CTs. |
| Postgres source | PGDG apt repo | Ubuntu 22.04 ships PG14; PG16 needs PGDG. |
| Migration tool | `node-pg-migrate` | Plain SQL files, no ORM, fits the codebase's "SQL lives in one place" style. |
| Column naming | Keep camelCase, double-quoted | Avoids touching every property name in models/services/controllers/client. |
| Driver | `pg` (node-postgres) | Standard, pure JS — also removes the native-build toolchain from the Dockerfile. |
| Initial migration content | Only the two existing tables | A pure, verifiable port. Nothing new to second-guess if something looks wrong afterwards. |

---

## 3. Sequencing overview

Infrastructure first, because the code work needs a live database to be written and tested
against — writing it blind and debugging connectivity afterwards is the expensive order.

| Phase | Who / where | Gate before moving on |
|---|---|---|
| A. Create CT | You, Proxmox host shell | CT boots, has a static IP, is reachable |
| B. Install + configure Postgres/Timescale | You, inside `pdm-db` CT | `SELECT 1;` succeeds **from the backend CT** |
| C. Migration + code rewrite | Claude Code, in the repo | Migration applies; app runs; tests pass against Postgres |
| D. Data decision + cutover | You | Backend serves live traffic from `pdm-db` |

**Do not start Phase C until Phase B's remote `SELECT 1;` works.**

---

## PHASE A — Create the CT

**Where: SSH into the Proxmox host (not any CT).**

### A1. Confirm the Ubuntu 22.04 template is available

```bash
pveam update
pveam available | grep ubuntu-22.04
# Download only if it is not already in `pveam list local`:
pveam download local ubuntu-22.04-standard_22.04-1_amd64.tar.zst
```

### A2. Pick a free CT ID and a static IP

```bash
pct list          # find an unused ID (this plan assumes 104)
```

Choose an IP on the same subnet as the backend CT (`10.10.10.12`, per
`docker-compose.frontend.yml`'s `extra_hosts`). This plan assumes **`10.10.10.13`**.
Fix the IP statically — `pg_hba.conf` and the backend's `DATABASE_URL` both hardcode
addresses, and a DHCP change would silently break both.

### A3. Create and start

```bash
pct create 104 local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst \
  --hostname pdm-db \
  --cores 2 \
  --memory 2048 \
  --swap 512 \
  --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=10.10.10.13/24,gw=10.10.10.1 \
  --unprivileged 1 \
  --onboot 1 \
  --features nesting=1

pct start 104
```

**Resource rationale** — 2 cores / 2 GB / 20 GB. At 1 Hz, `raw_telemetry` is a few hundred
bytes per row, so 20 GB covers well over a year before Timescale compression is even
considered. All three are trivially raisable later (`pct set 104 --memory 4096`,
`pct resize 104 rootfs +10G`) — start small rather than over-provisioning on a guess.

Confirm `--onboot 1` and `--features nesting=1` match the conventions of the existing three
CTs; adjust if they differ.

### A4. Verify

```bash
pct status 104                       # should be: running
ping -c2 10.10.10.13                 # from the Proxmox host
```

---

## PHASE B — Install and configure Postgres + TimescaleDB

**Where: inside the new CT — `pct enter 104` from the Proxmox host.**

### B1. Base packages

```bash
apt update && apt upgrade -y
apt install -y gnupg curl ca-certificates lsb-release
```

### B2. Add the PGDG repo (for PostgreSQL 16)

Ubuntu 22.04's own repos only carry PostgreSQL 14, so PGDG is required before Timescale's
package can resolve its `postgresql-16` dependency.

```bash
install -d /usr/share/postgresql-common/pgdg
curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
```

### B3. Add the TimescaleDB repo

```bash
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ jammy main" \
  > /etc/apt/sources.list.d/timescaledb.list
curl -Lsf https://packagecloud.io/timescale/timescaledb/gpgkey \
  | gpg --dearmor > /etc/apt/trusted.gpg.d/timescaledb.gpg
```

### B4. Install

```bash
apt update
apt install -y timescaledb-2-postgresql-16 postgresql-client-16
```

### B5. Tune and enable the extension preload

```bash
timescaledb-tune --quiet --yes    # sizes shared_buffers/work_mem etc. to the CT's 2 GB
systemctl restart postgresql
systemctl enable postgresql
```

### B6. Create the role, database, and extension

```bash
su - postgres -c psql <<'SQL'
CREATE USER pdm_app WITH PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE pump_telemetry OWNER pdm_app;
\c pump_telemetry
CREATE EXTENSION IF NOT EXISTS timescaledb;
GRANT ALL ON SCHEMA public TO pdm_app;
SQL
```

Generate the password with `openssl rand -base64 24` and store it somewhere durable —
it goes into the backend's `.env` in Phase D and is not recoverable from Postgres.

`pdm_app` owns the database, so `node-pg-migrate` can create tables as that user without
needing superuser. Do not run the application as `postgres`.

### B7. Allow connections from the backend CT only

Edit `/etc/postgresql/16/main/postgresql.conf`:

```
listen_addresses = '*'
```

Edit `/etc/postgresql/16/main/pg_hba.conf` — add this line, scoped to the backend CT's
address specifically, **not** `0.0.0.0/0`:

```
host    pump_telemetry    pdm_app    10.10.10.12/32    scram-sha-256
```

The backend's Express app runs in Docker inside the backend CT, and container egress is
NAT'd to the CT's own address, so `10.10.10.12/32` covers it. If the backend CT is ever
given a second interface or the Docker network is changed to macvlan, this line needs
revisiting.

```bash
systemctl restart postgresql
```

### B8. GATE — verify from the backend CT

**Where: SSH into the backend CT (10.10.10.12), not the DB CT.**

```bash
apt install -y postgresql-client-16     # if psql isn't present
psql -h 10.10.10.13 -U pdm_app -d pump_telemetry -c "SELECT 1;"
psql -h 10.10.10.13 -U pdm_app -d pump_telemetry -c "SELECT extversion FROM pg_extension WHERE extname='timescaledb';"
```

Both must succeed. **This is the gate for Phase C** — if this fails, it is a networking,
`pg_hba`, or `listen_addresses` problem, and no amount of application code will work
around it.

---

## PHASE C — Migration + code rewrite (Claude Code)

Everything below is repo work, done on a branch, with `DATABASE_URL` pointed at the CT
from Phases A–B. Grouped into commits that can each be reviewed on their own.

### C1. Dependencies

- Add `pg` and `node-pg-migrate` to `server/package.json`; remove `better-sqlite3`.
- Add scripts:
  ```json
  "migrate": "node-pg-migrate -m database/migrations",
  "migrate:up": "node-pg-migrate up -m database/migrations",
  "migrate:down": "node-pg-migrate down -m database/migrations"
  ```
- Update `server/.env.example` and root `.env.example`:
  ```
  DATABASE_URL=postgres://pdm_app:PASSWORD@10.10.10.13:5432/pump_telemetry
  ```
  and delete `DB_PATH`.

### C2. `001_init.sql` — the 1:1 schema port

Translate `server/database/schema.sql` exactly. Two tables only. Type mapping:

| SQLite | Postgres | Notes |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL` | **See the hypertable PK constraint below** |
| `REAL` | `DOUBLE PRECISION` | |
| `TEXT` (ISO-8601 timestamp) | `TIMESTAMPTZ` | affects `timestamp`, `windowStart`, `windowEnd`, `preprocessingTimestamp` |
| `INTEGER` used as boolean | `BOOLEAN` | `physicsValid`, `abnormalOperation`, `isImputed` |
| `TEXT` holding JSON | `JSONB` | `physicsViolations`, `unfilledMetrics`, `outliersByMetric`, `violationsByMetric`, `precapFeaturesByMetric`, `historicalFeaturesByMetric` |
| `TEXT` (plain) | `TEXT` | `status`, `faultType`, `provenance`, `dominantStatus`, `dominantFaultType`, `qualityLabel`, `preprocessingVersion` |

Preserve every column, every `NOT NULL`, and every `DEFAULT` from the current schema —
including the nullable metric columns on `raw_telemetry` (an `IMPUTED` row may legitimately
leave a metric null when its gap exceeds that metric's interpolation ceiling; the SQLite
table-rebuild block at the bottom of `db.js` exists precisely to fix databases that got
this wrong, so do not reintroduce the bug).

Keep the comments. The existing `schema.sql` documents *why* columns exist and that context
is worth more than the file it currently lives in.

**Hypertable primary-key constraint (important):** Timescale requires that any
`PRIMARY KEY` or `UNIQUE` index include the partitioning column. `id BIGSERIAL PRIMARY KEY`
alone will make `create_hypertable` fail. Use a composite key:

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
keeping the existing `(windowStart, windowEnd)` index.

Default chunk interval (7 days) is fine; do not add compression or retention policies in
this migration — those are a tuning decision for later, once real data volume is known.

Delete `server/database/schema.sql` once its content lives in the migration.

### C3. `db.js` rewrite

Replace the entire file. The new version should be *small*: create and export a `pg.Pool`
from `DATABASE_URL`, and keep `isDatabaseHealthy()` (now async) for `/api/health`.

Everything else currently in `db.js` — reading `schema.sql`, the ~15 `ALTER TABLE ADD COLUMN`
checks, the `PRAGMA table_info` inspections, the `raw_telemetry` table-rebuild block — is
**deleted**, not ported. That entire mechanism is what `node-pg-migrate` replaces. Migrations
must never run implicitly at app boot; they are an explicit `npm run migrate:up` step.

Rewrite the header comment accordingly — the current one explains why synchronous
`better-sqlite3` was chosen, which will be actively misleading once it is a pool.

Add sane pool settings (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`) and an
error handler on the pool, since a network DB can drop connections in ways a local file
never could.

### C4. Models

`sensorModel.js`, `processedModel.js`, `forecastModel.js` currently build module-level
prepared statements at import time (`const insertStmt = db.prepare(...)`). That pattern
does not carry over — `pg` parameterizes per query. Convert each statement into an
`async` function that calls `pool.query(text, values)`.

Mechanical changes:
- `@namedParam` and `?` → `$1, $2, …` positional parameters.
- `.get()` → `(await pool.query(...)).rows[0] ?? null`
- `.all()` → `(await pool.query(...)).rows`
- `.run()` → `await pool.query(...)`; where `lastInsertRowid` was used, add
  `RETURNING id` (or `RETURNING *`) instead.
- **Quote every camelCase identifier.** Unquoted `flowRate` folds to `flowrate` in
  Postgres and will silently return `undefined` on every row.

Three behavioural differences that will cause subtle, non-crashing bugs if missed:

1. **`TIMESTAMPTZ` comes back as a JS `Date`, not a string.** The entire codebase assumes
   ISO strings (`Date.parse(sample.timestamp)` in `pipeline.js`, string comparisons in
   `buffer.js`, ISO strings in every API response the client consumes). Normalise at the
   model boundary — convert to `.toISOString()` in the row-mapping functions — or register
   a `pg` type parser for OID 1184. Pick one and apply it consistently; do not leave some
   paths returning `Date` and others strings.
2. **`JSONB` comes back already parsed.** `processedService.rowToProcessed()` currently does
   `row.outliersByMetric ? JSON.parse(row.outliersByMetric) : null` — that will now throw
   on an object. Remove the `JSON.parse` calls; correspondingly, stop `JSON.stringify`-ing
   on the way in (`pg` serialises objects to `jsonb` directly).
3. **`BOOLEAN` comes back as `true`/`false`, not `1`/`0`.** Any truthiness check that
   compared against `1`, or wrote `1`/`0`, needs updating.

### C5. The sync → async ripple (the highest-risk part of this change)

`better-sqlite3` is synchronous, and the preprocessing pipeline was built on that
assumption. Making the DB async changes control flow well beyond the data layer:

- `sensorService.saveReading()` and `processedService.saveAndTrigger()` become async.
- `preprocessing/pipeline.js` — `ingestSample()`, `processClosedWindow()`, `processSample()`,
  and `runBackgroundSweep()` all become async, because they call the above.
- `controllers/dataController.js` and `processedController.js` must `await` them.
- `forecastService` / `driftService` / `trendService` `onNewProcessedRecord()` hooks, and
  their `start*Loop()` timers, need auditing for the same reason.
- `server.js`'s `setInterval(runBackgroundSweep, …)` now fires an async function —
  unhandled rejections must be caught explicitly, and overlapping executions prevented.
- `scripts/qualityReport.js`, `scripts/backfillHistoricalFeatures.js`, and
  `scripts/evaluateFaultPrediction.js` import `db` directly and need the same treatment.

**The real hazard is concurrency, not syntax.** `processSample()` currently relies on
synchronous execution for correctness: it reads `getLastSample()`, computes gap fills
against it, then commits — and nothing can interleave between those steps because
JavaScript is single-threaded and every DB call returns immediately. Once `await` appears
inside that sequence, two overlapping `POST /api/data` requests can interleave and corrupt
the window buffer's state — producing duplicated fill rows, wrong window boundaries, or a
`getLastSample()` that is stale by the time it is used.

Mitigation: **serialise the ingestion path.** Add a promise-chain mutex so
`processSample()` calls execute strictly one at a time, and make `runBackgroundSweep()`
take the same lock so a sweep can never run concurrently with an ingest. This preserves
the ordering guarantee the pipeline was designed around. It also needs a regression test:
fire N concurrent `POST /api/data` requests with sequential timestamps and assert the
resulting `raw_telemetry` rows and window boundaries match the sequential case exactly.

Do not skip this. It is the one part of the migration that can produce silently wrong data
rather than an obvious error.

### C6. Docker / compose

- `server/Dockerfile`: drop `apk add python3 make g++` — those exist solely to compile
  `better-sqlite3`'s native addon, and `pg` is pure JS. The image gets smaller and builds faster.
- `docker-compose.backend.yml` and `docker-compose.yml`: remove `DB_PATH` and the
  `server_data` volume; add `DATABASE_URL` (from `.env`, never hardcoded — it contains
  the password).
- Confirm the backend container can reach `10.10.10.13:5432` from inside Docker, not just
  from the CT's own shell.

### C7. Tests and verification

- `npm run migrate:up` against the real CT — then confirm in `psql`:
  ```sql
  \dt
  SELECT hypertable_name FROM timescaledb_information.hypertables;
  ```
  Both tables must appear as hypertables.
- Run the existing tests: `node --test server/scripts/tests/`. These are pure preprocessing
  tests (`aggregation.dominantFaultType`) with no DB dependency, so they should pass
  unchanged — if they break, something in the async conversion leaked into preprocessing
  logic that should have stayed synchronous.
- Add the concurrency regression test from C5.
- Start the backend and drive real traffic: point the Node-RED simulator at it, let it run
  long enough for **at least three windows to close**, then verify `raw_telemetry` is
  filling at ~1 Hz, `processed_telemetry` gains one row per minute, and the dashboard
  renders live/history/stats/forecast/drift/trend without errors.
- `GET /api/health` should report the database as healthy.

---

## PHASE D — Data decision and cutover

**Where: you, on the backend CT and your workstation.**

### D1. Decide whether existing data is worth keeping

Answer this before cutting over:

- **Discard and start fresh (recommended if the existing rows are simulator output).**
  Simpler, zero conversion risk, and the Node-RED simulator regenerates data immediately.
- **Migrate the existing rows** if any of it represents real captured pump behaviour or
  fault episodes you would not be able to reproduce.

### D2. If migrating: export and import

```bash
sqlite3 -header -csv server/data.db "SELECT * FROM raw_telemetry;"       > raw_telemetry.csv
sqlite3 -header -csv server/data.db "SELECT * FROM processed_telemetry;" > processed_telemetry.csv

psql -h 10.10.10.13 -U pdm_app -d pump_telemetry \
  -c "\copy raw_telemetry FROM 'raw_telemetry.csv' CSV HEADER"
psql -h 10.10.10.13 -U pdm_app -d pump_telemetry \
  -c "\copy processed_telemetry FROM 'processed_telemetry.csv' CSV HEADER"
```

Three things to check afterwards, each of which fails quietly:

1. **Reset the id sequences.** Rows were inserted with explicit ids, so `BIGSERIAL` still
   thinks it is at 1 and the next app insert will collide:
   ```sql
   SELECT setval(pg_get_serial_sequence('raw_telemetry','id'),        (SELECT MAX(id) FROM raw_telemetry));
   SELECT setval(pg_get_serial_sequence('processed_telemetry','id'),  (SELECT MAX(id) FROM processed_telemetry));
   ```
2. **Row counts match** the SQLite source, per table.
3. **Spot-check a JSONB column and a boolean column** on a few rows — empty CSV fields
   become `NULL`, and SQLite's `0`/`1` booleans parse as Postgres `false`/`true`, but
   confirm rather than assume.

### D3. Cut over

1. Stop the backend container on the backend CT.
2. Set `DATABASE_URL` in the backend's `.env`.
3. If migrating data, do a final export/import now (D2) to capture rows written since the
   first pass.
4. Rebuild and start the backend container.
5. Watch logs for connection errors; confirm `GET /api/health`.
6. Let the simulator run and confirm new rows land in Postgres.

### D4. Keep the old database briefly

Rename rather than delete `server/data.db` (plus its `-wal`/`-shm` files) and keep it for
a week or so. It is the only rollback path — if something is wrong, reverting means putting
the `better-sqlite3` branch back and pointing at that file. Delete it once the new setup
has run cleanly for a few days.

---

## 4. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Concurrent ingest corrupting window-buffer state once the pipeline is async | **High — silent data corruption** | Serialise `processSample`/`runBackgroundSweep` behind a mutex (C5); add a concurrency regression test |
| Unquoted camelCase identifiers folding to lowercase | High — silent `undefined` on every row | Quote all identifiers; catch via the live-traffic check in C7 |
| `TIMESTAMPTZ` returning `Date` where ISO strings are assumed | High | Normalise at the model boundary (C4.1) |
| `JSON.parse` on already-parsed JSONB | Medium — throws, so at least it is loud | Remove parse/stringify pairs (C4.2) |
| `create_hypertable` rejecting a non-composite PK | Low — fails immediately at migration time | Composite `(id, "timestamp")` PK (C2) |
| Backend now has a network dependency that did not exist before | Medium | Pool error handling + connection retry; static IPs on both CTs |
| Postgres password committed to the repo | High | `DATABASE_URL` lives in `.env` only — already gitignored — never in compose files |

---

## 5. What this unblocks (context only — not this phase)

Once the DB is a real server rather than a file, the constraint that kept a future Python
PdM service from touching the database directly disappears, and the fault-buffer /
HITL-labelling tables can be added as their own migration. **None of that is part of this
work** — it is noted only so the choices above (composite keys, JSONB over TEXT, hypertables,
a migrations directory that accepts new numbered files) are understood as deliberate rather
than incidental.

---

## 6. Definition of done

- [ ] `pdm-db` CT running, static IP, Postgres + TimescaleDB enabled, starts on boot
- [ ] Remote `SELECT 1;` succeeds from the backend CT, and only from there
- [ ] `001_init.sql` applies cleanly; both tables exist as hypertables
- [ ] `schema.sql` deleted; no DDL or `ALTER TABLE` logic remains in `db.js`
- [ ] `better-sqlite3` removed from `package.json`; native build deps removed from the Dockerfile
- [ ] All models/services/controllers/scripts converted to async `pg`
- [ ] Ingestion path serialised, with a passing concurrency regression test
- [ ] Existing preprocessing tests still pass
- [ ] Backend serves live simulator traffic; ≥3 windows close correctly; dashboard renders
- [ ] `GET /api/health` reports healthy
- [ ] Old `data.db` retained (renamed) as the rollback path
