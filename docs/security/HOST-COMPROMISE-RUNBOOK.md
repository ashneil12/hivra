# Host compromise and guest quarantine runbook

Owner: Ash. Every step that changes a host, the fleet, customer data, provider settings or the Vercel environment is Ash's call. An agent may run the read-only steps and prepare the rest. No secret value belongs in this file, in a PR, in chat or in a log.

Use this when one of these is true:

- a guest VM is acting against its neighbours, the host or the internet (scanning, spoofing, abuse reports);
- a Proxmox host may be compromised (unexpected root logins, changed nftables rules, unknown processes, a provider abuse notice);
- a credential that reaches guests or hosts may have leaked (orchestrator key, Origin CA key, per-guest tokens, GHCR token, `CRON_SECRET`).

## What the platform can and cannot do today

Read this first, because it decides which steps are real.

- Customer boxes are KVM VMs. A guest escape lands on the host as root. That host holds root SSH into every guest on it (the per-host orchestrator key), the fleet-shared Cloudflare Origin CA key and per-guest tokens. Treat everything on a compromised host as compromised.
- Guest-to-guest traffic and guest-to-host admin ports are blocked on the host (bridge table `hermes_vm_isolation`, inet `filter` input and forward chains). Per-VM MAC/IP pinning is `dashboard/scripts/proxmox-host-vm-antispoof.sh`. Run it with `--check` on the host. Where it is not installed, a guest can impersonate a neighbour's IP towards the host, so assume a hostile guest could read its neighbours' incoming traffic.
- There is no working global launch switch. `HERMES_PROVISIONING_DISABLED` exists in `dashboard/src/lib/instance-lifecycle.ts` but no create path reads it. To stop new launches on one host, set its `proxmox_hosts.status` to `maintenance`. Stopping launches everywhere needs every host set to `maintenance`.
- Stop and force-stop run through the host. On a compromised host they are not proof of anything. Real containment comes from outside the host, at the provider: the server's firewall or a power-off in the provider console.
- Deleting an account's records does not stop its VMs or servers. Tear each one down at the host or provider and confirm it is gone.

## 1. Detect and record (read-only)

1. Write down the time, who noticed and what was seen. Keep every alert, log line and screenshot.
2. Identify the host and the guest by `(host, vmid)`, never by private IP. Every host reuses the same private /24.
3. Read the host's state without changing it: `nft list ruleset`, `ss -ltnup`, `last`, `journalctl -u ssh --since -24h`, `qm list`, and `pve-firewall status`. Compare the ruleset with the perimeter guard (`dashboard/scripts/proxmox-host-perimeter-guard.sh --check`) and the bridge isolation table.
4. If the host itself is suspect, read from outside instead: the provider's console, traffic graphs and abuse notices. A compromised host can lie to SSH.

## 2. Contain one guest

1. Stop new work for that agent: mark the row so the dashboard stops routing to it. That means status `error` with a lifecycle note, done by the owner of the change, not by editing data by hand.
2. Cut its network on the host. Re-set its NIC with the same model, MAC and bridge plus `link_down=1` (`qm config <vmid>` shows the current `net0` line; append `,link_down=1` and pass it back with `qm set <vmid> --net0 ...`). Use `qm stop <vmid>` instead only once the evidence is captured. Prefer `link_down`, because it keeps memory and disk for later analysis.
3. Snapshot the disk before any rebuild (`vzdump <vmid> --mode snapshot`), and keep it outside the guest's own backup set.
4. Revoke the guest's credentials at the control plane:
   - rotate the instance API key (redeploy with a new key);
   - revoke its managed Venice proxy key;
   - remove its agent link keys and activity collector token;
   - rotate any customer integration token it held, together with the customer.

## 3. Contain a host

Do this from outside the host. Commands run on a compromised host can be faked.

1. Stop placement: set the host's `proxmox_hosts.status` to `maintenance` in both the prod and canary registries. This is a production write, so it needs Ash's OK for that exact row.
2. Cut the host off at the provider: apply the provider firewall so that only your own admin addresses reach SSH. If you can't trust it at all, power the server off from the provider console.
3. Assume every guest on that host is compromised. Notify their owners and plan a rebuild on a clean host. Draft the notices, and sending them is Ash's call.
4. Keep the disk for analysis if the provider allows it, such as rescue mode with read-only mounts.

## 4. Revoke credentials

Work outward from the compromised scope:

| Credential | Where it lives | Action |
| --- | --- | --- |
| Per-host orchestrator SSH key (`/etc/hivra/keys/vm-orchestrator`) | The host, and the public key in every guest on it | Rebuilt guests get a fresh key. Remove the old public key from any guest that is kept. |
| Cloudflare Origin CA wildcard key | Every Hermes host | Revoke it in Cloudflare, issue a new one and reseed every host. This is fleet-wide, because one copy is shared. |
| Per-guest API and sidecar tokens | Guest `.env` files and DB rows | Rotate per guest on redeploy. |
| `CRON_SECRET` | Vercel env | Rotate if it may have been seen. It grants cross-tenant reads and fleet operations. |
| `GHCR_TOKEN` | See `GHCR-TOKEN-ROTATION.md` | Follow that runbook's order. |
| Host connector and relay secrets | Host relay worker and the connector | Rotate the connector secret for that host. `HOST_RELAY_SECRET` derives every connector secret, so rotating it re-enrolls every connected host. |

Vercel env changes, Cloudflare and provider changes, and secret rotation are Ash's call.

## 5. Rebuild from trusted sources

1. Reinstall the host from the provider image, then follow the host standup procedure. Never reuse a disk from a compromised host.
2. Run the perimeter guard with `--check`, then `--apply`. Install the anti-spoof guard with `--apply`, then `--install-triggers`. Confirm `hermes_vm_isolation` and `hermes_vm_antispoof` are both present before any guest is placed.
3. Restore guests from backups taken before the first sign of compromise. Each restored guest gets new credentials, and a guest is never restored straight back onto the host it came from.
4. Return the host to `active` only after a read-only fleet sweep passes for it.

## 6. Close out

- Write a short incident note covering the timeline, scope, what was rotated, which customers were affected and what was told to them.
- Add any missing control to `docs/SECURITY-MODEL.md`, or file it as a finding.
- Re-run the read-only host isolation probe on every host.
