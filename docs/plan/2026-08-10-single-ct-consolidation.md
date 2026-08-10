# Single-CT Consolidation — Implementation Plan

Collapses the 5-CT split deployment (frontend, backend, pdm, pdm-db, auth) into one
Proxmox CT running a single Docker daemon and one `docker-compose.yml`, driven by
weak host hardware where 5 CTs' worth of duplicated OS userland + Docker daemon
overhead is the actual bottleneck, not the application services themselves.

**Status:** planning only — nothing here has been executed yet.

Supersedes `docs/plan/2026-08-09-authentik-split-ct.md` for topology purposes — that
plan's Authentik/Traefik reasoning (why one hostname for UI+API, why Redis is
required, router priorities, `trustForwardHeader: false`, the blueprint's
`authentik_host` vs `authentik_host_browser` split, the `:?` required-var-guard
pattern, the plain-HTTP-no-TLS decision) is topology-independent and carries forward
unchanged. Only the networking/addressing layer changes. That plan gets a
superseded banner (§5.5), not deletion — same treatment
`docs/superpowers/specs/2026-08-06-authentik-integration-design.md` already got.

---

## 0. Preconditions

- New Proxmox CT provisioned, Docker Engine + Compose v2 installed (see the Docker
  install steps already given in conversation — apt-based, `nesting=1,keyctl=1` set
  on the Proxmox host side before first boot).
- This repo checked out on it.
- **No data migration required** — all existing telemetry in the 5 old CTs is
  explicitly disposable (user-confirmed). This is a fresh start, not a cutover with
  state to preserve.
- **The 5 old CTs have already been destroyed** (done before this plan reached
  implementation — laptop couldn't run all 5 concurrently). This changes §7 and §9
  below from their original form: there is now **no fallback topology** to revert
  to if the new CT doesn't work. §7's staged verification order matters more, not
  less, as a result — each stage must actually pass before moving to the next,
  since there's nothing to fall back to if a later stage reveals an earlier one
  was wrong. §9's rollback story is now "fix forward or re-provision from
  scratch," not "switch back."

---

## 1. Scope

### In scope
- One `docker-compose.yml` at the repo root, extending the existing pre-split base
  file (`server`/`client`/`pdm` services, currently missing Postgres and auth) with
  `postgres`, `traefik`, `authentik-redis`, `authentik-server`, `authentik-worker`.
- Renaming the `server` compose service to `backend` (directory stays `server/` —
  see §3) so it matches what `client/nginx.conf` already expects with zero changes
  to that file.
- Collapsing every LAN IP / `extra_hosts` entry from the split-CT files into plain
  Docker Compose service-name networking.
- Reducing published ports to exactly two: `80` (Traefik, the only browser-facing
  port) and `3000` (backend, for Node-RED's direct unauthenticated POST).
- One merged `.env.example` for the whole stack, replacing the three current
  split ones (root `.env.example`, `server/.env.example`, `.env.auth.example`).
- Firewall runbook for one CT instead of a 4-CT matrix.
- Retiring `docker-compose.backend.yml`, `.frontend.yml`, `.pdm.yml`, `.db.yml`,
  `.auth.yml` (deleted — an operational compose file left lying around inviting
  someone to `docker compose -f docker-compose.backend.yml up` against the new
  topology is worse than not having it, unlike a documentation file).

### Explicitly NOT in scope
- Any application code changes (`server/`, `client/`, `pdm/` internals untouched).
- TLS/mkcert — stays dropped, per the prior plan's already-final decision. Do not
  reopen it here.
- Data migration from any old CT — data is disposable (§0).
- Decommissioning the old CTs — that's the last step, gated on verification (§7),
  not part of this repo-side work itself.
- Per-user authorization / role mapping in Authentik — unchanged scope cut from
  the prior plan.

### Why
Stated directly by the user: the 5-CT split's per-CT overhead (OS userland +
Docker daemon × 5) is a real cost on weak hardware, for a service topology that
doesn't need cross-host isolation badly enough to justify it at this scale.

---

## 2. Architecture

```
Browser
  │  http://dashboard.home / http://auth.home  →  <new CT's single IP>
  ▼
┌─ app CT — one Docker daemon, one docker-compose.yml ──────────────────────┐
│                                                                            │
│  traefik :80  (published — the only browser-facing port)                 │
│    router outpost   pri 30  Host(dashboard.home)                         │
│                              && PathPrefix(/outpost.goauthentik.io/)     │
│                              → authentik-server:9000   [NO middleware]   │
│    router authentik pri 20  Host(auth.home) → authentik-server:9000      │
│                              [NO middleware]                             │
│    router dashboard pri 1   Host(dashboard.home) → forwardauth mw        │
│                              → client:80                                 │
│                                                                            │
│  client (nginx)   — NOT published. /  → static build                    │
│                                    /api/ → http://backend:3000/api/      │
│                                    (nginx.conf unchanged — already says  │
│                                    "backend", now a real Docker DNS name)│
│                                                                            │
│  backend (express) :3000  (published — Node-RED POSTs here directly,     │
│                            unauthenticated, unchanged in substance)      │
│                            → postgres:5432 (pump_telemetry)              │
│                            → pdm:8000                                    │
│                                                                            │
│  pdm (fastapi)    — NOT published, internal only                        │
│                                                                            │
│  postgres          — NOT published, internal only; fresh volume, two DBs:│
│                       pump_telemetry/pdm_app, authentik_db/authentik_svc │
│                       (db/init/*.sh auto-run on first boot — see §5)    │
│                                                                            │
│  authentik-server/worker → authentik-redis (internal)                    │
│                          → postgres:5432 (authentik_db)                  │
└────────────────────────────────────────────────────────────────────────────┘

Node-RED (wherever it runs) ──POST /api/data──► app CT :3000, unauthenticated,
                                                  never touches Traefik (unchanged)
```

### The `server` → `backend` service-name decision
Confirmed by reading `client/nginx.conf`: it already does
`proxy_pass http://backend:3000/api/`, with a comment explicitly calling `backend`
"the real network hostname" and pointing at `docker-compose.backend.yml` — i.e. the
codebase has treated `backend` as the canonical name since the CT-split, and the
root `docker-compose.yml`'s `server:` service name is the one holdout, not the
other way around.

**Decision: rename the compose service `server` → `backend`; leave the on-disk
directory as `server/`.** Renaming the directory too would touch every path in
`server/node_modules/` for zero behavioral benefit (Docker only cares about the
`build:` context path, which stays `./server` regardless of the service name) —
that's git-history noise and merge-conflict risk with no upside. The service name
and the directory name not matching is a minor readability wart, not a bug; it's
a smaller cost than the alternative.

### Why the client (nginx) service is no longer published
In the split-CT topology, `client`'s port `5173` had to be published so Traefik
(on a different CT) could reach it over the LAN. On one CT, Traefik reaches it
over the internal Compose network at `client:80` — publishing it too would just be
an unnecessary second, unauthenticated path to the dashboard, undermining the
entire point of adding Authentik. Not publishing it is a strict security
improvement enabled directly by the topology change, not a new restriction imposed
on top of it.

### Why `postgres` and `pdm` are not published
Neither was ever meant to be reached from outside the stack — `pdm-db`'s and
`pdm`'s ports were only published in the split-CT setup because they needed to be
reachable *across CTs*. On one CT, "reachable across CTs" doesn't apply; both stay
on the internal Compose network exclusively. This is the direct replacement for
the old firewall rules that restricted those ports to specific CT IPs — instead of
firewalling them, they're simply never exposed to the LAN at all.

### Why `db/init/02-create-authentik-db.sh`'s "will not run" caveat is now false
That caveat existed because `pdm-db`'s volume was already initialized months
before Authentik was added. Here, the new CT's `postgres` volume is created fresh
on first `docker compose up` — all three init scripts
(`00-create-role.sh`, `01-init-pump-telemetry.sql`, `02-create-authentik-db.sh`)
fire automatically via `/docker-entrypoint-initdb.d/`, in the alphabetical order
their filenames already establish. **No manual `psql` provisioning step is needed
in this topology.** Update the header comment in `02-create-authentik-db.sh`
accordingly (§5.1) — leaving the old caveat in would be actively misleading.

### Why `AUTHENTIK_PG_HOST` disappears entirely
In the split-CT plan this was a `.env.auth` variable holding a remote CT's IP
(`10.10.10.15`), because the DB host was configurable/remote. On one CT there is
exactly one place Postgres can be — the `postgres` service in the same compose
file — so this is now a fixed literal (`postgres`) in `docker-compose.yml`, not a
variable. One fewer thing to get wrong in `.env`.

### Why `DATABASE_URL` is now built from `PDM_APP_PASSWORD` instead of being its own separate secret
The split-CT `.env.example` had both a full `DATABASE_URL` connection string
*and* a separate `PDM_APP_PASSWORD` used only for provisioning — two places
holding the same password that had to be kept in sync by hand, with nothing
enforcing that. Docker Compose interpolates `${PDM_APP_PASSWORD}` inside a
service's `environment:` value at parse time, so `backend`'s `DATABASE_URL` can
reference `${PDM_APP_PASSWORD}` directly:
```
DATABASE_URL: postgres://pdm_app:${PDM_APP_PASSWORD}@postgres:5432/pump_telemetry
```
One password, one place it's set, no drift possible. This is a small hardening
improvement available now because everything lives in one compose file with one
`.env` — it wasn't practical across separate compose files on separate CTs.

---

## 3. Decisions already made

| Decision | Choice | Rationale |
|---|---|---|
| Topology | One Proxmox CT, one Docker daemon, one `docker-compose.yml` | User's explicit call, driven by weak-hardware overhead of the 5-CT split. |
| Target CT | Brand-new CT, not a reused/repurposed existing one | User's explicit choice; data is disposable (§0) so there's no migration reason to prefer reuse. |
| `server` vs `backend` naming | Rename the **compose service** to `backend`; keep the **directory** `server/` | `nginx.conf` already hardcodes `backend`; renaming the directory touches `node_modules` for no benefit (§2). |
| Client port publishing | Not published | Traefik reaches it internally at `client:80`; publishing it would be a second, unauthenticated path to the dashboard (§2). |
| Postgres/pdm port publishing | Not published | Never needed LAN reachability except across CTs, which no longer applies (§2). |
| `AUTHENTIK_PG_HOST` | Removed — hardcoded as `postgres` in compose | Only one place Postgres can be now; a variable for it is a variable that can't be wrong the useful way (§2). |
| `DATABASE_URL` construction | Interpolates `${PDM_APP_PASSWORD}` instead of a duplicate hardcoded password | Removes a manual-sync footgun between two places holding the same secret (§2). |
| `db/init/02-create-authentik-db.sh` | Its "will not run on a live volume" caveat is corrected — it DOES run now | Fresh volume on a fresh CT (§2). |
| TLS | Still dropped — plain HTTP only | Unchanged, final decision from the prior plan. Not reopened here. |
| Retired split-CT compose files | **Deleted**, not superseded-banner'd | Unlike docs, a stale *operational* compose file left in the repo invites running it against the wrong topology by accident. |
| Retired split-CT plan doc | Superseded banner, not deleted | Matches this repo's existing convention (`docs/superpowers/specs/2026-08-06-...`); the reasoning inside is still cited as valid (§2 header). |
| Firewall | Collapsed to one CT: `tcp/80` open to LAN, `tcp/3000` restricted to Node-RED's host | Direct replacement for the old 4-CT matrix now that only two ports exist at all. |
| Router priorities, `trustForwardHeader`, no-Docker-socket, blueprint `authentik_host` split, Redis requirement | **Unchanged** from the prior plan | Topology-independent reasoning — see that plan's §2 for the full "why". |

---

## 4. Critical files

### New file
| File | Purpose |
|---|---|
| `docs/plan/2026-08-10-single-ct-consolidation.md` | This plan. |

### Heavily modified
| File | Change |
|---|---|
| `docker-compose.yml` | Extended from its current `server`/`client`/`pdm` shape to add `postgres`, `traefik`, `authentik-redis`, `authentik-server`, `authentik-worker`; `server` renamed to `backend`; port publishing reduced to `80`/`3000` only; every `extra_hosts`/IP replaced by service-name networking (§5.2). |
| `authentik/traefik/dynamic/dynamic.yml` | Frontend target changes from `http://10.10.10.11:5173` to `http://client:80`; the "IP is a non-interpolatable literal" comment block is deleted (no longer true — it's a stable container name now, not an address that could change); Traefik's internal service alias renamed `frontend` → `client` for consistency (§5.3). |
| `db/init/02-create-authentik-db.sh` | Header comment's "will not run on the live volume" caveat corrected (§2, §5.1). |
| `.env.example` (root) | Becomes the **single** env file for the whole stack — merges everything currently split across root `.env.example`, `server/.env.example`, and `.env.auth.example` (§5.4). |

### Deleted
| File | Why |
|---|---|
| `docker-compose.backend.yml`, `docker-compose.frontend.yml`, `docker-compose.pdm.yml`, `docker-compose.db.yml`, `docker-compose.auth.yml` | Superseded by the single merged `docker-compose.yml`. Kept-around operational compose files are a footgun, not history worth preserving (§3). |
| `server/.env.example`, `.env.auth.example` | Folded into the single root `.env.example`. |

### Unchanged (verified, no edits needed)
| File | Why |
|---|---|
| `client/nginx.conf` | Already says `proxy_pass http://backend:3000/api/` — this is exactly what the renamed `backend` service resolves to via Docker DNS. Zero changes. |
| `authentik/traefik/traefik.yml` | Port-80-only, file-provider, persistent-access-log config is topology-independent — unchanged. |
| `authentik/blueprints/dashboard-proxy-provider.yaml` | `authentik_host: http://authentik-server:9000/` was already a container name, not an IP — already correct for single-CT. `external_host`/`authentik_host_browser` stay `http://dashboard.home` / `http://auth.home/` — hostnames, not addresses, unaffected by the topology change. |
| `db/init/00-create-role.sh`, `01-init-pump-telemetry.sql` | Topology-independent; already correct. |

### Superseded (banner, not deleted)
| File | Change |
|---|---|
| `docs/plan/2026-08-09-authentik-split-ct.md` | Status banner added at the top marking it superseded-for-topology by this plan, same treatment as the 2026-08-06 spec already received. |

---

## 5. Work items

### 5.1 Commit 1 — Fix `db/init/02-create-authentik-db.sh`'s stale caveat

Replace the "*** THIS SCRIPT WILL NOT RUN ON THE LIVE pdm-db INSTANCE ***" block
(lines 27–32) with a note that on this topology, the script **does** run
automatically on first boot of a fresh `postgres` volume, same as
`00-create-role.sh`/`01-init-pump-telemetry.sql` — no manual provisioning step
exists in this plan. Everything else in the file (role/database creation, no
`CREATE EXTENSION timescaledb`, the `.sh`-not-`.sql` rationale) is unchanged and
correct.

- **Risk:** Low. Comment-only change.

### 5.2 Commit 2 — Merge everything into `docker-compose.yml`

Final shape (services in dependency order):

```yaml
services:
  postgres:
    image: timescale/timescaledb:2.17.2-pg16
    environment:
      POSTGRES_DB: postgres
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD must be set}
      PDM_APP_PASSWORD: ${PDM_APP_PASSWORD:?PDM_APP_PASSWORD must be set}
      AUTHENTIK_PG_PASSWORD: ${AUTHENTIK_PG_PASSWORD:?AUTHENTIK_PG_PASSWORD must be set}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    # No ports: — internal only. See §2 "Why postgres and pdm are not published".

  pdm:
    build: ./pdm
    restart: unless-stopped
    # No ports: — internal only.

  backend:
    build: ./server
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      pdm:
        condition: service_started
    environment:
      PORT: 3000
      DATABASE_URL: postgres://pdm_app:${PDM_APP_PASSWORD}@postgres:5432/pump_telemetry
      CLIENT_ORIGIN: ${CLIENT_ORIGIN:-http://dashboard.home}
      PDM_SERVICE_URL: http://pdm:8000
    restart: unless-stopped
    # Renamed from "server" — see §2/§3. Directory stays ./server.

  client:
    build:
      context: ./client
      args:
        VITE_API_URL: /api
    depends_on:
      - backend
    restart: unless-stopped
    # No ports: — reached only via Traefik at client:80. See §2.

  authentik-redis:
    image: redis:7-alpine
    command: --save 60 1 --loglevel warning
    volumes:
      - authentik_redis_data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "redis-cli ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 5

  authentik-server:
    image: ghcr.io/goauthentik/server:${AUTHENTIK_TAG}
    command: server
    depends_on:
      authentik-redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
    environment:
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY}
      AUTHENTIK_POSTGRESQL__HOST: postgres
      AUTHENTIK_POSTGRESQL__PORT: 5432
      AUTHENTIK_POSTGRESQL__USER: authentik_svc
      AUTHENTIK_POSTGRESQL__PASSWORD: ${AUTHENTIK_PG_PASSWORD}
      AUTHENTIK_POSTGRESQL__NAME: authentik_db
      AUTHENTIK_REDIS__HOST: authentik-redis
      AUTHENTIK_BOOTSTRAP_EMAIL: ${AUTHENTIK_BOOTSTRAP_EMAIL}
      AUTHENTIK_BOOTSTRAP_PASSWORD: ${AUTHENTIK_BOOTSTRAP_PASSWORD}
      AUTHENTIK_BOOTSTRAP_TOKEN: ${AUTHENTIK_BOOTSTRAP_TOKEN}
      AUTHENTIK_ERROR_REPORTING__ENABLED: "false"
      AUTHENTIK_DISABLE_UPDATE_CHECK: "true"
    volumes:
      - authentik_media:/media
      - authentik_certs:/certs
      - ./authentik/blueprints:/blueprints/custom:ro
    restart: unless-stopped
    # No ports: — reached only via Traefik at authentik-server:9000.

  authentik-worker:
    image: ghcr.io/goauthentik/server:${AUTHENTIK_TAG}
    command: worker
    depends_on:
      authentik-redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
    environment:
      # Same as authentik-server, INCLUDING bootstrap vars — the worker performs
      # first-boot bootstrap, not the server process. (Unchanged reasoning from
      # the prior plan.)
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY}
      AUTHENTIK_POSTGRESQL__HOST: postgres
      AUTHENTIK_POSTGRESQL__PORT: 5432
      AUTHENTIK_POSTGRESQL__USER: authentik_svc
      AUTHENTIK_POSTGRESQL__PASSWORD: ${AUTHENTIK_PG_PASSWORD}
      AUTHENTIK_POSTGRESQL__NAME: authentik_db
      AUTHENTIK_REDIS__HOST: authentik-redis
      AUTHENTIK_BOOTSTRAP_EMAIL: ${AUTHENTIK_BOOTSTRAP_EMAIL}
      AUTHENTIK_BOOTSTRAP_PASSWORD: ${AUTHENTIK_BOOTSTRAP_PASSWORD}
      AUTHENTIK_BOOTSTRAP_TOKEN: ${AUTHENTIK_BOOTSTRAP_TOKEN}
      AUTHENTIK_ERROR_REPORTING__ENABLED: "false"
      AUTHENTIK_DISABLE_UPDATE_CHECK: "true"
    volumes:
      - authentik_media:/media
      - ./authentik/blueprints:/blueprints/custom:ro
    restart: unless-stopped

  traefik:
    image: traefik:v3.7.10
    ports:
      - "80:80"
    volumes:
      - ./authentik/traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      - ./authentik/traefik/dynamic:/etc/traefik/dynamic:ro
      - ./authentik/traefik/logs:/var/log/traefik
    depends_on:
      authentik-server:
        condition: service_started
      client:
        condition: service_started
    restart: unless-stopped
    # No /var/run/docker.sock — unchanged reasoning, file provider only.

volumes:
  pg_data:
  authentik_redis_data:
  authentik_media:
  authentik_certs:
```

Notes:
- `PDM_SERVICE_URL` is now a fixed `http://pdm:8000` literal in `backend`'s
  environment rather than a `${PDM_SERVICE_URL:-...}` fallback — there's only one
  place `pdm` can be now, same reasoning as `AUTHENTIK_PG_HOST` (§2).
- `CLIENT_ORIGIN` keeps its `${CLIENT_ORIGIN:-http://dashboard.home}` fallback
  form (unlike `PDM_SERVICE_URL`) because it's plausible someone temporarily wants
  a different value for local debugging without editing `.env`.
- No healthcheck block on `authentik-server` — unchanged reasoning from the prior
  plan (the image ships no `curl`; use `wget -qO-` or `ak healthcheck` manually if
  ever added).

- **Risk:** Medium. This is where every other piece gets wired together — verify
  incrementally per §7, not all at once.

### 5.3 Commit 3 — Update `authentik/traefik/dynamic/dynamic.yml`

Change:
```yaml
  services:
    client:                                    # renamed from "frontend"
      loadBalancer:
        servers:
          - url: "http://client:80"            # was http://10.10.10.11:5173
        passHostHeader: true                   # unchanged — still needed so nginx
                                                # gets the real Host header (§2 of
                                                # the prior plan; reasoning unchanged)
```
Delete the 6-line comment block explaining that Traefik's file provider can't
interpolate env vars and that the frontend IP is therefore a hardcoded literal
(prior plan §5.3) — that caveat existed specifically because the value was a LAN
IP that could change independently of this file. `client` is now a stable
Compose service name; there's no longer a "the real value lives somewhere else"
problem to caveat. Also update the `dashboard` router's `service: frontend` →
`service: client` to match the rename.

- **Risk:** Low. Single-file, mechanical change; §7 verifies it directly.

### 5.4 Commit 4 — One merged `.env.example`

Structure (comments trimmed here for brevity — full comments carry over from the
three source files, adjusted for the new topology):
```
# ── Core ─────────────────────────────────────────────────────────────────
CLIENT_ORIGIN=http://dashboard.home
PDM_NEGATIVE_SAMPLE_RATE=60

# ── Postgres ─────────────────────────────────────────────────────────────
POSTGRES_SUPERUSER_PASSWORD=change-me
PDM_APP_PASSWORD=change-me
AUTHENTIK_PG_PASSWORD=change-me

# ── Authentik / Traefik ──────────────────────────────────────────────────
AUTH_DASHBOARD_HOST=dashboard.home
AUTH_AUTHENTIK_HOST=auth.home
AUTHENTIK_TAG=2026.5.6
AUTHENTIK_SECRET_KEY=change-me
AUTHENTIK_BOOTSTRAP_EMAIL=admin@dashboard.home
AUTHENTIK_BOOTSTRAP_PASSWORD=change-me
AUTHENTIK_BOOTSTRAP_TOKEN=change-me
```
Dropped entirely (no longer meaningful in this topology): `DATABASE_URL` as a
standalone var (§2 — now constructed in compose from `PDM_APP_PASSWORD`),
`PDM_SERVICE_URL` (§5.2 — now a fixed literal), `AUTHENTIK_PG_HOST`/`_PORT`/`_USER`/
`_DB` (§2 — fixed literals now that there's one Postgres). `PORT=3000` also
dropped — it was only ever informational for local dev; the compose file hardcodes
`PORT: 3000` directly and `ports: ["3000:3000"]` already documents the number.

`server/.env.example` and `.env.auth.example` are deleted — their content is fully
absorbed above.

- **Risk:** Low.

### 5.5 Commit 5 — Delete retired files, add superseded banner

- Delete: `docker-compose.backend.yml`, `docker-compose.frontend.yml`,
  `docker-compose.pdm.yml`, `docker-compose.db.yml`, `docker-compose.auth.yml`,
  `server/.env.example`, `.env.auth.example`.
- Add a superseded-for-topology banner to the top of
  `docs/plan/2026-08-09-authentik-split-ct.md`, pointing at this plan — same
  pattern already used for the 2026-08-06 spec.

- **Risk:** Low. Purely subtractive/documentation; §7 doesn't depend on these
  files existing.

---

## 6. Firewall runbook (operator instructions, not repo code)

One CT now, not four:

| CT | Input policy | ACCEPT rules |
|---|---|---|
| app CT | DROP | tcp/80 from the LAN (the front door); tcp/3000 from wherever Node-RED runs; tcp/22 + icmp from the management host |

Same ordering caution as the prior plan: add the SSH ACCEPT rule and verify it
works from a second terminal **before** setting the input policy to DROP, and
keep `pct enter <vmid>` open as the recovery path. Apply this only after §7's
end-to-end verification passes — applying it earlier risks locking yourself out
of a stack that isn't confirmed working yet, with no way in.

---

## 7. Verification

1. **Fresh boot, DB first.** `docker compose up -d postgres`. Confirm the three
   init scripts ran: `docker compose logs postgres | grep -E "00-create-role|01-init-pump-telemetry|02-create-authentik-db"` shows all three executing with no errors. `docker compose exec postgres psql -U postgres -c "\l"` lists both `pump_telemetry` (owner `pdm_app`) and `authentik_db` (owner `authentik_svc`).
2. **Authentik core, before Traefik.** `docker compose up -d authentik-redis authentik-server authentik-worker`. Logs show migrations completing clean; worker log shows the blueprint applied.
3. **Backend + pdm.** `docker compose up -d pdm backend`. `docker compose exec backend wget -qO- http://localhost:3000/api/health` (or `curl` if present in that image) returns healthy, `"database": "connected"`.
4. **Client + Traefik.** `docker compose up -d client traefik`. From a hosts-configured machine: `curl -I http://auth.home/` → `2xx`/`3xx`. `curl -sI http://dashboard.home/` → `302` toward the outpost. `curl -sI http://dashboard.home/api/health` → also `302` (same "one gate covers UI+API" assertion as the prior plan, now with one fewer network hop).
5. **Browser end-to-end.** Login flow → dashboard renders with live data, `/api` XHRs succeed under the same session cookie.
6. **Ingestion.** From the Node-RED host: `POST http://<app-CT-IP>:3000/api/data` succeeds unauthenticated; ≥3 windows close correctly.
7. **Apply the firewall** (§6), then from a third, non-permitted LAN machine: `curl -m 5 http://<app-CT-IP>:3000/api/health` → blocked; `http://dashboard.home` still works.
8. **Regression re-run.** Repeat steps 5–6 after the firewall is live.
9. **Reproducibility.** `docker compose down -v` (note the `-v` — unlike the prior
   plan, there is no separate remote database to preserve; a full teardown
   including volumes is the correct reproducibility test here) then `up -d`.
   Everything, including both Postgres databases and the Authentik blueprint,
   comes back identically with zero manual steps.
10. ~~Only after all of the above passes: decommission the 5 old CTs.~~ **Moot —
    the old CTs were already destroyed before implementation began (§0).** Steps
    1–9 above are now the *only* verification this stack gets before it's the
    live system; there is no staged cutover with a fallback. Do not skip or
    reorder any of them, and do not apply the firewall (§6) until step 8 passes
    cleanly.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Firewall applied before the stack is verified working → locked out | **High** | Strict ordering (§7 step 7, after end-to-end passes); SSH rule before DROP policy; `pct enter` console kept open |
| `server`→`backend` rename missed somewhere (a stray reference to the old service name) | Medium | `client/nginx.conf` needs zero changes and already proves the target name; grep the repo for `docker-compose.backend.yml`/`extra_hosts`/old IPs before considering this commit done |
| One CT is now a single point of failure for the entire stack (not just auth, as in the prior plan) | Medium — accepted | Explicit trade-off the user chose for hardware reasons (§1 "Why") |
| **No fallback topology exists** — the old 5 CTs are already destroyed, before verification of the new one | **High — elevated from the plan's original design, which assumed a staged cutover** | There is no mitigation that restores a fallback at this point; the only lever left is discipline in §7's verification order — do not skip steps, do not apply the firewall (§6) early, and keep `pct enter` console access to the new CT itself as the only remaining recovery path if something breaks mid-setup |
| `docker compose down -v` habit forming from step 9's reproducibility test | Low — but worth naming | Once this stack holds real (non-disposable) data in the future, `-v` must never be run casually; this plan's step 9 is safe only because data is currently disposable (§0) |
| Secrets committed | High if it happens | `.env` stays gitignored; only `.env.example` with placeholders committed — unchanged from the prior plan |

---

## 9. Rollback

**Revised from the plan's original design.** The old 5 CTs were already destroyed
before implementation began (§0) — there is no "switch back to the old topology"
option anymore. Rollback within this plan means:

1. **Mid-implementation, on the new CT itself:** `docker compose down` (or
   `down -v` for a full reset, safe only because all data here is disposable —
   see the risk register) and retry from whichever §7 step failed. `pct enter`
   console access to this one CT is now the entire safety net.
2. **If the new CT itself is unrecoverable:** re-provision a CT from scratch and
   redo this plan's work items in order. Since the old CTs' data was disposable
   too, this is not meaningfully worse than the state before any of this work
   started — but it is a full rebuild, not a quick revert, which is the direct
   cost of having destroyed the old CTs ahead of verification rather than after.

---

## 10. Definition of done

- [ ] `docker-compose.yml` brings up all 8 services from a completely fresh CT with one `docker compose up -d` (staged per §7, not literally simultaneous)
- [ ] `backend` service resolves correctly via `client/nginx.conf`'s existing `http://backend:3000/api/` with zero changes to that file
- [ ] Only `80` and `3000` are published; `postgres`, `pdm`, `client`, `authentik-server`, `authentik-redis` are unreachable except over the internal Compose network
- [ ] All three `db/init/*` scripts run automatically on first boot; both databases and their owning roles exist and are isolated from each other
- [ ] `authentik/traefik/dynamic/dynamic.yml` points at `client:80`; no leftover LAN IP or `extra_hosts` reference anywhere in the repo
- [ ] Unauthenticated `GET http://dashboard.home/` and `GET http://dashboard.home/api/health` both redirect to login
- [ ] Browser login renders the dashboard with live data
- [ ] Node-RED's direct POST to `:3000/api/data` still works unauthenticated, before and after the firewall is applied
- [ ] `docker compose down -v && docker compose up -d` reproduces the entire stack, blueprint included, with zero manual steps
- [ ] The 5 retired compose files and 2 retired env-example files are deleted; `docs/plan/2026-08-09-authentik-split-ct.md` carries a superseded-for-topology banner
- [ ] The 5 old CTs are decommissioned only after every step above passes
