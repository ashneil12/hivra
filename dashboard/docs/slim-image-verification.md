# Slim Image Verification — Dashboard → Slim End-to-End

Slim was made the live default at `ca10df31` ("chore(vercel): refresh slim agent image env") without an end-to-end confirmation that the dashboard provisioning path actually lands on slim and boots healthy. The canary mechanism in `instance-service.ts` was bypassed in favour of flipping `HERMES_WEBUI_AGENT_*` envs globally.

This is the manual checklist to close that gap. Run it once before the next reasoning-heavy change touches the WebUI provisioning path.

## Pre-flight

- Confirm the three Vercel Production envs are still pointing at slim:
  - `HERMES_WEBUI_AGENT_IMAGE`
  - `HERMES_WEBUI_AGENT_PROVISION_IMAGE`
  - `HERMES_WEBUI_AGENT_UPDATE_IMAGE`
- All three should end in `:slim`. Pull with `vercel env pull --environment=production` and `grep -E '^HERMES_WEBUI_AGENT_(IMAGE|PROVISION_IMAGE|UPDATE_IMAGE)='`.

## Provision step

1. Sign in to the live dashboard as an account listed in `COMMAND_CENTER_V2_ALLOWLIST` if you also want to re-exercise the canary branch.
2. Provision a fresh WebUI VM.
3. Note the `instance_id` returned in the URL after provisioning.

## Verification

### 1 — Vercel production logs

Within ~30 s of provision start, the dashboard logs the resolved image. Two log lines to look for, both at `source=instance-service`:

- `webui_provision_canary_image_selected` — fires only if the account is in the canary allowlist. Includes `webuiImage`/`agentImage` in the log payload.
- The standard provisioning log line will still mention the chosen image via the proxmox service.

If neither shows up but the provision succeeds, the env defaults applied. Grep Vercel logs for the instance id to find the dashboard side of the trace.

### 2 — Boot timing

The slim image needs ~5–6 min of first-boot work because runtime pieces are pulled in-VM. Acceptance window:

- Metadata returned in `< 30 s` (dashboard shows `provisioning`)
- Private health 200 within `7 min`
- Cleanup completed (`provisioned` status, disk reported at ~9–10 G in-guest) within `8 min`

If the VM is in `failed` or `provisioning` longer than 10 min, look at `/var/log/hermes-*.log` inside the VM.

### 3 — Image baked into the timer

SSH to the VM, then:

```bash
grep -E '^docker pull ' /usr/local/bin/hermes-auto-update-<instance-id>
```

It must print a line ending in `:slim` (or whatever canary tag if you used the canary path). If it ends in `:stable`, the env wasn't picked up at script-generation time — investigate the Vercel deploy that ran when the provision happened.

### 4 — Compose image

```bash
docker compose -f /opt/hermes/instances/<instance-id>/docker-compose.yml config --images
```

Should list `ghcr.io/ashneil12/hermes-webui:stable` (or current pinned tag) plus the agent image. Re-confirm the agent image matches the timer.

### 5 — Functional smoke

Open the public hostname in a browser. Sign in. Send a one-line message to the agent and watch the chat round-trip. Latency target: first token within `5 s` of submit on slim.

## What "pass" looks like

- All four log/grep checks succeed.
- VM is `provisioned` in the dashboard.
- Browser-side chat round-trips inside the latency target.
- `docker compose ps` inside the VM shows webui + sidecar both `healthy`.

## What "fail" looks like and what to do

- **Image is `:stable` despite envs pointing at `:slim`** — Vercel cached an older deployment. Bounce production with a no-op deploy-trigger commit (`git commit --allow-empty -m "chore(vercel): refresh slim agent image env"`) and reprovision.
- **VM never crosses `provisioned`** — check `/var/log/hermes-webui-provision.log` inside the VM. Slim's first-boot is more pull-heavy than the baked image, so transient registry timeouts are plausible. Re-provision once before declaring a regression.
- **Auto-update timer pinned to wrong image** — `buildAutoUpdateTimerProvisioningScript` resolves the image at script-generation time (dashboard-side). Confirm the Vercel deploy that handled the provision had the right env. If the live Vercel deploy was up-to-date but the timer is wrong, the bug is in the env-resolution chain in `hetzner-instance-builders.ts:1159`.

## Followup

Once verification passes:

- Re-add a small "boot timing" assertion (current slim canary p50 vs the next image rollout) so future image regressions show up as boot-time deltas, not silent breakage at first manual smoke.
