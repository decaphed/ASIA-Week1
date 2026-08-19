# Cyber-improvements

Follow-up security pass. Scope is limited to gaps confirmed absent by reading
the current codebase/config — not a general checklist. This stack already
has TLS (mkcert), HSTS, CSP, forward-auth via Authentik, group-based
authorization (`requireGroup`/`requireTrustedProxy`), parameterized SQL
everywhere, non-root containers, `cap_drop: ALL` on most services, Traefik
rate limiting, multer upload validation with UUID temp filenames, and
formula-injection-safe CSV export — none of that is repeated here.

Everything below traces to a specific file/line or an explicit "left for a
future pass" note in `docs/plan/2026-08-11-hardening.md`, re-verified as
still open today.

## 1. Proxmox host firewall — written, never applied

`proxmox/firewall/app-ct.fw` is referenced by
`docs/runbook/proxmox-firewall.md` but does not exist anywhere in this repo
checkout, and the runbook is explicit that it must be hand-applied on the
Proxmox host (no CT-only session can do it). Right now the CT has zero
host-level packet filtering — every control in front of it is
application-layer (Docker networks, Traefik). A compromise of any exposed
service currently has no host firewall to contend with at all.

**Action:** write `proxmox/firewall/app-ct.fw` per the runbook, and apply it
from a session with actual Proxmox host access, following the runbook's
SSH-rule-first / keep-a-second-console safety procedure.

## 2. `data` Docker network lost its egress isolation today

`docker-compose.yml`'s `data` network had `internal: true` removed on
2026-08-19 to fix a Docker `DOCKER-INTERNAL` chain bug that was blocking
inter-container traffic entirely (breaking Traefik→authentik-server
forward-auth). The inline comment notes no service on `data` currently
needs internet egress — but removing the flag means `postgres`,
`authentik-redis`, `authentik-server`, `authentik-worker`, and `pdm` can now
all reach the internet, where before they couldn't. A compromised container
on this network (e.g. via a future dependency CVE) previously had no
outbound path for exfiltration or C2; now it does.

**Action:** restore egress restriction without reintroducing the routing
break. **Prerequisite, not optional:** confirm the underlying
`DOCKER-INTERNAL` iptables bug is actually fixed (Docker/kernel version bump
verified, or the specific chain rule identified) *before* re-adding
`internal: true` — doing so without that verification just reintroduces
today's outage. Scope the fix to that root cause (or an explicit allow rule
for the Traefik↔authentik-server path) rather than leaving isolation
dropped stack-wide, or add host-level egress filtering (ties into item 1)
as a compensating control in the meantime.

Before trusting the fix, verify in isolation (`internal` can't be toggled on
a running network — requires `docker compose down` then `up` to take
effect):

1. **`edge`↔`data` still works** — the exact path that broke last time.
   Hit `dashboard.home` and confirm login succeeds end-to-end (Traefik →
   authentik-server forward-auth).
2. **`data` actually has no egress** — e.g.
   `docker compose exec postgres wget -qO- --timeout=3 https://1.1.1.1`
   should now fail/timeout, where it wouldn't with the flag removed.

If both hold, flip the flag back and update the inline comment in
`docker-compose.yml` to record what specifically fixed the iptables issue
(Docker version, config change, or otherwise) — the missing "why" is what
let the original bug go unnoticed, and the next person touching this file
needs that context to avoid re-triggering it.

## 3. Postgres: no `REVOKE CONNECT FROM PUBLIC`

Confirmed absent in `db/init/00-create-role.sh`, `01-init-pump-telemetry.sql`,
`02-create-authentik-db.sh`, and `03-create-pdm-corpus-readonly-role.sh` —
and explicitly called out as "left for a future pass" in
`docs/plan/2026-08-11-hardening.md`'s scope section. Postgres grants
`CONNECT` on every database to the `PUBLIC` pseudo-role by default, so
`pdm_corpus_readonly`, `pdm_app`, and `authentik_svc` can each currently
open a connection to *any* database on the instance, not just the one they
own — `pdm_corpus_readonly` (meant to be scoped to `training_corpus` only)
can connect straight to `authentik_db`.

**Action:** add `REVOKE CONNECT ON DATABASE <db> FROM PUBLIC;` for
`pump_telemetry` and `authentik_db` in a new init script (fresh volumes) and
document the equivalent one-off `psql` commands for the already-initialized
instance, matching the note already left in
`03-create-pdm-corpus-readonly-role.sh` for retroactive application. Also
revoke `PUBLIC` CONNECT on the default `postgres` database while at it —
low-value target, but no role needs it and it's a one-line addition to the
same script.

## 4. Inconsistent container capability dropping

`postgres`, `pdm`, `backend`, `client`, and `node-red` all set
`cap_drop: [ALL]` in `docker-compose.yml`. `authentik-redis`,
`authentik-server`, `authentik-worker`, and `traefik` do not — they only set
`security_opt: [no-new-privileges:true]`. No comment in the file explains
this as deliberate (unlike `postgres`'s documented `cap_add` exception for
its entrypoint's chown-then-drop-root behavior).

**Action:** for each of the four services, test `cap_drop: [ALL]` against a
fresh-volume boot (same verification pattern `postgres`'s comment
describes) and add back only the specific capabilities that turn out to be
required, rather than leaving the full default set granted by omission.

## 5. No automated dependency vulnerability scanning

No `.github/workflows`, no Dependabot config, no Renovate config anywhere in
the repo. `server/`, `client/`, and `pdm/` each pin exact dependency
versions (good for reproducibility) but nothing currently flags when one of
those pinned versions gets a disclosed CVE — that only happens if someone
manually runs `npm audit` / `pip-audit`.

**Action:** add a scheduled dependency-audit workflow (GitHub Actions
`schedule` trigger, or equivalent for wherever this repo's CI actually
runs) that runs `npm audit --omit=dev` in `server/` and `client/` and
`pip-audit -r requirements.txt` in `pdm/`, and fails/alerts on new
high-severity findings. A GitHub-hosted Dependabot config is the lower-effort
alternative if the repo is on GitHub.

## 6. No secret rotation process

`INTERNAL_PROXY_SECRET`, `POSTGRES_SUPERUSER_PASSWORD`, `PDM_APP_PASSWORD`,
`AUTHENTIK_PG_PASSWORD`, `PDM_CORPUS_READONLY_PASSWORD`, and
`AUTHENTIK_SECRET_KEY` are all generated once (per `.env.example`'s
`openssl rand` instructions) with no documented rotation cadence or
procedure anywhere in `docs/runbook/`. If any one of these ever leaks (e.g.
via a misdirected log, a compromised dev machine, or a backup exposure),
there's no runbook for rotating it without a full stack rebuild-from-scratch.

**Action:** write a rotation runbook per secret — most are a
`docker compose up -d --force-recreate <service>` after updating `.env` and
re-running the relevant `ALTER ROLE ... PASSWORD` for DB roles;
`AUTHENTIK_SECRET_KEY` needs its own documented procedure since Authentik
uses it to encrypt stored data (verify Authentik's own rotation guidance
before writing this one — it is not a drop-in swap like the others).

## Explicitly out of scope

Per the same exclusion logic used for the earlier security review: outdated
third-party library versions themselves (covered by item 5's *process*, not
listed as individual findings), rate-limiting tuning, and anything already
closed by `docs/plan/2026-08-11-hardening.md` (TLS, non-root containers,
`backend:3000` no longer published, per-route rate limiting).
