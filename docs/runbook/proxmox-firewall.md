# Proxmox Host Firewall — Apply Runbook

Operator procedure for `proxmox/firewall/app-ct.fw` against the single app CT
(`docs/plan/2026-08-10-single-ct-consolidation.md`). This has to be run **on
the Proxmox host**, by hand — no session with only the CT's own shell (no
`/etc/pve`, no `pct`) can apply it, and that's deliberate: the host is where
`pve-firewall` actually lives.

**Read this whole file before running anything.** The dangerous step is
`policy_in: DROP` — get the ordering wrong and you lock yourself out of a CT
with no firewall-side way back in.

## 0. Before you start

- Find this CT's VMID: `pct list` on the Proxmox host, or the number in
  parentheses next to the CT's name in the Datacenter tree in the GUI.
- Know the IP of the machine you're actually SSHing from right now. That's
  `<MGMT_HOST_IP>` in `proxmox/firewall/app-ct.fw` — replace both occurrences
  before uploading.
- Keep a **second, independent way into the CT** open for the entire
  procedure: `pct enter <VMID>` from the Proxmox host's own console (physical,
  iDRAC/iLO, or an already-open root shell on the host). This bypasses the
  CT's network stack entirely, so it survives even a completely wrong
  firewall rule. Do not proceed past step 3 without this open in a separate
  window.

## 1. Enable the firewall at both required levels

Proxmox's CT firewall does nothing unless it's enabled at **both** places —
missing either one means the rules below are silently inert:

1. **Datacenter → Firewall → Options** → `Firewall: Yes`.
2. **This CT → Firewall → Options** → `Firewall: Yes`.
3. **This CT → Network → net0 → Edit** → `Firewall: Yes` checkbox.

## 2. Install the ruleset — SSH rule first, verified, before anything else

```bash
# On the Proxmox host:
cp /root/ASIA/proxmox/firewall/app-ct.fw /etc/pve/firewall/<VMID>.fw
# Edit the copy, not the repo file: replace both <MGMT_HOST_IP> placeholders.
vi /etc/pve/firewall/<VMID>.fw
```

`pve-firewall` picks up `.fw` file changes automatically (it watches
`/etc/pve/firewall/`) — no separate reload command needed, but the change is
live within a few seconds of saving.

**Immediately after saving**, from your actual management machine (a THIRD
terminal, not the `pct enter` console):

```bash
ssh <user>@<app-ct-ip>
```

If this fails, stop. Do not proceed to step 3. Go back to
`/etc/pve/firewall/<VMID>.fw` and fix `<MGMT_HOST_IP>` — you got the source
IP wrong, or the CT firewall isn't actually enabled yet (recheck step 1).
Your `pct enter` console is still open, so nothing is broken yet.

## 3. Confirm the front door still works

From any LAN machine (not through the firewall's SSH allowance — this is
testing the `tcp/80` rule, a separate line):

```bash
curl -I http://dashboard.home/
```

Expect a `302` toward the outpost, same as always. If TLS is live (see the
commented `443` line in `app-ct.fw`), also check `https://dashboard.home/`.

## 4. Only now, verify nothing else got through

From a LAN machine that is **not** `<MGMT_HOST_IP>`:

```bash
curl -m 5 http://<app-ct-ip>:3000/api/health   # expect: connection refused/timeout
ssh <app-ct-ip>                                 # expect: connection refused/timeout
```

Port 3000 should already refuse connections regardless of the firewall —
`backend` no longer publishes it at all (see the architecture review). This
step confirms the firewall is providing defense-in-depth on top of that, not
the only thing standing between it and the LAN.

## 5. Rollback

- **Fastest:** `rm /etc/pve/firewall/<VMID>.fw` on the Proxmox host, or set
  `enable: 0` in `[OPTIONS]` and save — `pve-firewall` picks it up within
  seconds, same as install.
- **If even that's unreachable:** `pct enter <VMID>` from the host console
  (kept open per §0) still works no matter what the firewall rules say, since
  it never touches the CT's network stack.

## Notes for future changes to this ruleset

- `docker-compose.yml`'s only published ports are `80` (Traefik) and, once
  TLS lands, `443`. Adding a new published port to compose means adding a
  matching `IN ACCEPT` line here, or that port is reachable from the LAN with
  no firewall layer at all covering it — the app-CT firewall doesn't infer
  from compose, the two have to be kept in sync by hand.
- If Node-RED, or anything else, ever needs to be reached directly by a host
  outside this CT again, that's a new published port in compose AND a new
  scoped (not LAN-wide) `IN ACCEPT` line here — don't default to opening it
  to the whole LAN the way the old `tcp/3000` rule did.
