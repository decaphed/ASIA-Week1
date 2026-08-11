# Hardening Pass — TLS, Rate Limiting, Container Security, Firewall

Follow-up to the architecture/security review conducted the same day this
stack was consolidated onto a single CT. Closes the findings from that
review that were in scope for this pass. Not a from-scratch plan document
like the consolidation/split-CT plans it builds on — this one just records
what changed and why, since several of these changes explicitly reverse
decisions those earlier plans made deliberately.

## Scope

1. Stop publishing `backend:3000` to the LAN (the review's critical finding).
2. Run `backend` and `client` as non-root in their containers.
3. Traefik rate limiting on the auth and app-facing routers.
4. TLS via mkcert, reversing the "dropped, not reopened" decision in
   `docs/plan/2026-08-09-authentik-split-ct.md` §3 and carried forward by
   `docs/plan/2026-08-10-single-ct-consolidation.md` §3 — reopened this pass
   by explicit user request, not a default reconsideration.
5. Proxmox host firewall ruleset, written but not applied (no host access
   from the session that did this work — see §5 below).

Explicitly not in scope: per-user authorization/RBAC (the review's other HIGH
finding — Authentik headers still aren't consumed anywhere), Postgres
`REVOKE CONNECT FROM PUBLIC`, and the floating `redis:7-alpine` tag. Left for
a future pass.

## 1. backend:3000 no longer published

`docker-compose.yml`'s `backend` service had `ports: ["3000:3000"]` for one
reason — an external Node-RED host needed to reach it. Node-RED now runs as
an in-stack container (`node-red` service) and posts to `http://backend:3000/api/data`
over the internal Compose network, so nothing outside the stack needs that
port anymore. Removed the mapping entirely rather than adding
backend-side auth to it — closes the LAN-wide unauthenticated path into
every `/api/*` route at the source instead of bolting a check onto it.

Verified: `docker compose port backend 3000` returns nothing (no LAN
mapping); a direct connection attempt from outside the CT to `:3000` fails;
the dashboard and Node-RED ingestion both continue working over the internal
network.

## 2. Non-root containers

- `server/Dockerfile`: added `USER node` (the `node:20-alpine` base image
  ships this user already) and `--chown=node:node` on the final `COPY`.
- `client/Dockerfile`: switched from `nginx:1.27-alpine` to
  `nginxinc/nginx-unprivileged:1.27-alpine`, which runs entirely as uid 101
  with no root process at all (the stock nginx image's master process needs
  root to bind port 80). Listens on `8080` instead of `80` —
  `client/nginx.conf`'s `listen` directive and
  `authentik/traefik/dynamic/dynamic.yml`'s `client` service both updated to
  match.

`pdm` and `node-red` were already non-root (verified via `docker compose exec <svc> id` before this pass — uid 1000 for both, from their own base images/Dockerfiles). This pass brings `backend` and `client` to the same standard.

Verified: `docker compose exec backend id` → uid 1000 (node);
`docker compose exec client id` → uid 101 (nginx). Full request path
(browser → Traefik → client → backend → postgres) re-tested end to end after
rebuild.

## 3. Rate limiting

Two new middlewares in `authentik/traefik/dynamic/dynamic.yml`:

| Middleware | Applied to | average | period | burst |
|---|---|---|---|---|
| `rl-auth` | `auth.home`, both outpost callback routers | 60 | 1m | 30 |
| `rl-app` | `dashboard.home`, `nodered.home` | 240 | 1m | 80 |

`rl-auth` is deliberately tighter — it's the login/token-exchange surface.
`rl-app` is sized to comfortably cover the dashboard's own per-second polling
of several `GET` endpoints without a real user ever seeing a 429. Both run
*before* `authentik-auth` in each router's middleware list, so a flood gets
throttled before it generates a forward-auth subrequest to
`authentik-server`.

Verified: a 40-request burst against `auth.home` starts returning `429`
after ~36 requests, consistent with the configured burst + short-window
refill; normal dashboard access unaffected.

## 4. TLS via mkcert

- `authentik/traefik/traefik.yml`: added a `websecure` entrypoint on `:443`;
  the `web` entrypoint (`:80`) now unconditionally redirects to it
  (`http.redirections.entryPoint`).
- `authentik/traefik/dynamic/dynamic.yml`: added a `tls.certificates` block
  pointing at `/etc/traefik/certs/dashboard.home{,-key}.pem`; every router
  switched from `entryPoints: [web]` to `entryPoints: [websecure]` with
  `tls: {}`.
- `docker-compose.yml`: `traefik` now publishes `443:443` in addition to
  `80:80`, and mounts `./authentik/traefik/certs:/etc/traefik/certs:ro`.
- `authentik/blueprints/dashboard-proxy-provider.yaml`: both proxy
  providers' `external_host`, and the embedded outpost's `authentik_host` /
  `authentik_host_browser`, switched from `http://` to `https://` — these
  values are what the browser-facing OAuth2 redirect actually reuses (see
  the blueprint's own comments), so leaving them `http://` would have meant
  an extra needless redirect hop through the new `web`→`websecure`
  redirection on every login.
- `docker-compose.yml` / `.env` / `.env.example`: `CLIENT_ORIGIN` and
  `AUTHENTIK_HOST_BROWSER` switched to `https://`.

**Root CA generation:** done on the operator's own workstation, per
`docs/runbook/authentik-operations.md` §1 — not on this CT, to keep the CA
private key off the network-facing host it protects. Only the leaf
cert/key are copied to `authentik/traefik/certs/` (gitignored).

**Bridge cert:** a temporary self-signed cert (30-day, same three SANs) was
generated directly on the CT to verify the full TLS wiring end-to-end
without waiting on the operator's out-of-band mkcert step blocking every
other change in this pass. It works (browsers will show an untrusted-cert
warning until replaced) and is a drop-in swap for the real mkcert leaf —
same filenames, same directory, `docker compose restart traefik` (or touch
`dynamic.yml`) to pick it up. **This must be replaced with the real mkcert
leaf** before relying on this stack's TLS for anything beyond wiring
verification.

Verified: `http://dashboard.home/` returns `308` to `https://`; all three
hostnames serve correctly over `https://` (self-signed, `curl -k`); the
served cert's SANs match `dashboard.home`/`auth.home`/`nodered.home`; the
Authentik session cookie now carries the `Secure` flag (it didn't before);
OAuth2 redirect URIs are `https://`; ingestion and full dashboard flow
re-verified after the Traefik/backend restart this required.

## 5. Proxmox host firewall

Written, not applied — see `proxmox/firewall/app-ct.fw` and
`docs/runbook/proxmox-firewall.md`. The session that did this work has shell
access only to the app CT itself (no `/etc/pve`, no `pct`), not the Proxmox
host, so this genuinely cannot be applied from inside this repo's checkout —
it has to be copied onto the host and run by an operator, staged carefully
(SSH rule verified from a second terminal before `policy_in: DROP`, console
access kept open throughout).

Only two inbound rules needed: `tcp/80` and `tcp/443`, both LAN-wide (plus
the management SSH/ICMP allowance). No `tcp/3000` rule — see §1 above, that
port isn't published anymore.
