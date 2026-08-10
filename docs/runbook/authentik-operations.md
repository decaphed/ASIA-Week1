# Authentik Operations Runbook

Operator procedures for the auth CT (`10.10.10.16`) stack introduced by
`docs/plan/2026-08-09-authentik-split-ct.md`. This file is the "how", the
plan is the "why" — read the plan first if something here is unclear.

## 1. mkcert local CA setup and distribution

1. Install mkcert on **your own workstation**, not the auth CT — the CA
   private key should live where you control it, not on a network-facing
   container host.
2. `mkcert -install` — creates the root CA and installs it into your local
   trust store. `mkcert -CAROOT` prints where the CA files live.
3. Issue one leaf cert with both SANs:
   ```
   mkcert -cert-file dashboard.home.pem -key-file dashboard.home-key.pem \
     dashboard.home auth.home
   ```
4. Copy `dashboard.home.pem` and `dashboard.home-key.pem` to
   `authentik/certs/` on the auth CT. `chmod 600 dashboard.home-key.pem`.
   **Never** copy `rootCA-key.pem` to the auth CT.
5. Distribute `rootCA.pem` (certificate only, never the key) to every
   machine/browser that will open the dashboard:
   - Machines with mkcert installed: `mkcert -install` there too (uses the
     same CA files if you sync `$(mkcert -CAROOT)`, or generates a new CA
     — in that case you'd need a second leaf cert signed by it).
   - Otherwise: import `rootCA.pem` into the OS trust store.
   - **Firefox** uses its own certificate store, independent of the OS —
     either import `rootCA.pem` under
     Settings → Privacy & Security → Certificates → View Certificates →
     Authorities → Import, or set `security.enterprise_roots.enabled` in
     `about:config` to use the OS store instead.
6. **Expiry:** record the leaf's actual expiry date here once issued
   (`openssl x509 -enddate -noout -in dashboard.home.pem`). mkcert leaves
   are valid ~2 years; the CA is ~10 years. Renewal: re-run step 3, copy
   the two files over the old ones in `authentik/certs/`, then
   `docker compose -f docker-compose.auth.yml restart traefik`. Traefik
   does not need the CA reinstalled for a leaf reissue.

   Leaf issued: _______  |  Expires: _______

## 2. Manual database provisioning (live pdm-db volume)

`db/init/02-create-authentik-db.sh` will **not** run against the existing
`pdm_db_data` volume — `/docker-entrypoint-initdb.d/` only fires on first
initialization. Apply the equivalent manually, on the **pdm-db CT**.

**Preferred: interactive session**, so the password is never typed on a
command line that lands in shell history:

```
docker compose -f docker-compose.db.yml exec pdm-db psql -U postgres
```
Then, at the `psql` prompt:
```
CREATE ROLE authentik_svc LOGIN;
\password authentik_svc
CREATE DATABASE authentik_db OWNER authentik_svc;
```
`\password` reads the value with echo off and never puts it in a command
line or `.psql_history` in cleartext.

**Fallback: scripted heredoc**, only if you must run this non-interactively
(e.g. from an automation tool). The password lands in shell history this
way — clear it afterwards (`history -d` for the relevant line, or
`history -c` if acceptable):
```
docker compose -f docker-compose.db.yml exec -T pdm-db \
  psql -v ON_ERROR_STOP=1 -U postgres <<'EOSQL'
CREATE ROLE authentik_svc LOGIN PASSWORD 'REPLACE_ME';
CREATE DATABASE authentik_db OWNER authentik_svc;
EOSQL
```

Either way, run via `docker compose exec` into the container, not
`psql -h 10.10.10.15 ...` from elsewhere — the superuser password never
needs to cross the network this way.

Verify from the **auth CT**, before writing any compose file there:
```
psql "postgres://authentik_svc:PASSWORD@10.10.10.15:5432/authentik_db" -c "SELECT 1;"
```
If this fails, stop — everything downstream fails confusingly.

Verify isolation (should be refused, or connect but see no tables):
```
psql "postgres://authentik_svc:PASSWORD@10.10.10.15:5432/pump_telemetry" -c "SELECT 1;"
```

## 3. DNS / hosts entries

On every machine that will open the dashboard, and on the auth CT itself
if it self-references either name, add to `/etc/hosts` (or `C:\Windows\
System32\drivers\etc\hosts`):
```
10.10.10.16   dashboard.home
10.10.10.16   auth.home
```

## 4. Proxmox CT firewall rules

See `docs/plan/2026-08-09-authentik-split-ct.md` §6 for the full table and
ordering rationale. Summary: firewall must be enabled at **both** the CT's
Firewall → Options level **and** on `net0`. Add the SSH+ICMP management
rule (source `10.10.10.13`) on every CT **before** flipping the input
policy to DROP, and keep `pct enter <vmid>` open as a recovery path while
you work. Apply order: pdm-db, backend, frontend, auth (last, since the
frontend rule going live before Traefik works takes the dashboard offline
with no way in).

## 5. Traefik access log rotation

`docker-compose.auth.yml` bind-mounts `./authentik/traefik/logs` to
`/var/log/traefik` and `traefik.yml` enables `accessLog` persistently.
The auth CT has no log rotation configured by default — add a
`logrotate` config on the CT (not managed by this repo), e.g.
`/etc/logrotate.d/traefik`:
```
/root/ASIA-Week1/authentik/traefik/logs/access.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
```
Adjust the path to wherever the repo is checked out on the auth CT.
`copytruncate` is used because Traefik keeps the file open; a
`postrotate`/`kill -HUP` approach also works if preferred but requires
send-signal support in the container.

## 6. First login

With `AUTHENTIK_BOOTSTRAP_*` vars set (they are, per `.env.auth.example`),
`akadmin` already exists. Log in at `https://auth.home/` with
`AUTHENTIK_BOOTSTRAP_EMAIL` / `AUTHENTIK_BOOTSTRAP_PASSWORD`. Do **not**
expect `/if/flow/initial-setup/` to work — that flow is only reachable
when bootstrap vars were never set.

## 7. Rollback

See plan §9 for the three-level rollback (firewall relax → `docker compose
down` on auth CT → full `DROP DATABASE`/`DROP ROLE` + `CLIENT_ORIGIN`
revert). No existing CT's compose file is ever modified by this stack, so
rollback at any level restores exactly the pre-auth state.
