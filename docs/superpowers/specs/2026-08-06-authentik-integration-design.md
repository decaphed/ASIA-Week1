# Authentik Forward-Auth Integration — Design Spec

**Date:** 2026-08-06
**Status:** Approved design, pending implementation plan

> **Superseded for the split-CT topology.** This design assumed a
> single-host `docker-compose.yml` with Postgres as a container inside
> `docker-compose.auth.yml` (see "New files" below) — it explicitly defers
> the split-CT case to "a separate, larger design." That design is
> `docs/plan/2026-08-09-authentik-split-ct.md`, which now supersedes the
> topology-dependent parts of this spec (the `docker-compose.auth.yml`
> shape, the Postgres-as-a-service assumption, and the `dashboard.localhost`
> / `auth.localhost` hostnames below). This spec's topology-independent
> content — blueprint shape, `.env.auth.example` shape, router-priority
> reasoning, `trustForwardHeader: false`, the one-hostname-for-UI-and-API
> rationale, and dedicated Redis reasoning — is carried forward unchanged
> into the new plan. Read this spec for that reasoning; read the new plan
> for anything topology-specific (addresses, compose file contents, DNS
> names).

## Problem

The pump-monitoring stack (Node-RED simulator → Express+SQLite `server/` → React `client/`, plus an internal-only `pdm/` FastAPI service) has **zero authentication** anywhere. The README's Future Work section already flags this. We're adding a login gate in front of the dashboard and its API, without writing any auth code into the apps themselves.

## Scope

**In scope:**
- Gate the React dashboard (`client/`) and the Express API (`server/`, `/api/*`) behind an Authentik-enforced login.

**Explicitly out of scope (by user decision):**
- Node-RED's `POST /api/data` ingestion stays unauthenticated. It's a machine gateway (posts to a hardcoded LAN IP per `node-red/flow.json`, e.g. `http://10.10.10.12:3000/api/data`, not through any proxy), not an interactive session — forward-auth login doesn't apply to it.
- `pdm/` (internal-only, called by `server` over the default Docker network) is never exposed to Traefik.
- The alternate split-CT deployment (`docker-compose.backend.yml` / `docker-compose.frontend.yml` / `docker-compose.pdm.yml`, which wires separate hosts via `extra_hosts` at static LAN IPs) is **not** covered by this design. This targets only the single-host `docker-compose.yml` topology. Adapting this to the split-CT mode is a separate, larger design (cross-host discovery, TLS between CTs).
- No OIDC/JWT code in `client/` or `server/` — this is a reverse-proxy forward-auth pattern only.
- Rotating the app's own database off SQLite is unrelated future work; this design only guarantees Authentik's datastore doesn't collide with it.

## Architecture

```
Browser
  │
  ▼
Traefik (:80) ── Host(dashboard.localhost)                → authentik@docker middleware → client (nginx :80)
               ── Host(dashboard.localhost) && /api/*      → authentik@docker middleware → server (:3000)
               ── Host(auth.localhost)                     → authentik-server (:9000, no middleware)
               ── Host(dashboard.localhost) && /outpost.goauthentik.io/* → authentik-server (:9000, no middleware)

Node-RED ──POST /api/data──► server:3000 directly (LAN IP or Docker network) — never touches Traefik

authentik-server / authentik-worker ──► authentik-redis (dedicated)
                                     ──► postgres (shared instance) → database `authentik_db`, role `authentik_svc`
                                                                        (app's future Postgres/TimescaleDB migration
                                                                         gets its own database + role in the SAME
                                                                         shared instance — never the same database)
```

**Why one hostname (`dashboard.localhost`) for both client and API:** Authentik's session cookie is scoped per-domain. Routing both `/` (client) and `/api/*` (server) under the same host means one login covers both — no cross-origin cookie complexity.

**Why no explicit Traefik `networks:` block:** none of the existing compose files declare a custom network today — everything already rides Compose's implicit default network (`<project>_default`) and resolves siblings by service name. The overlay adds no `networks:` key to any service, so it can't accidentally override/replace that implicit default (a real risk if you *did* declare one without re-listing `default`). Traefik, Authentik, `client`, and `server` all land on the same implicit network automatically when the overlay is merged in.

**Why one shared Postgres container instead of a dedicated one for Authentik:** the user's system-wide database strategy is heading toward Postgres/TimescaleDB serving multiple services, not one Postgres container per service. Postgres supports this natively — one server process can host multiple logical **databases**, each with its own role scoped to only that database. That gives full schema/permission isolation (Authentik's role can't see or touch the app's tables, and vice versa) without running a separate Postgres process per service. This is different from putting everything in *one database* with shared tables, which is not done here — Authentik expects to own its database exclusively via its own migrations, and mixing schemas would force overly broad permissions. The shared container runs the `timescale/timescaledb` image (Postgres + the TimescaleDB extension pre-installed) so it's ready for the app's future migration without swapping images later; the extension itself is only enabled on the app's future database, not on `authentik_db`.

## New files

| File | Purpose |
|---|---|
| `docker-compose.auth.yml` | New overlay: `traefik`, `postgres` (shared instance), `authentik-redis`, `authentik-server`, `authentik-worker`, plus label-only override stanzas for the existing `client` and `server` services (no `build`/`environment`/`volumes` keys in those stanzas — only `labels:`, which Compose merges rather than replaces). |
| `.env.auth.example` | New env vars, placeholder values, same commented style as the existing `server/.env.example` / `client/.env.example`. Copied to a local `.env` (gitignored) before first run. |
| `authentik/blueprints/dashboard-proxy-provider.yaml` | Declarative bootstrap: Proxy Provider (forward-auth, single-application mode), Application, and embedded-outpost binding — read automatically by `authentik-worker` on boot. Matches this repo's existing preference for config-as-tracked-files (e.g. `pdm/app/thresholds.yaml`) over manual UI steps. |
| `postgres/init/01-create-authentik-db.sh` | Init script, run once by the Postgres container on first boot (standard `/docker-entrypoint-initdb.d/` convention), that creates the `authentik_svc` role and `authentik_db` database inside the shared instance. Future services get their own numbered init script here (e.g. `02-create-app-db.sh`) when they migrate onto this same Postgres instance. |

**One deliberate change to `docker-compose.yml`** (everything else — `client/`, `server/`, `node-red/`, `pdm/` — untouched): `server`'s and `client`'s port publications change from `"3000:3000"`/`"5173:80"` to `"127.0.0.1:3000:3000"`/`"127.0.0.1:5173:80"`. See "Security review findings" below for why.

## `docker-compose.auth.yml` — shape

```yaml
services:
  traefik:
    image: traefik:v3.1          # pin explicitly; no other compose file here floats `:latest`
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --api.dashboard=true
      - --api.insecure=true       # dev-only convenience; drop before any non-local use
    ports:
      - "80:80"
      - "127.0.0.1:8080:8080"     # Traefik dashboard, loopback-only
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

  # Label-only override merged onto the existing `server` service.
  server:
    labels:
      - traefik.enable=true
      - traefik.http.routers.server.rule=Host(`${AUTH_DASHBOARD_HOST}`) && PathPrefix(`/api`)
      - traefik.http.routers.server.entrypoints=web
      - traefik.http.routers.server.priority=20
      - traefik.http.routers.server.middlewares=authentik@docker
      - traefik.http.services.server.loadbalancer.server.port=3000

  # Label-only override merged onto the existing `client` service.
  client:
    labels:
      - traefik.enable=true
      - traefik.http.routers.client.rule=Host(`${AUTH_DASHBOARD_HOST}`)
      - traefik.http.routers.client.entrypoints=web
      - traefik.http.routers.client.priority=1   # explicit — don't rely on Traefik's auto-computed priority
      - traefik.http.routers.client.middlewares=authentik@docker
      - traefik.http.services.client.loadbalancer.server.port=80

  # Shared Postgres instance for the whole system, not Authentik-exclusive.
  # Authentik gets its own database + role inside it (created by the init
  # script below); future services (e.g. the app's SQLite replacement) get
  # their own database + role in this same instance via their own init script
  # and their own PG_* env vars — never by reusing Authentik's database.
  postgres:
    image: timescale/timescaledb:2.17.2-pg16   # Postgres 16 + TimescaleDB extension, ready for future use
    environment:
      POSTGRES_USER: ${POSTGRES_ADMIN_USER}
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD}
      POSTGRES_DB: postgres                      # default maintenance DB; real databases created by init scripts
      AUTHENTIK_PG_USER: ${AUTHENTIK_PG_USER}
      AUTHENTIK_PG_PASSWORD: ${AUTHENTIK_PG_PASSWORD}
      AUTHENTIK_PG_DB: ${AUTHENTIK_PG_DB}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_ADMIN_USER}"]
    restart: unless-stopped

  authentik-redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "60", "1", "--loglevel", "warning"]
    volumes:
      - authentik_redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
    restart: unless-stopped

  authentik-server:
    image: ghcr.io/goauthentik/server:${AUTHENTIK_TAG}   # pin a specific tag; migrations are tag-coupled
    command: server
    depends_on:
      postgres: { condition: service_healthy }
      authentik-redis: { condition: service_healthy }
    environment:
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY}
      AUTHENTIK_POSTGRESQL__HOST: postgres
      AUTHENTIK_POSTGRESQL__USER: ${AUTHENTIK_PG_USER}
      AUTHENTIK_POSTGRESQL__PASSWORD: ${AUTHENTIK_PG_PASSWORD}
      AUTHENTIK_POSTGRESQL__NAME: ${AUTHENTIK_PG_DB}
      AUTHENTIK_REDIS__HOST: authentik-redis
      AUTHENTIK_BOOTSTRAP_EMAIL: ${AUTHENTIK_BOOTSTRAP_EMAIL}
      AUTHENTIK_BOOTSTRAP_PASSWORD: ${AUTHENTIK_BOOTSTRAP_PASSWORD}
      AUTHENTIK_BOOTSTRAP_TOKEN: ${AUTHENTIK_BOOTSTRAP_TOKEN}
      AUTHENTIK_ERROR_REPORTING__ENABLED: "false"
    volumes:
      - authentik_media:/media
      - authentik_certs:/certs
      - ./authentik/blueprints:/blueprints/custom:ro
    labels:
      - traefik.enable=true
      # Login UI / admin, unauthenticated by definition
      - traefik.http.routers.authentik.rule=Host(`${AUTH_AUTHENTIK_HOST}`)
      - traefik.http.routers.authentik.entrypoints=web
      - traefik.http.services.authentik.loadbalancer.server.port=9000
      # Outpost callback route — MUST live on the dashboard host, MUST NOT carry the auth middleware,
      # and MUST outrank the client's catch-all router.
      - traefik.http.routers.authentik-outpost.rule=Host(`${AUTH_DASHBOARD_HOST}`) && PathPrefix(`/outpost.goauthentik.io/`)
      - traefik.http.routers.authentik-outpost.entrypoints=web
      - traefik.http.routers.authentik-outpost.priority=30
      - traefik.http.routers.authentik-outpost.service=authentik
      # Forward-auth middleware, attached to the client/server routers above (not to itself)
      - traefik.http.middlewares.authentik.forwardauth.address=http://authentik-server:9000/outpost.goauthentik.io/auth/traefik
      - traefik.http.middlewares.authentik.forwardauth.trustForwardHeader=false   # Traefik is the outermost edge here — nothing upstream to trust
      - traefik.http.middlewares.authentik.forwardauth.authResponseHeaders=X-authentik-username,X-authentik-groups,X-authentik-email,X-authentik-name,X-authentik-uid
    restart: unless-stopped

  authentik-worker:
    image: ghcr.io/goauthentik/server:${AUTHENTIK_TAG}
    command: worker
    depends_on:
      postgres: { condition: service_healthy }
      authentik-redis: { condition: service_healthy }
    environment:
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY}
      AUTHENTIK_POSTGRESQL__HOST: postgres
      AUTHENTIK_POSTGRESQL__USER: ${AUTHENTIK_PG_USER}
      AUTHENTIK_POSTGRESQL__PASSWORD: ${AUTHENTIK_PG_PASSWORD}
      AUTHENTIK_POSTGRESQL__NAME: ${AUTHENTIK_PG_DB}
      AUTHENTIK_REDIS__HOST: authentik-redis
    volumes:
      - authentik_media:/media
      - ./authentik/blueprints:/blueprints/custom:ro
    restart: unless-stopped

volumes:
  pg_data:
  authentik_redis_data:
  authentik_media:
  authentik_certs:
```

`postgres/init/01-create-authentik-db.sh` (runs once, only on a fresh `pg_data` volume — standard Postgres image behavior for anything mounted at `/docker-entrypoint-initdb.d/`):

```bash
#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER ${AUTHENTIK_PG_USER} WITH PASSWORD '${AUTHENTIK_PG_PASSWORD}';
    CREATE DATABASE ${AUTHENTIK_PG_DB} OWNER ${AUTHENTIK_PG_USER};
EOSQL
```

Notes:
- Router **priority matters**: the outpost callback route (30) must outrank the API route (20), which must outrank the client's default catch-all, or requests get swallowed by the wrong router.
- The forward-auth middleware is attached only to the `client` and `server` routers — never to the outpost router or the `auth.localhost` router (that would create a redirect loop).
- `authentik-worker` does **not** need the Docker socket mounted — that's only required if Authentik is asked to manage outposts as separate containers, which the embedded-outpost approach here avoids.
- **Init scripts only run once, on first container start with an empty volume.** If you need to add a database later (e.g. the app's future Postgres/TimescaleDB migration), add a new `postgres/init/02-create-app-db.sh` — it runs automatically only if `pg_data` is still fresh, or must be executed manually with `psql` against the running instance otherwise.
- **Known pre-existing bug, not caused by this work:** `client/nginx.conf` proxies `/api/` to `http://backend:3000/`, but the compose service in `docker-compose.yml` is named `server` (the `backend` alias only exists via `extra_hosts` in the separate split-CT `docker-compose.frontend.yml`). This design routes `/api/*` through Traefik straight to `server:3000`, which sidesteps the bug rather than fixing it. Worth fixing separately at some point, but out of scope here.

## `.env.auth.example` — shape

```
# ── Authentik / Traefik forward-auth configuration ──────────────────────
# Copy to ".env" before running:
#   docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d

# Hostnames Traefik routes on. Add both to your hosts file if they don't
# already resolve to 127.0.0.1 (test first — some OSes resolve *.localhost
# to loopback automatically per RFC 6761).
AUTH_DASHBOARD_HOST=dashboard.localhost
AUTH_AUTHENTIK_HOST=auth.localhost

# Shared Postgres instance's admin/superuser — used only to run init scripts
# that create per-service databases and roles (see postgres/init/). No
# application ever connects with this user directly.
POSTGRES_ADMIN_USER=pg_admin
POSTGRES_ADMIN_PASSWORD=change-me

# Authentik's own database + role INSIDE the shared Postgres instance above.
# Scoped so Authentik's role can only see/modify authentik_db — it has no
# access to any other database that later gets added to this same instance
# (e.g. the app's future Postgres/TimescaleDB migration, which will get its
# own APP_PG_* user/database here, never this one).
AUTHENTIK_PG_USER=authentik_svc
AUTHENTIK_PG_PASSWORD=change-me
AUTHENTIK_PG_DB=authentik_db

# Authentik image tag — pin a specific release, never `latest` (migrations
# are tag-coupled; an unplanned upgrade can break an existing DB volume).
AUTHENTIK_TAG=2024.10

# Session/cookie signing key. Generate with `openssl rand -base64 36` (or
# PowerShell: [Convert]::ToBase64String((1..48|%{Get-Random -Max 256}))).
AUTHENTIK_SECRET_KEY=change-me

# First-boot admin bootstrap (akadmin). Read once on first startup only —
# changing these after the Postgres volume exists has no effect (you'd need
# to wipe the shared pg_data volume and re-bootstrap). Safe to leave in .env; not
# committed since .env is gitignored.
AUTHENTIK_BOOTSTRAP_EMAIL=admin@dashboard.localhost
AUTHENTIK_BOOTSTRAP_PASSWORD=change-me
AUTHENTIK_BOOTSTRAP_TOKEN=change-me
```

## Why Redis is required

Authentik is architecturally a Django app with a Celery-based worker. Redis backs the worker's task queue (background jobs: blueprint reconciliation, outpost sync, scheduled cleanup) and `authentik-server`'s session/cache layer. It isn't an optional add-on for this design — Authentik requires it regardless of deployment pattern.

## Authentik one-time setup

**Recommended: declarative blueprint** (`authentik/blueprints/dashboard-proxy-provider.yaml`), auto-applied by `authentik-worker` on boot. Contains three model entries:
1. A `authentik_providers_proxy.proxyprovider` — mode **"Forward auth (single application)"** (not domain-level; there's exactly one protected host here), external host `http://${AUTH_DASHBOARD_HOST}`.
2. A `authentik_core.application` bound to that provider.
3. An update to the built-in embedded outpost, adding the application to its assignment.

This makes the entire auth configuration reproducible from git — wiping `authentik_pg_data` and re-upping regenerates the same provider/application/outpost without manual clicking, matching the rest of this stack's compose-declarative style.

**Fallback (manual):** log into `http://auth.localhost` as `akadmin` → Applications → Providers → create Proxy Provider as above → Applications → Applications → create, bind to the provider → Applications → Outposts → edit the embedded outpost → add the new application → Update.

## Verification (end-to-end)

- `curl -i http://dashboard.localhost/` unauthenticated → `302` redirect to Authentik login (not 200, not 500).
- `curl -i http://dashboard.localhost/api/health` unauthenticated → also `302` — proves one middleware gates both app and API.
- Browser login as `akadmin` → redirected back to the dashboard → live data renders (both the SPA shell and its `/api` XHRs succeeded under the same session cookie).
- `curl -i -X POST http://localhost:3000/api/data -H "Content-Type: application/json" -d '{...}'` → still succeeds directly, unauthenticated, no redirect — proves Node-RED's ingestion path is untouched.
- `curl -s http://127.0.0.1:8080/api/rawdata` (Traefik dashboard API) contains no router for `pdm` — proves it stays unexposed.
- `docker compose ... exec postgres psql -U <admin> -c "\l"` lists `authentik_db` alongside Postgres's default maintenance databases — confirms the init script ran. `docker compose ... exec postgres psql -U <authentik_svc> -d authentik_db -c "\du"` confirms the `authentik_svc` role has no grants on any other database.
- `curl -i http://localhost:3000/api/live` from the same machine still succeeds (loopback-bound port, intentionally reachable locally) — but `curl -i http://<this-machine's-LAN-IP>:3000/api/live` from another device on the network now fails to connect, proving the bypass is closed for anyone off-host.
- Removing `-f docker-compose.auth.yml` from the `docker compose up` command restores the pre-auth stack exactly, since `client`/`server` keep their original loopback-bound ports (5173, 3000) throughout — this is the rollback path, always available without needing to tear anything down.

## Accepted risks (by design, not defects)

- Port 3000 remains an unauthenticated ingress **on the local host only** (loopback-bound, see Security review findings below), because Node-RED needs it and adding auth there would require actual application code changes (a shared-secret header, checked in Express middleware) — that's a separate, later piece of work if ever needed. This is now scoped to "anyone with a shell on this machine," not "anyone on the LAN."
- This design is HTTP-only, no TLS, appropriate for local dev on `.localhost` hosts. Moving this to a real deployment requires a `websecure` Traefik entrypoint, real certificates, and switching the provider's external host to `https://`. Do not repoint `dashboard.localhost`/`auth.localhost` at a real routable IP without adding TLS first — the session cookie has no `Secure` flag in this HTTP-only setup.
- The shared Postgres instance's admin/superuser credential (`POSTGRES_ADMIN_USER`/`PASSWORD`) has unrestricted access to every database in the instance, present and future — per-database role scoping (Authentik's `authentik_svc` vs. the app's future role) only isolates the service roles from each other, not from this superuser. Treat this credential with the same care as the Authentik secret key; it isn't meant to be used by any application, only by the init scripts.
- Traefik's dashboard (`--api.insecure=true`, loopback-bound) is a minor recon surface if Windows/Docker Desktop's loopback-port NAT behavior ever exposes it beyond the local host (a known class of Docker Desktop networking quirk). If this is a concern, drop `--api.dashboard=true`/`--api.insecure=true` entirely — the dashboard is a convenience for debugging, not required for the design to function.

## Security review findings

An independent security review (`ecc:security-reviewer`) of this design surfaced two critical and two high findings, resolved as follows:

1. **CRITICAL — port bypass.** `server`'s and `client`'s original all-interfaces port publications (`3000:3000`, `5173:80`) stayed live for the entire time the "protected" stack ran, not just as a rollback path — anyone on the LAN could reach the dashboard/API directly, skipping Authentik entirely. **Fixed:** both now bind to `127.0.0.1` only in `docker-compose.yml` (see "One deliberate change to `docker-compose.yml`" above). Local access (browser, Node-RED on the same host) is unaffected; LAN/remote access to the unauthenticated path is closed.
2. **CRITICAL — header-spoofing risk.** As a direct consequence of Finding 1, anyone reaching `server:3000` directly could forge `X-authentik-*` identity headers with no verification, since Traefik/Authentik were never in that request path. **Fixed by the same change** — closing the direct route removes the ability to forge headers against Express outside the gated path. (Independent of this fix: Express does not currently read or trust any `X-authentik-*` header — this only matters for future code that might.)
3. **HIGH — router priority ambiguity.** `client`'s Traefik router had no explicit priority while `server` (20) and the outpost route (30) did, so the spec's own "must outrank" ordering claim wasn't fully enforced by the labels as drafted. **Fixed:** `client`'s router now has an explicit `priority=1`.
4. **HIGH — `trustForwardHeader=true` on an edge proxy.** This setting trusts client-supplied `X-Forwarded-*` headers, which is only correct when another trusted proxy sits in front of Traefik — here, Traefik is the outermost hop. **Fixed:** set to `false`.

Medium/low findings (shared-Postgres admin-credential blast radius, Traefik dashboard loopback-binding on Windows/Docker Desktop, HTTP-only reuse risk) are documented as accepted risks above rather than architecture changes — see "Accepted risks."

## Forward-compatibility with the planned SQLite → Postgres/TimescaleDB migration

The shared `postgres` service already runs the `timescale/timescaledb` image, so it's ready without an image swap. When the app's database migrates off SQLite, it gets its **own database and role inside this same instance** — not Authentik's `authentik_db`/`authentik_svc` — via a new `postgres/init/02-create-app-db.sh` script and its own `APP_PG_*` env vars (or applied manually with `psql` if the volume already exists by then, since init scripts only run on a fresh volume). The TimescaleDB extension gets enabled on the app's database only; `authentik_db` never needs it. This keeps one Postgres process to operate instead of two, while still giving Authentik and the app fully isolated schemas, permissions, and credentials — enforced by Postgres's per-database role scoping, not by convention.

**Topology correction — Postgres runs on its own CT, not as a compose service.**
`docs/plan/2026-08-04-timescaledb-migration.md` (§0) specifies the shared instance lives on
a dedicated Proxmox CT (`pdm-db`), separate from whatever CT runs this compose stack. The
`postgres:` service, its `pg_data` volume, and `postgres/init/01-create-authentik-db.sh`
above describe a Docker-managed container and its `/docker-entrypoint-initdb.d/`
first-boot convention — neither applies to an externally-provisioned CT. Before
implementing this design against the real environment:

- Drop the `postgres:` service block and `pg_data` volume from `docker-compose.auth.yml`;
  point `AUTHENTIK_POSTGRESQL__HOST` (on both `authentik-server` and `authentik-worker`) at
  the DB CT's address instead of the service name `postgres`.
- `authentik_db` / `authentik_svc` must be created by whatever process provisions `pdm-db`
  (outside this repo), not by an init script — the same way `pump_telemetry` / `pdm_app`
  are created per the TimescaleDB plan's Preconditions.
- The DB CT's firewall / `pg_hba.conf` must permit connections from whichever CT runs
  `authentik-server` and `authentik-worker`, in addition to the backend CT already required
  by the TimescaleDB plan.
- `docker compose ... exec postgres psql ...` in the Verification section above won't work
  once Postgres isn't a compose-managed service; verify with `psql "$DATABASE_URL"`-style
  commands against the DB CT directly instead.
