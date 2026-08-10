# Authentik SSO on a Dedicated CT — Implementation Plan

Repo-side work for putting a browser-facing Traefik + Authentik forward-auth
gate (plain HTTP, no TLS — see the decision in §3) on a new Proxmox CT (`auth`, `10.10.10.16`) in front of the
existing split-CT pump-monitoring stack, using the shared `pdm-db` Postgres/
TimescaleDB instance for Authentik's own database.

**Status:** planning only — nothing here has been executed yet.

Supersedes the topology-dependent half of
`docs/superpowers/specs/2026-08-06-authentik-integration-design.md` (that spec
targets the single-host `docker-compose.yml` and explicitly defers split-CT to
"a separate, larger design" — this is that design). Its topology-independent
content (blueprint shape, `.env.auth.example` shape, router-priority /
`trustForwardHeader` / one-hostname / Redis reasoning) is carried forward.

---

## 0. Preconditions (already done outside this repo)

Matching `docs/plan/2026-08-04-timescaledb-migration.md` §0, CT provisioning is
operator work, not repo work. Verify all of these before starting; if any
fails, stop — it is an infrastructure problem.

- New Proxmox CT `auth` exists at `10.10.10.16`, Docker + Docker Compose v2
  installed, this repo checked out on it.
- Existing CTs reachable and healthy: frontend `10.10.10.11:5173`, backend
  `10.10.10.12:3000`, pdm `10.10.10.14:8000`, pdm-db `10.10.10.15:5432`.
- From the auth CT: `nc -vz 10.10.10.11 5173` and `nc -vz 10.10.10.15 5432`
  both succeed.
- The pdm-db superuser password (`POSTGRES_SUPERUSER_PASSWORD` from that CT's
  `.env`) is available — needed to create Authentik's role/database manually.
- **Node-RED runs at `10.10.10.13`.** `node-red/flow.json:66` is currently
  **still** `"url": "http://localhost:3000/api/data"` — verified, not yet
  fixed, despite the file showing as locally modified for an unrelated
  reason. This is a **blocking precondition**, not an optional check: repoint
  it to `http://10.10.10.12:3000/api/data` before deploying, or ingestion
  from `10.10.10.13` will never reach the backend CT regardless of anything
  in this plan. Use `10.10.10.13` as the allowed source in the backend CT's
  firewall rule (§6) either way.
- **`psql` (the Postgres client) must be installed on the auth CT**, not just
  Docker/Compose — §5.1 and §7.1 both run it directly to provision and
  verify the database. If it's not available, use
  `docker run --rm postgres:16 psql "postgres://..." -c "SELECT 1;"` instead
  of installing a package.
- **Management/admin access is also `10.10.10.13`.** Same host is used for the
  mandatory SSH+ICMP allow rule on every CT (§6) before any firewall default
  policy flips to DROP.
- Out-of-band console access to every CT (`pct enter <vmid>` from the Proxmox
  host). You **will** need this if a firewall rule is wrong.

### Documentation discrepancy to fix as part of this work
`docs/plan/2026-08-04-timescaledb-migration.md` §0 states pdm-db is at
`10.10.10.13`. The actual address per `.env.example:9`, `server/.env.example:15`,
and the comment in `docker-compose.db.yml:19` is `10.10.10.15`. Correct the
migration doc in this work's docs commit so there is one truthful address in
the repo. (Note: `10.10.10.13` is a real host in this network — the Node-RED /
management workstation — so this was a genuine copy-paste error, not a typo of
a nonexistent address.)

---

## 1. Scope

### In scope
- A new `docker-compose.auth.yml` for the auth CT: `traefik`,
  `authentik-redis`, `authentik-server`, `authentik-worker`. No local
  Postgres.
- Traefik as the single browser-facing entrypoint, on plain HTTP `:80` — no
  TLS. This was a deliberate scope cut made after the architecture review:
  see §3 for the trade-off.
- Forward-auth gating of `http://dashboard.home` (both the SPA and,
  transitively, `/api/*`), proxied to the frontend CT's nginx.
- Authentik's `authentik_db` / `authentik_svc` on the shared pdm-db instance,
  via a new numbered init script **plus** a manual-application runbook (the
  volume is not fresh).
- Proxmox CT firewall runbook (documentation, not code) for the three
  restrictions.

### Explicitly NOT in scope
- Any change to `docker-compose.backend.yml`, `server/`, `pdm/`, or
  `docker-compose.pdm.yml`. The backend stays unauthenticated by design.
- Any change to `client/nginx.conf` or the React app. Because nginx already
  proxies `/api/` to `backend:3000`, one Traefik route covers UI and API.
- Node-RED's `POST /api/data` — stays unauthenticated, direct to
  `10.10.10.12:3000`, never touches Traefik.
- OIDC/JWT code anywhere in `client/` or `server/`. This is reverse-proxy
  forward-auth only.
- Per-user authorization / role mapping. Everyone who can log in sees the
  whole dashboard. Group-based gating is later work.
- Automating Proxmox firewall config (no Terraform/Ansible in this repo).
- Public/internet exposure, ACME/Let's Encrypt, HA for Authentik.

### Why
`README` Future Work has flagged zero-auth since the beginning. Now that the
stack is split across CTs with all three service ports published on the LAN,
"no auth" also means "no perimeter" — anyone on the LAN has full read access
to the dashboard and full write access to the ingestion API. This adds both a
login gate and a real perimeter, without touching application code.

---

## 2. Architecture

```
Browser (plain HTTP, LAN-only)
  │  http://dashboard.home  /  http://auth.home   → 10.10.10.16
  ▼
┌─ auth CT 10.10.10.16 ────────────────────────────────────────────────┐
│ traefik :80 (no TLS — plain HTTP entrypoint only)                    │
│                                                                      │
│  router  outpost   pri 30  Host(dashboard.home)                      │
│                            && PathPrefix(/outpost.goauthentik.io/)   │
│                            → authentik-server:9000   [NO middleware] │
│  router  authentik pri 20  Host(auth.home)                           │
│                            → authentik-server:9000   [NO middleware] │
│  router  dashboard pri 1   Host(dashboard.home)                      │
│                            → forwardauth middleware                  │
│                            → http://10.10.10.11:5173                 │
│                                                                      │
│ authentik-server ─┬─► authentik-redis (local, dedicated)             │
│ authentik-worker ─┘                                                  │
└───────────┬──────────────────────────────────────────────────────────┘
            │ 5432
            ▼
   pdm-db CT 10.10.10.15  ── database authentik_db / role authentik_svc
                          ── database pump_telemetry / role pdm_app  (existing)

frontend CT 10.10.10.11  nginx:80 (published :5173)
   /        → static React build
   /api/    → proxy_pass http://backend:3000/api/   (extra_hosts: backend=10.10.10.12)
                                    │
backend CT 10.10.10.12  express :3000 ◄── Node-RED (10.10.10.13) POST /api/data (unauthenticated, direct)
                                    └──► pdm CT 10.10.10.14:8000
```

### Why the frontend CT's nginx stays in the path (rather than Traefik routing `/api/*` straight to the backend)
The prior single-host design had two Traefik routers (`client` catch-all +
`server` at `PathPrefix(/api)`). Here, one router suffices because nginx
already does that split. Trade-offs:

- **For:** zero changes to the backend CT, zero changes to
  `client/nginx.conf`, one fewer cross-CT route to keep in sync, and the
  dev-time behaviour (browser hits nginx, nginx proxies `/api`) is identical
  to the gated behaviour — fewer "works locally, breaks behind the proxy"
  surprises.
- **Against:** one extra network hop per API call, and Traefik has no
  visibility into API vs. UI traffic for routing/metrics purposes.
- **Rejected alternative:** adding a `PathPrefix(/api)` router on Traefik
  pointing at `10.10.10.12:3000` directly. This would *also* work and would
  bypass nginx, but it duplicates routing logic in two places and means the
  backend CT needs to accept traffic from the auth CT as well as the frontend
  CT — widening the firewall rule this plan is trying to narrow. Not doing
  it.

### Why one hostname for UI + API (carried forward from the prior design)
Authentik's session cookie is scoped per-domain. Serving the SPA and its XHRs
from the single origin `http://dashboard.home` means one login covers both,
with no cross-origin cookie or CORS complexity. This is already how the app
is built (`VITE_API_URL: /api` in `docker-compose.frontend.yml:6`).

### Why Traefik uses the **file provider**, not the Docker provider
The prior design used Docker labels on `client`/`server`, which is impossible
here — those services live on other CTs with no shared Docker network. Two
routers point at compose-local `authentik-server` and one points at a static
remote URL, so:

- All routers, services, and middlewares live in one committed, reviewable
  file: `authentik/traefik/dynamic/dynamic.yml`.
- **The Docker socket is not mounted at all.** This is a strict security
  improvement over the prior design — `/var/run/docker.sock:ro` on an
  internet-adjacent edge proxy is root-equivalent on the host, and the file
  provider makes it unnecessary. `authentik-server` is still reachable as
  `http://authentik-server:9000` via Compose's implicit default network DNS.
- Traefik's dashboard/API is **not** enabled (no `--api.insecure`). It was a
  debugging convenience in the prior design and is a recon surface on a real
  edge node. Debug with `traefik` logs and `curl` instead.

### Why Redis is required (unchanged)
Authentik is a Django app with a Celery worker. Redis backs the task queue
(blueprint reconciliation, outpost sync, scheduled cleanup) and the server's
session/cache layer. Not optional. It is a *dedicated* Redis for Authentik —
nothing else in this stack uses Redis, so there's no sharing question.

### Why Authentik's DB goes on the shared pdm-db instance
Same reasoning as the prior design: one Postgres process, multiple logical
databases, each with its own role. `authentik_svc` cannot see
`pump_telemetry` and `pdm_app` cannot see `authentik_db` — enforced by
Postgres, not convention. `authentik_db` does **not** get the `timescaledb`
extension; only `pump_telemetry` needs it.

### The new failure domain (state it plainly)
Before this change, pdm-db going down broke telemetry but the dashboard's
cached page still loaded. After this change, **pdm-db going down means
nobody can log in** — Authentik cannot authenticate without its database.
The auth CT is now also a single point of failure for all dashboard access.
This is an accepted consequence of both "shared Postgres" and "single
ingress"; it is recorded in the risk register rather than mitigated, because
HA is out of scope at homelab scale.

---

## 3. Decisions already made

| Decision | Choice | Rationale |
|---|---|---|
| Ingress placement | Traefik on the auth CT (`10.10.10.16`) | Single browser-facing entry point; keeps the frontend CT a dumb proxy target. |
| Frontend/API routing | One Traefik router → `10.10.10.11:5173`; nginx splits `/api/` | Reuses existing `client/nginx.conf`; no backend CT changes. |
| Traefik provider | File provider only; **no Docker socket** | Remote upstreams can't use labels anyway; removes a root-equivalent mount from the edge. |
| TLS | **Dropped — plain HTTP only, revised decision** | Original plan used an mkcert local CA; the user chose to cut CA/cert setup and management entirely rather than maintain it. Accepted trade-off: the session cookie has no `Secure` flag and credentials/cookies cross the LAN in cleartext. Same risk class already accepted for Node-RED's unauthenticated ingestion — treated as consistent with this being a trusted LAN, not a design gap unique to Authentik. Revisit if this stack is ever exposed beyond the current LAN. |
| Hostnames | `dashboard.home`, `auth.home` via hosts file / local DNS | (Note: RFC 8375 reserves `home.arpa`, not `.home`; `.home` can leak to upstream resolvers. Recorded as a low risk, not changed.) |
| Authentik DB | Own database + role on shared pdm-db | Matches the system-wide "one Postgres, many databases" strategy. |
| Auth config | Declarative blueprint in git | Matches `pdm/app/thresholds.yaml` precedent; wiping and re-upping reproduces the same provider/application/outpost. |
| Backend auth | None; stays open on `:3000`, firewall-scoped | Node-RED is a machine gateway, not an interactive session. |
| LAN bypass | Proxmox CT firewall, documented as a runbook | This repo doesn't manage Proxmox config as code. |
| `trustForwardHeader` | `false` | Traefik is the outermost hop; nothing upstream to trust. |
| Router priorities | outpost 30 > authentik 20 > dashboard 1, all explicit | Never rely on Traefik's auto-computed priority. |
| Traefik access logs | Persistent, not verification-only | Useful for spotting bypass attempts / debugging auth later. Requires adding log rotation (no rotation exists on this CT yet) — see §5.3. |
| Node-RED host | `10.10.10.13` | Confirmed; used directly in the backend CT's firewall rule (§6), no broadening needed. |
| Management/admin host | `10.10.10.13` | Same host; used for the mandatory SSH+ICMP allow rule on every CT (§6). |
| `AUTHENTIK_TAG` | **`2026.5.6`** (pinned, resolved) | Current latest stable as of writing. `invalidation_flow` is unconditionally required on the provider blueprint at this version (see §5.4) — no more hedging on "if the tag is past 2024.12." |
| Traefik image | **`traefik:v3.7.10`** (pinned, resolved) | Current latest stable as of writing; the earlier `v3.1` reference in this plan was a stale, floating minor-version pin and contradicted this plan's own "nothing floats" rule. |

---

## 4. Critical files

### New files

| File | Purpose |
|---|---|
| `docker-compose.auth.yml` | Auth CT stack: `traefik`, `authentik-redis`, `authentik-server`, `authentik-worker`. Self-contained, matching the one-compose-file-per-CT convention. |
| `.env.auth.example` | Env vars for the auth CT, placeholder values, commented in the style of the existing `.env.example`. |
| `authentik/traefik/traefik.yml` | Traefik **static** config: entrypoints (`:80` only), file provider, log level, persistent access log. |
| `authentik/traefik/dynamic/dynamic.yml` | Traefik **dynamic** config: routers, services, forward-auth middleware. No TLS store/certificates — plain HTTP. |
| `authentik/blueprints/dashboard-proxy-provider.yaml` | Proxy Provider (forward-auth single application) + Application + embedded-outpost binding. |
| `db/init/02-create-authentik-db.sh` | Creates `authentik_svc` + `authentik_db` on the shared instance. Follows the `00-create-role.sh` pattern exactly (`.sh` for env-var interpolation). |
| `docs/runbook/authentik-operations.md` | Manual DB provisioning against the live volume, DNS/hosts entries, Proxmox firewall rules, log rotation, rollback. |
| `docs/plan/2026-08-09-authentik-split-ct.md` | This plan. |

### Modified files

| File | Change |
|---|---|
| `docker-compose.db.yml` | Add `AUTHENTIK_PG_PASSWORD: ${AUTHENTIK_PG_PASSWORD}` to the `pdm-db` service's `environment:` (needed by the new init script on any future fresh volume). |
| `.env.example` | Add the pdm-db CT's own vars (`POSTGRES_SUPERUSER_PASSWORD`, `PDM_APP_PASSWORD` — currently referenced by `docker-compose.db.yml` but documented nowhere) plus `AUTHENTIK_PG_PASSWORD`. Update `CLIENT_ORIGIN` guidance to `http://dashboard.home`. |
| `docs/plan/2026-08-04-timescaledb-migration.md` | Fix `10.10.10.13` → `10.10.10.15`; replace the §0 "Shared instance with Authentik" paragraph's stale container-based assumption with a pointer to this plan. |
| `docs/superpowers/specs/2026-08-06-authentik-integration-design.md` | Add a status banner at the top marking it superseded-for-this-topology by this plan. |
| `node-red/flow.json` | Confirm/repoint the "POST /api/data" node's URL at `http://10.10.10.12:3000/api/data` (currently locally modified; verify it matches this plan's addressing before deploy). |

**Note on `docs/`:** `.gitignore` ignores `docs/`, yet existing plan docs are
tracked. New docs must be added with `git add -f`, exactly as the existing
ones evidently were.

---

## 5. Work items

Grouped into commits that can each be reviewed on their own. Steps are
ordered so each is independently verifiable.

### 5.1 Commit 1 — Provision Authentik's database on pdm-db

**`db/init/02-create-authentik-db.sh`** — mirrors `00-create-role.sh`,
including its header comment explaining why it must be `.sh` (no env
interpolation in `.sql` under `docker-entrypoint-initdb.d`). Content:
`CREATE ROLE authentik_svc LOGIN PASSWORD '$AUTHENTIK_PG_PASSWORD';` then
`CREATE DATABASE authentik_db OWNER authentik_svc;`. Deliberately **no**
`CREATE EXTENSION timescaledb` — Authentik has no time-series tables and the
extension would only widen its blast radius.

A single `.sh` here rather than the `.sh` + `.sql` split used for
`pump_telemetry`: that split exists only because the telemetry DB needs a
superuser-only `CREATE EXTENSION` step between role creation and ownership
transfer. Authentik needs no such step, so splitting would be cargo-culting.

**`docker-compose.db.yml`**: add
`AUTHENTIK_PG_PASSWORD: ${AUTHENTIK_PG_PASSWORD:?AUTHENTIK_PG_PASSWORD must be set}`
to `pdm-db.environment` — the `:?` form, not a bare `${VAR}`. A bare
reference to an unset var interpolates to an empty string rather than
failing, which would make `02-create-authentik-db.sh` silently run
`CREATE ROLE authentik_svc LOGIN PASSWORD '';` — a passwordless role — on a
future from-scratch rebuild, with `set -eu` never catching it (an empty
string is still a defined value). While touching this file, apply the same
`:?` guard to the two existing vars that have the identical latent bug
today: `POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:?...}` and
`PDM_APP_PASSWORD: ${PDM_APP_PASSWORD:?...}` (`docker-compose.db.yml:7-8`).
Pre-existing, unrelated to Authentik, but cheap to fix in the same commit.

**The init script will not run.** `pdm_db_data` is not a fresh volume.
`/docker-entrypoint-initdb.d/` fires exactly once, on first initialization.
The script is committed so that a from-scratch rebuild is correct and
reproducible; for the *live* instance it must be applied by hand. Runbook
(documented in `docs/runbook/authentik-operations.md`, executed on the
**pdm-db CT**):

```
docker compose -f docker-compose.db.yml exec -T pdm-db \
  psql -v ON_ERROR_STOP=1 -U postgres <<'EOSQL'
CREATE ROLE authentik_svc LOGIN PASSWORD 'REPLACE_ME';
CREATE DATABASE authentik_db OWNER authentik_svc;
EOSQL
```

Two cautions to write into the runbook: (1) the password lands in shell
history — prefer `\password authentik_svc` in an interactive `psql` session,
or clear history afterwards; (2) `exec` into the container is preferred over
`psql -h 10.10.10.15` from elsewhere so the superuser password never crosses
the network.

Then verify from the **auth CT**, before writing any compose file:
```
psql "postgres://authentik_svc:PASSWORD@10.10.10.15:5432/authentik_db" -c "SELECT 1;"
```
If this fails, everything downstream fails confusingly. Gate on it.

Also verify isolation:
`psql "postgres://authentik_svc:...@10.10.10.15:5432/pump_telemetry" -c "SELECT 1;"`
should be refused or yield no table access.

- **Risk:** Low. Additive; touches no existing database or role.

### 5.2 (removed) — TLS/mkcert scope cut

An earlier draft of this plan had a "Commit 2" here for generating and
distributing an mkcert local CA. The user decided to drop TLS/CA/certificate
work entirely in favor of plain HTTP (§3) — there is no certificate material,
no CA distribution step, and no `authentik/certs/` directory in this plan.
Commit numbering below intentionally skips from Commit 1 to Commit 3 rather
than renumbering everything, to avoid invalidating the `§5.x` cross-references
used throughout this document.

### 5.3 Commit 3 — `docker-compose.auth.yml` + Traefik config + `.env.auth.example`

**`authentik/traefik/traefik.yml`** (static):
- `entryPoints.web.address: ":80"` — the only entrypoint. No `websecure`,
  no redirection block, no TLS.
- `providers.file.directory: /etc/traefik/dynamic`, `watch: true`.
- `log.level: INFO`; `accessLog` **enabled persistently** — pair with a
  logrotate config on the auth CT (documented in the runbook, not managed by
  this repo) since the CT has no log rotation configured yet and this is now
  a permanent setting rather than verification-only.

**`authentik/traefik/dynamic/dynamic.yml`**:
- No `tls.stores` / `tls.certificates` block — plain HTTP, nothing to
  configure.
- `http.services.frontend.loadBalancer.servers[0].url: http://10.10.10.11:5173`,
  `passHostHeader: true` (**required** — not, as an earlier draft claimed,
  because the outpost derives the forwarded host from it; the outpost reads
  `X-Forwarded-Host` on the forward-auth subrequest, which Traefik computes
  from the *original* request independent of this setting. The real reason:
  nginx on the frontend CT needs the real `Host` to proxy `/api/` correctly
  to Express, and `passHostHeader: true` is what makes Traefik forward it
  rather than substituting the upstream's own host:port).
- `http.services.authentik.loadBalancer.servers[0].url: http://authentik-server:9000`.
- `http.middlewares.authentik-auth.forwardAuth`:
  - `address: http://authentik-server:9000/outpost.goauthentik.io/auth/traefik`
  - `trustForwardHeader: false`
  - `authResponseHeaders: [X-authentik-username, X-authentik-groups, X-authentik-email, X-authentik-name, X-authentik-uid]`
- Routers, all on `entryPoints: [websecure]`, all `tls: {}`:
  - `outpost`: `Host(\`dashboard.home\`) && PathPrefix(\`/outpost.goauthentik.io/\`)`,
    priority **30**, service `authentik`, **no middleware** (attaching it
    creates a redirect loop).
  - `authentik`: `Host(\`auth.home\`)`, priority **20**, service `authentik`,
    **no middleware**.
  - `dashboard`: `Host(\`dashboard.home\`)`, priority **1**, service
    `frontend`, middleware `authentik-auth`.

All three priorities explicit. Traefik's auto-priority is rule-length-based
and would probably get this right, but "probably" is not a security control.

**`docker-compose.auth.yml`**:
- `traefik`: `image: traefik:v3.7.10` (pinned; nothing in this repo floats
  `:latest` or a minor version). Port `80:80` only — no `443`, no TLS.
  Volumes: `./authentik/traefik/traefik.yml:/etc/traefik/traefik.yml:ro`,
  `./authentik/traefik/dynamic:/etc/traefik/dynamic:ro`, and
  `./authentik/traefik/logs:/var/log/traefik` (writable, for the persistent
  access log — an earlier draft enabled `accessLog` with no destination
  mount, so the log would live in the container's ephemeral layer and
  vanish on recreation; `authentik/traefik/logs/` needs a `.gitignore`
  entry for its contents, though `.gitignore:72` already ignores `*.log`
  globally so only the directory itself needs a `.gitkeep`).
  `restart: unless-stopped`. **No `/var/run/docker.sock`.**
- `authentik-redis`: `redis:7-alpine`, `--save 60 1 --loglevel warning`,
  named volume, `redis-cli ping` healthcheck.
- `authentik-server`: `ghcr.io/goauthentik/server:${AUTHENTIK_TAG}`,
  `command: server`, `depends_on: authentik-redis: {condition: service_healthy}`.
  Env: `AUTHENTIK_SECRET_KEY`, `AUTHENTIK_POSTGRESQL__HOST` (from
  `AUTHENTIK_PG_HOST`), `__PORT: 5432`, `__USER`, `__PASSWORD`, `__NAME`,
  `AUTHENTIK_REDIS__HOST: authentik-redis`,
  `AUTHENTIK_BOOTSTRAP_EMAIL/PASSWORD/TOKEN`,
  `AUTHENTIK_ERROR_REPORTING__ENABLED: "false"`,
  `AUTHENTIK_DISABLE_UPDATE_CHECK: "true"`, `AUTHENTIK_COOKIE_DOMAIN` **left
  unset** (see below). Volumes: `authentik_media:/media`,
  `authentik_certs:/certs`, `./authentik/blueprints:/blueprints/custom:ro`.
  **No `ports:`** — Traefik reaches it over the compose network; publishing
  9000 would be a bypass of the very thing being built. No healthcheck
  block — the container has no `curl`; use `wget -qO- http://localhost:9000/-/health/ready/`
  or the image's own `ak healthcheck` if a healthcheck is added.
- `authentik-worker`: same image/tag, `command: worker`,
  `depends_on: authentik-redis: {condition: service_healthy}`, same
  DB/Redis/secret env **including the bootstrap vars** — corrected from an
  earlier draft of this plan that listed bootstrap vars only under
  `authentik-server`. The **worker**, not the server process, is what
  performs first-boot bootstrap; without these vars on the worker too,
  `akadmin` is never created with the configured password. Also
  `authentik_media` + blueprints mounts. **No Docker socket** — only needed
  for managing outposts as separate containers, which the embedded-outpost
  approach avoids.
- Volumes: `authentik_redis_data`, `authentik_media`, `authentik_certs`,
  `./authentik/traefik/logs:/var/log/traefik` on the `traefik` service only
  (see the access-log note below). No `pg_data` — that's the pdm-db CT's.
- **Redis note for `AUTHENTIK_TAG=2026.5.6`:** recent Authentik releases can
  run without Redis (Postgres-backed task queue), but this plan keeps the
  dedicated `authentik-redis` service anyway — it's still fully supported,
  the config shape below is unchanged from the officially documented
  `AUTHENTIK_REDIS__*` keys, and removing it would be an unforced
  simplification outside this plan's scope. Revisit only as a deliberate,
  separate change if desired later.

**`AUTHENTIK_POSTGRESQL__HOST` sourced from `AUTHENTIK_PG_HOST=10.10.10.15`
in `.env.auth`**, not `extra_hosts`. The other compose files use
`extra_hosts` (`backend:10.10.10.12`, `pdm:10.10.10.14`) so the IP lives in
one place while code references a name. Here the address appears in exactly
one place already (both `authentik-server` and `authentik-worker` read the
same env var), so an alias buys nothing and adds indirection — the CT
address stays configuration, not source. Traefik's file config, however,
**cannot** interpolate env vars, so `10.10.10.11:5173` is a literal in
`dynamic.yml` with a prominent comment. That's a real, if small,
inconsistency with the rest of the repo; the alternative (templating the
dynamic file at boot) is more machinery than one IP justifies.

**`AUTHENTIK_COOKIE_DOMAIN` stays unset.** Setting it to `home` would scope
the session cookie across every `.home` host, which is exactly what you
*don't* want when the point of this exercise is a perimeter. Unset means the
outpost sets a host-only cookie on `dashboard.home`. Forward-auth
single-application mode does not need a shared cookie domain.

**`.env.auth.example`** — commented in the style of `.env.example`:
```
AUTH_DASHBOARD_HOST=dashboard.home
AUTH_AUTHENTIK_HOST=auth.home
AUTHENTIK_PG_HOST=10.10.10.15
AUTHENTIK_PG_PORT=5432
AUTHENTIK_PG_USER=authentik_svc
AUTHENTIK_PG_PASSWORD=change-me
AUTHENTIK_PG_DB=authentik_db
AUTHENTIK_TAG=2026.5.6
AUTHENTIK_SECRET_KEY=change-me
AUTHENTIK_BOOTSTRAP_EMAIL=admin@dashboard.home
AUTHENTIK_BOOTSTRAP_PASSWORD=change-me
AUTHENTIK_BOOTSTRAP_TOKEN=change-me
```
Comments must state: generate the secret key with `openssl rand -base64 36`;
**pin an explicit `AUTHENTIK_TAG`, never `latest`** (Authentik migrations are
tag-coupled and an unplanned pull can wedge the database); bootstrap vars are
read only on first boot against an empty `authentik_db` and changing them
later has no effect. `AUTH_DASHBOARD_HOST`/`AUTH_AUTHENTIK_HOST` are consumed
by the blueprint's env substitution and documentation only — Traefik's file
provider does not read them, so if you change a hostname you must edit
`dynamic.yml` too. Say that in the comment; it is the kind of half-wired
variable that causes a confusing hour.

Copy to `.env` (gitignored) on the auth CT before first run.

- **Risk:** Medium. Most of the moving parts are here. Verify
  incrementally: bring up `authentik-redis` + `authentik-server` +
  `authentik-worker` **first** and confirm migrations complete against
  pdm-db before adding Traefik to the picture.

### 5.4 Commit 4 — Blueprint

**`authentik/blueprints/dashboard-proxy-provider.yaml`**, auto-applied by
`authentik-worker` from `/blueprints/custom`. Three entries:

1. `authentik_providers_proxy.proxyprovider`, identified by name, with
   `mode: forward_single`, `external_host: http://dashboard.home`, and
   `authorization_flow` resolved via
   `!Find [authentik_flows.flow, [slug, default-provider-authorization-implicit-consent]]`.
2. `authentik_core.application` with `slug: dashboard`, bound to the
   provider via `!KeyOf`.
3. An update to the built-in outpost, identified by
   `name: "authentik Embedded Outpost"`, adding the provider to its
   `providers` list.

**Three details that are easy to miss and will cost hours if missed:**

- **The embedded outpost's `config.authentik_host` must NOT be
  `http://auth.home`.** An earlier draft of this plan got this backwards.
  `authentik_host` is the **server-side** URL the outpost container uses to
  talk to Authentik core — pointing it at `http://auth.home` makes the
  container try to resolve a hostname it has no DNS for (no `extra_hosts`
  entry, no shared Docker network), which is a hard failure, not a cosmetic
  one. The correct split:
  ```
  authentik_host: http://authentik-server:9000/         # server-side, internal
  authentik_host_browser: http://auth.home/             # what the browser is told
  ```
  (`authentik_host_insecure` is a TLS-verification flag for `authentik_host`
  and is irrelevant now that everything is plain HTTP — omit it.)
  Without `authentik_host_browser` set correctly, the outpost builds its
  login redirect from the incoming request's host — i.e. it sends the
  browser to `http://dashboard.home/application/o/authorize/...`, which the
  `dashboard` router forwards to nginx, which returns the SPA's
  `index.html` fallback (a blank page, not an error). Note in a comment that
  writing `config` here **replaces** the outpost's config object wholesale,
  so any default you care about must be restated.
- **`invalidation_flow` is required** at the pinned `AUTHENTIK_TAG=2026.5.6`
  (see §3) — no hedging needed. Include it:
  `!Find [authentik_flows.flow, [slug, default-provider-invalidation-flow]]`.
- **`AUTH_DASHBOARD_HOST`/`AUTH_AUTHENTIK_HOST` are documentation-only, full
  stop** — corrected from an earlier draft that also (incorrectly) claimed
  the blueprint consumed them via env substitution. Authentik blueprints
  only read an env var if the blueprint YAML explicitly uses an `!Env` tag,
  and this blueprint doesn't use one — the hostnames are hardcoded literals
  in both this file (`external_host: http://dashboard.home`,
  `authentik_host_browser` above) and in `dynamic.yml` (§5.3, which also
  can't interpolate env vars). If you ever change a hostname, you must edit
  both this file and `dynamic.yml` by hand; the two `.env.auth` vars exist
  only as a single documented place recording what the stack was configured
  for, not as a source of truth anything reads.

**First login, once the blueprint has applied:** go to `http://auth.home/`
(the default login flow), not `/if/flow/initial-setup/` — that flow is only
reachable when `AUTHENTIK_BOOTSTRAP_*` vars were **not** set. This plan sets
them (§5.3), so `akadmin` already exists with `AUTHENTIK_BOOTSTRAP_PASSWORD`
and the initial-setup flow is intentionally unreachable. `initial-setup` is
the fallback path only for a deployment that skipped bootstrap vars entirely.

Fallback if the blueprint misbehaves: configure it by hand in the UI
(Providers → Proxy Provider, forward-auth single application → Applications
→ bind → Outposts → edit embedded → add application), then export via the
blueprint UI and reconcile with the committed file. Do not leave the system
in a hand-configured state — the whole point is reproducibility from git.

- **Risk:** Medium. Version-sensitive schema. Fails loudly in the worker
  log, which is the good kind of failure.

### 5.5 Commit 5 — Documentation and env touch-ups

- `docs/runbook/authentik-operations.md`: DNS/hosts entries, manual DB
  provisioning (§5.1), the firewall runbook (§6), log rotation for Traefik's
  persistent access log, rollback, and "how to log in the first time"
  (`akadmin` + `AUTHENTIK_BOOTSTRAP_PASSWORD` at `http://auth.home/` — not
  the `initial-setup` flow; see §5.4).
- `docs/plan/2026-08-04-timescaledb-migration.md`: fix `10.10.10.13` →
  `10.10.10.15` in **both** places it appears — line 17 (the CT description)
  and line 23 (the `DATABASE_URL` example) — an earlier draft of this plan
  undercounted this as a single fix; replace the stale shared-instance
  paragraph (lines 29–39) with a pointer here.
- `README.md`: beyond the `CLIENT_ORIGIN` note below, the README is
  self-contradictory today — line 4 says "Express + SQLite," line 41 says
  "PostgreSQL 16 + TimescaleDB," the architecture diagram (lines 57–74)
  still draws `better-sqlite3`/`data.db`, and there's an entire obsolete
  "Why SQLite" section (lines 321–372) defending a database this app no
  longer uses. This predates and is independent of the Authentik work, but
  since docs are being touched anyway: update line 4, redraw the
  architecture diagram to show Postgres, and either delete "Why SQLite" or
  retitle/reframe it as a historical note about the pre-migration design.
- `docs/plan/2026-08-05-pdm-implementation.md`: also predates this plan and
  is unrelated to Authentik, but its lines 10–21 assert "the backend runs as
  it does today: Express + `better-sqlite3` ... No Postgres, no CT changes"
  as a current-state baseline — false since the TimescaleDB migration
  already merged (commit `3648784`). Flag for a status update in whichever
  commit touches the README, so the repo doesn't end up with two
  contradictory "current state" descriptions.
- `docs/superpowers/specs/2026-08-06-authentik-integration-design.md`:
  superseded banner.
- `.env.example`: add `POSTGRES_SUPERUSER_PASSWORD`, `PDM_APP_PASSWORD`,
  `AUTHENTIK_PG_PASSWORD` (the first two are consumed by
  `docker-compose.db.yml` today and documented nowhere — a genuine
  pre-existing gap); update the `CLIENT_ORIGIN` comment to reflect that the
  browser origin is now `http://dashboard.home`.

**On `CLIENT_ORIGIN`:** with the SPA and API on the same origin, browsers
omit `Origin` on same-origin GETs and `cors()` waves those through, so
nothing breaks if it's left stale — but same-origin POSTs *do* carry
`Origin`, and the value should be truthful regardless. Set it to
`http://dashboard.home` on the backend CT and restart. This is the one
operational change to the backend CT, and it is env-only —
`docker-compose.backend.yml` itself is untouched.

Remember `git add -f` for anything under `docs/`.

- **Risk:** Low.

---

## 6. Firewall runbook (operator instructions, not repo code)

Documented in `docs/runbook/authentik-operations.md`. Proxmox CT firewall,
configured per-CT in the web UI (`CT → Firewall`) or
`/etc/pve/firewall/<vmid>.fw`. The firewall must be enabled **both** at the
CT's Firewall → Options level **and** on the specific network device
(`net0`) — this two-switch design is the most common reason "the rules did
nothing".

**Read this before touching anything:** the Proxmox firewall is stateful, so
return traffic for outbound connections is allowed automatically; you only
ever write inbound rules. But setting the input policy to `DROP` without
first adding an SSH rule **will lock you out**. Add the management rule
first, verify SSH still works from a second terminal, and keep
`pct enter <vmid>` from the Proxmox host open as the recovery path. Also add
ICMP echo from the management host — silently unpingable CTs make every
future diagnosis harder.

| CT | Input policy | ACCEPT rules |
|---|---|---|
| frontend `10.10.10.11` | DROP | tcp/5173 from `10.10.10.16`; tcp/22 + icmp from `10.10.10.13` |
| backend `10.10.10.12` | DROP | tcp/3000 from `10.10.10.11`; tcp/3000 from `10.10.10.13` (Node-RED); tcp/22 + icmp from `10.10.10.13` |
| pdm-db `10.10.10.15` | DROP | tcp/5432 from `10.10.10.12`; tcp/5432 from `10.10.10.16` (**new**); tcp/22 + icmp from `10.10.10.13` |
| auth `10.10.10.16` | DROP | tcp/80 from the LAN (this is the new front door — HTTP only, no 443); tcp/22 + icmp from `10.10.10.13` |

Adjacent but **not** in scope, noted so it isn't forgotten: pdm CT
`10.10.10.14:8000` is equally open and should eventually be restricted to
`10.10.10.12`. Doing it here would mean verifying a service this plan
otherwise doesn't touch.

Apply in this order, verifying after each: **pdm-db first** (least likely to
break anything visible), **then backend**, **then frontend**, **then auth**.
Applying the frontend rule before Traefik works would take the dashboard
offline with no way in.

`docker-compose.frontend.yml:8` publishes `5173:80` on all interfaces and
`docker-compose.backend.yml:5` publishes `3000:3000` on all interfaces. The
prior single-host design solved the equivalent bypass by binding to
`127.0.0.1`. That fix **does not work here** — the frontend CT genuinely
must accept connections from the auth CT, and the backend from the frontend
CT. The CT firewall is the correct layer. Do not "helpfully" add loopback
binding to those compose files; it would break the stack.

**Known limitation, and it is a real one:** Docker publishes ports by
inserting its own `DOCKER` chain rules into `nftables`/`iptables`, which on
some configurations are evaluated ahead of the host firewall's `FORWARD`
filtering. Because these are LXC containers with the Proxmox firewall
applied at the CT's virtual NIC (not at a Docker bridge on the host), the
ordering problem generally does not apply — but **verify empirically**
(§7.7), from an actual third machine, rather than trusting the rule table.
If a bypass is found, the fallback is to add explicit
`iptables -I DOCKER-USER` rules inside each CT and document them in the same
runbook.

---

## 7. Verification

Run in order; each step gates the next. Do **not** apply firewall rules
until step 5 passes.

1. **Database reachability.** From the auth CT:
   `psql "postgres://authentik_svc:PASSWORD@10.10.10.15:5432/authentik_db" -c "SELECT 1;"`
   returns `1`. From the pdm-db CT, `\l` lists `authentik_db` (owner
   `authentik_svc`) *and* `pump_telemetry` (owner `pdm_app`). `authentik_svc`
   cannot read `pump_telemetry`.
2. **Authentik core, before Traefik.**
   `docker compose -f docker-compose.auth.yml up -d authentik-redis authentik-server authentik-worker`.
   `docker compose logs authentik-server` shows migrations completing with
   no errors.
   `docker compose exec authentik-server wget -qO- http://localhost:9000/-/health/ready/`
   → non-empty response, exit code `0` (corrected from an earlier draft that
   used `curl` — the `ghcr.io/goauthentik/server` image doesn't ship it; a
   healthy system would fail this check as written). Worker log shows the
   custom blueprint applied (search for the blueprint's name; a schema error
   appears here, not later).
3. **Routing.** Bring up `traefik`. From a machine with hosts entries
   pointing both names at `10.10.10.16`:
   - `curl -I http://auth.home/` → a `2xx`/`3xx` (Authentik's root path
     normally redirects to a flow URL, so a `302` is success, not failure —
     not a literal `200`).
4. **Forward-auth actually gates.**
   - `curl -sI http://dashboard.home/` → `302` toward
     `/outpost.goauthentik.io/start` (not `200`, not `500`). A `200` here
     means the middleware isn't attached — stop and fix.
   - `curl -sI http://dashboard.home/api/health` → also `302`. **This is
     the key assertion of the whole design**: one middleware on one router
     gates both the SPA and every API call, because nginx sits behind the
     gate rather than beside it.
   - `curl -sI http://dashboard.home/outpost.goauthentik.io/ping` →
     **not** a `302` to login. If it redirects, the outpost router's
     priority is wrong and you have a redirect loop.
5. **Browser end-to-end.** Open `http://dashboard.home` in a clean profile
   → redirected to `auth.home` login → sign in as `akadmin` → redirected
   back → dashboard renders **with live data**. Both halves matter: the
   shell rendering proves the UI route works, live charts prove the `/api`
   XHRs carried the same session cookie. Check DevTools: no failed XHRs,
   session cookie has `HttpOnly` (no `Secure` flag — plain HTTP, per §3).
6. **Ingestion is untouched.** From the Node-RED host (`10.10.10.13`):
   `curl -i -X POST http://10.10.10.12:3000/api/data -H 'Content-Type: application/json' -d '{...}'`
   → `2xx`, no redirect. Then leave the simulator running until **at least
   three windows have closed** and confirm `raw_telemetry` and
   `processed_telemetry` are still growing — a `2xx` on one request doesn't
   prove the pipeline is healthy.
7. **Apply firewall rules** (§6 order), then prove they bind, from a
   **third machine on the LAN that is neither the auth CT nor a permitted
   source**:
   - `curl -m 5 http://10.10.10.11:5173/` → connection timeout/refused.
     **This is the LAN-bypass fix; if it returns the dashboard, the entire
     perimeter is theatre.**
   - `curl -m 5 http://10.10.10.12:3000/api/health` → blocked.
   - `psql -h 10.10.10.15 -U authentik_svc ...` → blocked.
   - `curl -I http://dashboard.home/` from that same machine → still `302`
     to login. Proves the intended path survived.
8. **Regression re-run.** Repeat steps 5 and 6 *after* the firewall is live.
   Ordering matters: a rule that breaks nginx→backend or authentik→pdm-db
   shows up here and nowhere else.
9. **Reproducibility.** A plain `docker compose -f docker-compose.auth.yml down`
   then `up -d` does **not** prove this by itself — corrected from an
   earlier draft: `authentik_db` lives on the remote pdm-db CT and survives
   a local `down`/`up` untouched, so a hand-made UI change would still
   "pass" this test. To actually prove the blueprint (not a human) owns the
   configuration, drop and recreate the database first: the §9 rollback
   SQL (`DROP DATABASE authentik_db; DROP ROLE authentik_svc;`), then redo
   §5.1's provisioning step, then `up -d` — the provider/application/outpost
   must come back identically with zero manual UI steps.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Firewall rule applied before Traefik works → dashboard unreachable with no way in | **High** | Strict ordering (§7: firewall is step 7, after end-to-end passes); keep `pct enter` console open; add mgmt SSH ACCEPT before setting policy DROP |
| Docker's published ports bypassing the CT firewall | **High — the entire perimeter** | Empirically verify from a third machine (§7.7), not from the rule table; `DOCKER-USER` chain rules as documented fallback |
| Outpost `authentik_host` unset → login redirect lands on the SPA, blank page, no error | High — very confusing | Set `config.authentik_host: http://auth.home` explicitly in the blueprint (§5.4) |
| Blueprint schema mismatch with the resolved tag (`invalidation_flow`) | Medium — fails loudly in the worker log | Pin `AUTHENTIK_TAG` at implementation time; check release notes; §7.2 gates on the worker log before anything else is built on top |
| Router priority wrong → outpost callback swallowed by the dashboard catch-all → redirect loop | Medium | All three priorities explicit (30/20/1); §7.4 asserts `/outpost.goauthentik.io/ping` is not redirected |
| Session cookie and credentials cross the LAN in cleartext (no TLS, per §3) | Medium — accepted | Deliberate scope cut; same risk class as Node-RED's existing unauthenticated ingestion. Revisit if this stack is ever exposed beyond the current trusted LAN |
| pdm-db down now means nobody can log in (new coupling) | Medium — accepted | Documented in §2; single-instance Postgres is an existing, deliberate system-wide choice |
| Auth CT is a new single point of failure for all dashboard access | Medium — accepted | Rollback path (§9) restores direct access in minutes |
| Traefik's persistent access log grows unbounded (CT has no rotation configured) | Medium | Runbook adds logrotate (or a size/retention cap) as part of standing up the auth CT (§5.3) |
| Session expiry mid-session → SPA XHR gets a `302` to a cross-origin login it can't follow | Low–Medium — looks like a random data-loading failure | Documented as known behaviour; a `fetch` wrapper that reloads the page on an opaque/non-JSON response is a small, separate follow-up |
| pdm-db superuser password in shell history from the manual provisioning step | Low | Runbook prefers interactive `\password`; note history clearing |
| `.home` is not a reserved TLD (RFC 8375 reserves `home.arpa`); queries may leak to upstream resolvers | Low | Accepted per decision in §3; noted so a future migration to `home.arpa` is a conscious choice |
| Secrets committed (`AUTHENTIK_SECRET_KEY`, DB password) | High if it happens | `.env` already gitignored; only `.example` files committed |
| Adding a numbered `db/init/` script creates a false impression it ran | Medium | Header comment in `02-create-authentik-db.sh` states plainly that the live volume is not fresh; runbook carries the manual procedure |

---

## 9. Rollback

Available at every stage, in increasing order of intervention:

1. **Remove the firewall restrictions** (set input policy back to ACCEPT, or
   disable the CT firewall) → direct LAN access to `10.10.10.11:5173` is
   restored immediately. Auth is bypassed but the dashboard works.
2. **`docker compose -f docker-compose.auth.yml down` on the auth CT** → the
   gate disappears entirely. Since nothing on the frontend or backend CTs
   was modified, the pre-auth stack is exactly what it was. Users go back to
   `http://10.10.10.11:5173`.
3. **Full removal:** additionally `DROP DATABASE authentik_db;
   DROP ROLE authentik_svc;` on pdm-db and revert `CLIENT_ORIGIN`.
   `pump_telemetry` is untouched throughout.

The reason rollback is this cheap is the deliberate constraint that no
existing CT's compose file changes. Preserve that property in
implementation — if you find yourself editing `docker-compose.backend.yml`
or `client/nginx.conf`, stop and reconsider the design.

---

## 10. Definition of done

- [ ] `authentik_db` / `authentik_svc` exist on `10.10.10.15`; `authentik_svc`
      has no access to `pump_telemetry`
- [ ] `db/init/02-create-authentik-db.sh` committed, with the "will not run
      on the live volume" caveat and manual procedure documented
- [ ] `docker-compose.auth.yml` brings up Traefik + Redis + Authentik server
      + worker; migrations clean; no Docker socket mounted anywhere
- [ ] `http://auth.home` and `http://dashboard.home` load over plain HTTP
      (no TLS, per §3)
- [ ] Blueprint applied automatically on a clean `down`/`up`; no manual UI
      configuration anywhere
- [ ] Unauthenticated `GET http://dashboard.home/` and
      `GET http://dashboard.home/api/health` both `302` to login
- [ ] Browser login renders the dashboard with live data and working `/api`
      XHRs
- [ ] Node-RED's direct `POST` to `10.10.10.12:3000/api/data` still succeeds
      unauthenticated, with ≥3 windows closing correctly **after** the
      firewall is live
- [ ] From a non-permitted LAN host: `10.10.10.11:5173`, `10.10.10.12:3000`,
      and `10.10.10.15:5432` are all unreachable, while `http://dashboard.home`
      still works
- [ ] Traefik's access log has a rotation/retention policy on the auth CT
- [ ] `docs/runbook/authentik-operations.md` covers DNS/hosts, manual DB
      provisioning, firewall rules, log rotation, and rollback
- [ ] `docs/plan/2026-08-04-timescaledb-migration.md` address corrected to
      `10.10.10.15`; the 2026-08-06 spec marked superseded for this topology
- [ ] `AUTHENTIK_TAG` pinned to a specific, current release (never `latest`)
