# Preserve Hermes state during a Workspace migration

This runbook retains reusable procedures from the historical WebUI-to-Workspace
canary migration. It is not proof that a current runtime has passed this migration.
Resolve paths, service names, API contracts, images and authentication against the
selected runtime version before applying commands. Never weaken authentication
just to make a page render.

## Select and inventory one canary

Select an authorized test instance from the operator's registry. Record its host,
VMID, guest address, instance ID, instance directory and volumes privately. Confirm
registry metadata agrees with the hypervisor. Do not infer volume contents from names.

Capture before changes:

- `qm config <vmid>`, guest network configuration, container images and health.
- Sizes and ownership of WebUI state, workspace, Workspace state and agent volumes.
- Session counts in the main `state.db`, each profile's `state.db`, session directories,
  and WebUI session store under the configured Hermes home.
- Caddy routes, container-network DNS, gateway and public-route health responses.
- An old session, a profile session and workspace file whose contents can be verified.

Keep credential values out of logs; list environment variable names only.

## Preserve the Hermes home and workspace

Historical WebUI layouts used `/home/hermeswebui/.hermes` for state, profiles,
credentials, browser profiles, cache and agent source, plus `/workspace` for files.
Workspace layouts may use `/opt/data` in the agent, `/home/workspace/.hermes` in
Workspace, and `/workspace`. Verify the actual image contracts. Mount the existing
state into the correct paths or copy it to backed-up new volumes with ownership
preserved. Starting a clean volume can look like lost history even while the old
volume remains intact.

1. Back up every affected state and workspace volume; verify restoration is possible.
2. Use a separate compose override and distinct container names/ports. Keep the
   known-good compose and old containers available.
3. Verify gateway health and authenticated model listing from the Workspace network.
4. Compare session inventories; open old and profile histories, then verify an
   authorized test message appends to the same session rather than a split history.
5. Change only the canary route after state verification. Exercise browser chat,
   refresh, reconnect and rollback before removing any old service.

## Diagnose blank pages without bypassing authentication

Distinguish HTML, static assets and authenticated API responses. A healthy HTML
response does not prove JavaScript hydrated or history requests succeeded. Check
status, content type and browser errors for each failed request.

Older WebUI versions injected a bearer shim; Workspace versions may use a different
authentication contract. If HTML loads but session/history requests return 401,
repair the supported session/cookie/bearer integration. The historical experiment
used an API allowlist, but exposing session/config/chat APIs without authentication
is not a production migration recipe. Preserve authenticated access to history,
config, chat, files, terminal, sidecar, MCP, ACP and browser-control surfaces. Test
both authorized success and unauthenticated rejection.

Public static assets can have a separate route only after verifying they contain
no private data. For JS, CSS, manifest and images, check expected content types
rather than accepting an HTML error page with a misleading successful status.
A browser corruption error can actually be an authentication response in place
of JavaScript. Validate Caddy configuration before reload.

## State ownership and settings writes

If settings reads work but saving returns 500/EACCES, compare the container UID/GID
with preserved volume ownership. Run the new service under the correct identity
or perform a scoped, backed-up ownership migration. Do not make state world-writable.
Verify `id`, write access to the intended config path, the authenticated settings
save/readback, and absence of new permission errors. Use reversible test settings.

## Compose interpolation and route persistence

Before recreation, verify required interpolation inputs exist and are nonempty;
`env_file` and compose `${VARIABLE}` interpolation are distinct. Do not print
secret values with grep. Render compose only into an owner-readable temporary
file because expanded configuration contains secrets, inspect it privately, and
remove it afterward. Recover missing credentials only from the selected instance's
authoritative configuration, not from another tenant.

After every compose operation, re-read the active Caddyfile. A mounted/generated
configuration may restore old upstreams and undo the intended route change. Validate
and reload the selected Caddy service, then repeat HTML, static-asset, authenticated
config/history/chat and protected file/terminal tests.

Use service aliases proven resolvable inside the Caddy and Workspace networks;
long container names may not resolve there. Test DNS and gateway health from the
actual calling container. Route health checks to the service that returns the
expected JSON body; a Workspace HTML fallback is not gateway health. Legacy auth
probes may need a compatibility route while old clients remain supported.

## Session and profile completeness

A capped recent-session list does not establish deletion. Compare the gateway's
reported total, page through the inventory using its supported API, and directly
open a known older session. Verify profile-specific history separately: files can
be preserved on disk while a single-gateway UI fails to expose them. Record that
as incomplete migration, not successful preservation of the user workflow.

## Capacity and management recovery

Check guest free space and Docker disk usage before image pulls. Use reviewed,
pinned images appropriate to the runtime; never switch to floating `latest` or
prune volumes to force a pull through. Preserve all user state.

If the guest agent fails, inspect the management network and selected VM's SSH
configuration. For an explicitly authorized disposable canary, a recovery option
is installing a valid public key with `qm set "$HIVRA_AUDIT_VMID" --sshkey <file>`,
updating cloud-init, and rebooting only that VM. Verify the full key first; a literal
truncated key cannot authenticate. Use the configured bastion for private guests.
If a host key changes, verify its new fingerprint through the trusted management
path before updating the exact known-host entry. Never disable host-key checking
or apply a canary repair fleet-wide.

## Rollback and evidence

Restore the previous Caddy configuration, stop only newly created canary services,
and keep/start the original WebUI, gateway and sidecars. Recheck health and a known
session and workspace file. Do not delete or prune volumes during rollback.

Record before/after inventories, exact image digests, changed compose paths,
route differences, authenticated browser results, negative authorization tests,
rollback result and outstanding profile/history gaps. If data appears missing,
stop migration and inspect volume mapping and `HERMES_HOME` before changing UI code.
