# Authentik Operations Runbook

Operator procedures for the single app CT stack (`docs/plan/2026-08-10-single-ct-consolidation.md`,
hardened further in `docs/plan/2026-08-11-hardening.md`). This file is the
"how", the plan docs are the "why" — read them first if something here is
unclear.

> **Superseded content removed 2026-08-11:** this file used to describe the
> earlier split-CT topology (`docs/plan/2026-08-09-authentik-split-ct.md`) —
> a hardcoded `10.10.10.16` auth CT, four separate `docker-compose.*.yml`
> files, and a manual `pdm-db` provisioning step. All of that is gone on the
> single-CT topology: one `docker-compose.yml`, one `postgres` service whose
> `db/init/*` scripts provision both databases automatically on first boot
> (see the consolidation plan §2), and one CT whose actual IP you find with
> `ip -4 addr show eth0` on that CT — don't assume a fixed address here, it's
> deployment-specific.

## 1. mkcert local CA setup and distribution

1. Install mkcert on **your own workstation**, not the app CT — the CA
   private key should live where you control it, not on a network-facing
   container host.
2. `mkcert -install` — creates the root CA and installs it into your local
   trust store. `mkcert -CAROOT` prints where the CA files live.
3. Issue one leaf cert covering all three hostnames this stack serves:
   ```
   mkcert -cert-file dashboard.home.pem -key-file dashboard.home-key.pem \
     dashboard.home auth.home nodered.home
   ```
4. Copy `dashboard.home.pem` and `dashboard.home-key.pem` to
   `authentik/traefik/certs/` on the app CT. `chmod 600 dashboard.home-key.pem`.
   **Never** copy `rootCA-key.pem` there — that file should never leave your
   workstation. Both files are gitignored (see `.gitignore`), so this is a
   manual copy every time, not a commit.
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
6. Traefik picks up a replaced cert on its own — `tls.certificates` in
   `authentik/traefik/dynamic/dynamic.yml` is served from the file provider's
   watched directory tree, but the **cert files themselves live in a
   separately mounted volume** (`./authentik/traefik/certs`) that isn't
   watched directly. After overwriting the two files, force a reload with
   either `docker compose restart traefik` or by touching `dynamic.yml`
   (e.g. `touch authentik/traefik/dynamic/dynamic.yml`).
7. **Expiry:** record the leaf's actual expiry date here once issued
   (`openssl x509 -enddate -noout -in dashboard.home.pem`). mkcert leaves
   are valid ~2 years; the CA is ~10 years.

   Leaf issued: _______  |  Expires: _______

## 2. DNS / hosts entries

On every machine that will open the dashboard, add to `/etc/hosts` (or
`C:\Windows\System32\drivers\etc\hosts`), replacing `<APP-CT-IP>` with this
CT's actual address (`ip -4 addr show eth0` on the CT itself — do not assume
it matches an old value written down somewhere else):
```
<APP-CT-IP>   dashboard.home
<APP-CT-IP>   auth.home
<APP-CT-IP>   nodered.home
```

## 3. Proxmox host firewall

See `docs/runbook/proxmox-firewall.md` for the full staged apply procedure
and `proxmox/firewall/app-ct.fw` for the actual ruleset — both written for
this single-CT topology (two published ports only: `80` redirecting to
`443`). Do not reuse the old split-CT plan's 4-CT firewall table; it
describes a topology this repo no longer runs.

## 4. Traefik rate limiting

`authentik/traefik/dynamic/dynamic.yml` defines two `rateLimit` middlewares —
`rl-auth` (tight, on `auth.home` and the outpost callback paths) and `rl-app`
(looser, on the gated dashboard/Node-RED routers, sized for the dashboard's
own per-second polling). If a legitimate multi-user session starts tripping
`rl-app`'s 429s under normal use, raise `average`/`burst` there rather than
removing the middleware — the goal is headroom for real traffic, not no
limit at all.

## 5. Traefik access log rotation

`docker-compose.yml` bind-mounts `./authentik/traefik/logs` to
`/var/log/traefik` and `traefik.yml` enables `accessLog` persistently.
This CT has no log rotation configured by default — add a `logrotate` config
on the CT (not managed by this repo), e.g. `/etc/logrotate.d/traefik`:
```
/root/ASIA/authentik/traefik/logs/access.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
```
Adjust the path to wherever the repo is actually checked out on this CT.
`copytruncate` is used because Traefik keeps the file open; a
`postrotate`/`kill -HUP` approach also works if preferred but requires
send-signal support in the container.

## 6. First login

With `AUTHENTIK_BOOTSTRAP_*` vars set (they are, per `.env.example`),
`akadmin` already exists. Log in at `https://auth.home/` with
`AUTHENTIK_BOOTSTRAP_EMAIL` / `AUTHENTIK_BOOTSTRAP_PASSWORD`. Do **not**
expect `/if/flow/initial-setup/` to work — that flow is only reachable
when bootstrap vars were never set.

## 7. Rollback

Firewall: see `docs/runbook/proxmox-firewall.md` §5. Stack: `docker compose
down` (add `-v` only if you intend to discard all data — see the
consolidation plan §8's risk register on this exact footgun). No TLS
rollback needed at the Traefik level beyond reverting
`authentik/traefik/traefik.yml`'s entrypoints and `dynamic.yml`'s `tls:`
block if you ever need to go back to plain HTTP — not expected to be
necessary.
