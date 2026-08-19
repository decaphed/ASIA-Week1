# Secret Rotation Runbook

Every secret below is generated once, per `.env.example`'s `openssl rand`
instructions, with no prior documented rotation procedure. If any one of
these leaks (misdirected log, compromised dev machine, backup exposure),
this is how to rotate it without rebuilding the stack from scratch.

General shape for most of these: update `.env`, then
`docker compose up -d --force-recreate <service>` for whichever
service(s) read that variable. `AUTHENTIK_SECRET_KEY` is the one exception
— see its own section below.

## `INTERNAL_PROXY_SECRET`

Shared between `client` (nginx stamps it on every proxied request) and
`backend` (only trusts `X-authentik-*` identity headers when this secret
is present and correct — see `server/middleware/authentikIdentity.js`).
Both sides must change together or `backend` starts rejecting every
request from `client` as unauthenticated.

```bash
# generate a new value
openssl rand -base64 32
# put it in .env as INTERNAL_PROXY_SECRET=<new value>
docker compose up -d --force-recreate client backend
```

No downtime window trick needed — `client` and `backend` are recreated
together, so there's no interval where the old and new client are
sending mismatched secrets to a still-running backend with the old one
(or vice versa).

## `POSTGRES_SUPERUSER_PASSWORD`

```bash
docker compose exec -T postgres psql -U postgres -c \
  "ALTER ROLE postgres PASSWORD '<new password>';"
# then update .env and recreate so the container's own env var matches
# what's now in the database (avoids drift if postgres is ever restarted
# from a state where the entrypoint re-reads POSTGRES_PASSWORD)
docker compose up -d --force-recreate postgres
```

## `PDM_APP_PASSWORD`

Used by both `pdm_app`'s own login and `backend`'s `DATABASE_URL` (built
from this value directly in `docker-compose.yml` — there is no separate
`DATABASE_URL` variable).

```bash
docker compose exec -T postgres psql -U postgres -c \
  "ALTER ROLE pdm_app PASSWORD '<new password>';"
# update .env, then recreate backend so its DATABASE_URL uses the new value
docker compose up -d --force-recreate backend
```

## `AUTHENTIK_PG_PASSWORD`

Used by `authentik_svc`, and read by both `authentik-server` and
`authentik-worker`.

```bash
docker compose exec -T postgres psql -U postgres -c \
  "ALTER ROLE authentik_svc PASSWORD '<new password>';"
# update .env, then recreate both
docker compose up -d --force-recreate authentik-server authentik-worker
```

## `PDM_CORPUS_READONLY_PASSWORD`

Used by `pdm_corpus_readonly`, read by the `pdm` service (its
`PDM_CORPUS_DB_URL` is built from this value).

```bash
docker compose exec -T postgres psql -U postgres -c \
  "ALTER ROLE pdm_corpus_readonly PASSWORD '<new password>';"
# update .env, then recreate
docker compose up -d --force-recreate pdm
```

## `AUTHENTIK_SECRET_KEY` — not a drop-in swap

Authentik uses this key to encrypt data at rest (session cookies, stored
OAuth/OIDC client secrets and tokens, some flow state). Rotating it is
**not** the same shape as the passwords above — swapping the value and
recreating the containers invalidates existing encrypted data rather than
re-authenticating with a new credential, which can lock out active
sessions and break already-issued tokens until re-established. Before
rotating this one:

1. Read Authentik's own key-rotation guidance for the pinned version in
   `AUTHENTIK_TAG` (`docs/runbook/authentik-operations.md` has the
   version-pinning rationale) — this file intentionally does not restate
   third-party rotation steps that can change between Authentik releases.
2. Expect to re-establish outpost/provider trust after rotation — the
   embedded outpost's connection to `authentik-server`
   (`authentik/blueprints/dashboard-proxy-provider.yaml`) may need to be
   re-applied.
3. Treat this as a maintenance-window operation, not a same-shape
   `--force-recreate` swap like the passwords above — users mid-session
   should be expected to need to log in again.

## Verifying a rotation worked

After any rotation, confirm the affected service(s) report healthy
(`docker compose ps`) and re-run the same end-to-end check used to verify
item 2 of `docs/plan/2026-08-19-cyber-improvements.md`:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" --resolve dashboard.home:443:127.0.0.1 https://dashboard.home/
```

Expect `302` (redirect to the Authentik login flow), same as before the
rotation.
