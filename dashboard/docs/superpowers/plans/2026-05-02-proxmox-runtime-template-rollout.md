# Proxmox Runtime Template Rollout Plan

## What We Know

- New Proxmox instances clone from `PROXMOX_TEMPLATE_ID`, defaulting to VMID `9000`.
- The provisioner uses linked clones: `qm clone "$TEMPLATE_ID" "$VMID" --full 0`.
- Linked clones are fast, but the parent template can be a live dependency. Do not delete old templates blindly.
- Existing WebUI agents do not become "new-template based" after a template change. They keep their existing VM disk and should receive runtime changes in place.
- The existing WebUI update path pulls both `ghcr.io/ashneil12/hermes-webui:stable` and `ghcr.io/ashneil12/vanilla-hermes-agent:stable`, re-seeds the `agent-source` volume, and force-recreates WebUI/sidecar.
- The existing `ops:webui:fleet-pull` sweep only refreshes the WebUI image. It is not enough for agent-runtime-only changes like Bankr support.

## Rollout Model

1. **Runtime image**
   - Sync `/Users/example/Projects/vanilla-hermes-agent` with upstream.
   - Keep HermesOS-specific commits on top: Bankr env aliases, Bankr wallet prompt awareness, and GHCR `:stable` publishing.
   - Push `main` to `ashneil12/vanilla-hermes-agent`.
   - GitHub Actions publishes `ghcr.io/ashneil12/vanilla-hermes-agent:stable`.

2. **Existing agents**
   - Update in place through `applyLiveUpdate`, not by swapping templates.
   - Add a fleet script that calls `applyLiveUpdate` for every running WebUI instance.
   - Use dry-run first, then apply with limited concurrency.
   - Confirm `/api/config` or runtime env exposes Bankr variables after update.

3. **New agents**
   - Build and bake a fresh Proxmox template only after the runtime image is confirmed healthy.
   - Pre-pull current `hermes-webui:stable`, `vanilla-hermes-agent:stable`, and `caddy:2` into the template.
   - Stamp template metadata inside the guest, e.g. `/etc/hermes/template-version.json`, with template VMID, build date, dashboard commit, agent image digest, and WebUI image digest.
   - Point `PROXMOX_TEMPLATE_ID` at the new template only after a smoke provision succeeds.

4. **Template cleanup**
   - Add an audit script before deleting anything.
   - The audit must list each template, each running VM, and whether the VM disk references a base volume from that template.
   - Only delete templates with zero dependent linked clones and outside the rollback window.
   - If a VM was full-cloned, the parent template can be deleted once no rollback policy needs it. If it was linked-cloned, the parent must stay.

## Implementation Tasks

1. Add `dashboard/scripts/fleet-apply-live-update.ts`.
   - Query running `hermes_instances` with `backend = 'webui'`.
   - Resolve each instance IP using `resolveInstanceIpv4`.
   - Load global settings from Clerk when available; fall back to `{}` for orphaned users.
   - Call `applyLiveUpdate(instance, ipv4, globalSettings, supabase)`.
   - Support `--dry-run`, `--instance <id>`, and `--concurrency N`.
   - Add package script: `ops:webui:fleet-live-update`.

2. Add `dashboard/scripts/proxmox-template-audit.ts`.
   - Run on the Proxmox host through existing host SSH helpers.
   - Collect `qm list`, `qm config <vmid>`, and storage-backed disk references.
   - Output `SAFE_TO_DELETE`, `KEEP_LINKED_PARENT`, or `KEEP_ROLLBACK` per template.
   - Never delete anything in this script.

3. Persist template provenance for new instances.
   - Add `proxmox_template_vmid` to `hermes_instances` or add it to `config.infrastructure`.
   - Prefer a real column for admin queries and pruning reports.
   - Populate it from the `PROXMOX_TEMPLATE_ID` used during provision.
   - Backfill existing Proxmox rows from disk parent audit where possible.

4. Add `dashboard/scripts/proxmox-template-prune.ts`.
   - Requires an audit JSON file produced by the audit script.
   - Refuses to run unless every selected template is `SAFE_TO_DELETE`.
   - Supports `--dry-run` and `--apply`.
   - Uses `qm destroy <template-vmid> --purge 1` only for confirmed safe templates.

5. Bake and promote the new template.
   - Use the freshly published vanilla agent image digest, not just the floating `:stable` tag.
   - Smoke provision one test instance.
   - Verify Bankr env vars inside the VM:
     - `BANKR_AGENT_API_KEY`
     - `BANKR_API_KEY`
     - `BANKR_AGENT_WALLET_ADDRESS`
     - `BANKR_WALLET_ADDRESS`
   - Update production `PROXMOX_TEMPLATE_ID`.

6. Fleet-update existing agents.
   - Run the new live-update fleet script in dry-run mode.
   - Apply with low concurrency.
   - Watch update reports and instance health.
   - Spot-check one existing agent's Bankr env/config after update.

## Verification Commands

```bash
# Runtime image status
gh run list --repo ashneil12/vanilla-hermes-agent --branch main --limit 5

# Dashboard tests after wiring changes
npx jest src/lib/services/__tests__/webui-instance-builder.test.ts src/lib/services/__tests__/instance-orchestrator.test.ts --runInBand
npx tsc --noEmit --pretty false

# Existing agents after the fleet script exists
npm run ops:webui:fleet-live-update -- --dry-run
npm run ops:webui:fleet-live-update -- --apply --concurrency 3

# Template safety after the audit script exists
npm run ops:proxmox:template-audit -- --out /tmp/hermes-template-audit.json
npm run ops:proxmox:template-prune -- --audit /tmp/hermes-template-audit.json --dry-run
```

## Key Decision

Templates are for speeding up new VM creation. They are not the update mechanism for existing users. Existing users should get new Bankr-capable runtime code through the live update path; templates should be rebuilt and pruned separately with explicit dependency checks.
