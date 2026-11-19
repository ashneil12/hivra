# Prepared Omarchy refresh rollout

New prepared claims are paused. An unassigned slot, a deleted claim, and a
missing binding tag are not evidence of a clean guest. The claim endpoint can
only return an existing eligible claim to the same operator; it does not
reserve, start, or rebind a guest. Existing Omarchy reservations can still
finish their refresh, and refresh is not a reset. Never reuse an existing
customer's slot as a disposable acceptance fixture.

## Compatibility and order

1. Review the dashboard change and run the focused refresh, prepared-computer,
   recovery and purge suites, TypeScript, and the PostgreSQL migration harness.
2. Apply `20261103010000_prepared_omarchy_refresh.sql` to the explicitly approved
   environment. It adds the private operation table, RPCs, guards and public
   initial-release receipt column. Existing rows are unchanged. The legacy status normalizer retains dedicated
   prepared-refresh failure leases; its behavior for ordinary operations is preserved.
3. Merge through the public repository Git release path. Verify that the exact
   merge revision holds the Canary alias before testing.

The migration deliberately refuses an older dashboard's direct Omarchy
insertion. Existing owner opens remain supported. An existing reservation is a
real `provisioning` row and consumes a paid owner slot; a 202 response is not
admission to Desktop.

## Acceptance

When a trusted clean reset or rebuild makes new claims possible, verify the
claim flow on a separately authorized, empty, owner-controlled prepared slot in Canary,
with its exact host/node/VMID/IP/name/claim configured. Record its original VM
state and owner rows, expected release pin, operation ID, all created artifacts,
and cleanup plan before claiming through the normal launch API/UI.

Verify the official stable release resolved for this reservation; the pending
row and immutable operation survive a dropped HTTP request; polling resumes the
same job; a second owner cannot claim the slot; and Desktop is unavailable while
updating. After completion, check the stored package/OS/kernel observation and
changed boot ID, then exercise a rendered desktop and actual input. Services and
receipts alone do not establish browser acceptance. Check a completed existing
owner open does not dispatch another update or query upstream.

On a disposable fixture, cancellation must retain the reservation while the
updater runs, fence future dispatch, release only that binding tag after updater
quiescence, and mark the row deleted without destroying the prepared VM. Verify
cleanup using exact operation receipts and retained backups, not absence of the
HTTP client.

Deleting a settled prepared claim (Windows or Omarchy, no refresh in flight)
follows the same rule: under the slot's VM lock Delete removes only that claim's
binding tag and keeps the prepared VM. The guest remains unavailable for new
claims until a trusted reset or rebuild can be verified. Delete refuses a VM whose
identity is not the configured slot or that carries another claim's binding, and
a retry after the tag is gone succeeds unchanged.

## Failure and rollback

Updates have root Snapper, read-only home, `/boot`, `/etc`, and package-list
backups under the guest's operation directory. The native package/migration job
has a 25-minute runtime bound; termination or uncertain guest state never grants
Desktop access or releases the slot. Failed operations keep their owner row and
require inspection; no automatic repeated upgrade is attempted. Unknown or
changed reviewed system migrations fail closed.

Host receipts and logs live at
`/var/lib/hivra/prepared-omarchy-refresh/<operation-id>/`; the guest retains the
same operation path and backups. Requests must keep their original release pin
and program manifest. Do not edit those manifests to make a retry succeed.

Prefer a forward fix. If reverting dashboard code, retain this migration and
its guards. Do not restore a dashboard that can assign retained guests without
verifying a trusted clean reset or rebuild.
Do not drop the operation table/guards, clear leases, delete reserved rows,
remove binding tags, or restore snapshots while an updater may still be active.
First prove the exact guest unit is stopped and the cancellation fence is set,
then use the scoped cancellation path or a reviewed operator recovery. Restoring
root alone is insufficient: `/home` and `/boot` are separate backup surfaces.
Production promotion remains a separate owner-approved release step.
