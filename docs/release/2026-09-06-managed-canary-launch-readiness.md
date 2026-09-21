# Managed Canary launch readiness and safe bundle swap

## Reproduced launch failure

On Canary dashboard source `3d8900224`, the logged-in root-path Mac app's
Agents → Deploy Agent → Claude Code journey submitted `CANARY_CLAUDE_0906`,
2 CPU / 4 GB with browser enabled. It returned the host-preparation error;
no agent row was created. No Anthropic credentials or model billing were added.

The actual `node-b` Canary bundle was `2026.09.05.5`, while current fresh-launch
admission requires `.10`. The exact provision-purpose readiness script returned
exit 1, `Hivra provisioner version mismatch`. This is rollout drift, not a
reason to weaken version admission or repeatedly submit the launch.

## Source repair before operational sync

Source `3e217cddb` corrects an independently identified failure window in the
existing managed bundle sync helper. EXIT-based rollback now covers both
renames, signals, readiness and preservation validation. The original backup
is a distinct child of its reserved parent, not an empty directory mistaken
for a completed rename. Directory device/inode identity and GNU non-merging,
no-clobber moves protect staged content and preserve foreign replacement
targets for reconciliation. SIGKILL and host loss still require inspection;
automatic recovery from them is not claimed.

Independent reviewer `core_gap_map` identified the interruption and foreign
target gaps, then found no remaining P1/P2 in the bounded correction. It did
not perform live mutations. Local checks: 48 sync/readiness/channel tests,
scoped ESLint and full TypeScript passed. The sync suite's 19 tests also passed
with real GNU/Linux tools, including 12 filesystem swap/failure cases.

Linux acceptance used already-present image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
network disabled, pulling forbidden, read-only image, disposable Linux tmpfs,
and no host mounts. Containers used `--rm`; fixture directories were removed.
Earlier attempts are not acceptance: one image lacked Bash; a JS replacement
escaped the signal PID incorrectly; a macOS shared-folder run translated
inodes during restore. The final checks use real TERM signals and Linux tmpfs,
without weakening identity assertions or accepting a generic failure exit.

## Exact live sync and preservation

Only `/root/hivra-provisioner-canary` on SSH host `node-b` was updated. All 48
assets matched the sealed `.10` manifest bytes and SHA-256. No immutable bundle
asset was edited by this fix. The live wrapper added source-reader checks under
the existing allocation lock, root-owned non-symlink path checks, and exact
default-bundle, VM and Caddy preservation checks while rollback remained active.

Wrapper: `/tmp/hivra-canary-sync-0906.1lTIrx/sync.cjs`.
Executed script SHA-256:
`dc662161eb225e2b683eee00883eecae44302a957b00a376a6aaf03b2c9e6c1a`.
One wrapper preflight failed on a NUL separator before swapping; `.5` and the
shared-default fingerprint were rechecked unchanged before correcting that
wrapper and executing the sync. Final execution returned status 0 at 01:10 UTC:

- No Canary source readers observed in process arguments, environments or open
  file descriptors; no in-flight Canary provision/update row was observed.
- VM counts `30/20/50` and full `qm list` SHA
  `6bcd71708f0374d062cd039a8957e635efa8539fe653739a40fe5631939d66cf` preserved.
- Caddy active before/after; `/etc/caddy` file-content fingerprint
  `ce4fc539496e362ddab5064a8da748b628a495fb3646e419304208185da4046e` preserved.
- Shared-default bundle integrity passed before/after. Its manifest SHA
  `6e71628f396712e77aaf2598c929c5f7472dedd16f5a57e28a10cb04c3fc0e63`
  and VERSION mtime `1788566972` remained unchanged (`.04.4`).
- Storage total/used/free `870318080/558744207/311573872` unchanged.
- Separate **provision-purpose** readiness returned `HIVRA_HOST_READY` exit 0.

The `.5` rollback copy remains at
`/root/.hivra-provisioner-canary-rollbacks/2026.09.05.10.nJMnzNId/original`.
No existing guest was updated or restarted. The source helper was executed
locally for this scoped operation; a new dashboard deployment is not claimed.

## One normal-UI retry

After readiness passed, the same form was submitted once. It created owned
agent `00000000-0000-4000-8000-000000001128` at
`2026-09-06 01:11:14.739801+00`, channel `canary`, type `claude-code`.
The allocation bound VM 1130 / `10.240.20.80`, 40 GB disk
`local-lvm:vm-1130-disk-0`, with binding tag
`hivra-bind-396f8c3ead42d4a67c9845792951dbd5` and operation tag
`hivra-op-4caf26c43f3141cdaf58e2cbe3dab51a`. The page advanced without refresh
to Setting up, then Running and the actual native terminal. The installer PID
3648997 was observed running during that wait, not merely inferred from a lock.

Claude Code initially rendered `v2.1.246`, with `Not logged in · Run /login`.
No login, model reply or paid inference is claimed. The separate Box Terminal
accepted a command as `bux`, UID/GID 1001, which created only
`/home/bux/canary-claude-0906/proof.txt`. Files opened that folder and displayed
`HIVRA_CLAUDE_PERSIST_OK`. Its 24 bytes and SHA-256 matched an independent local
calculation:
`8850c67531625d9cb90e6151443a5db5151758f2784ddc717e4f27eaa3d81da2`.

Used normal Manage → Restart (not Update & Restart). The page showed Restarting
then Running automatically. Reopened the public Box Terminal: the hash remained
identical and boot identity changed from
`00000000-0000-4000-8000-000000001129` to
`00000000-0000-4000-8000-000000001130`. Claude's native terminal also returned,
now reporting `v2.1.261` and its own automatic-update notice. That native
self-update is observed version drift, not a Hivra runtime update performed by
this test or a pinned-version acceptance result.

Browser rendered Chrome through encrypted noVNC, but showed the existing
`--no-sandbox` warning and a restore-pages prompt after reboot. The Mac native
keyboard attempts did not reliably replace its address bar; they navigated to
an invalid URL and then an unintended Google search for URL text. No account
data was sent, no cookies imported, and no Google consent accepted. The test
Ctrl toggle was toggled off before leaving. Browser rendering is proven;
reliable Mac-to-Linux modifiers, exact navigation and sandbox security are not.
Do not classify this as an end-to-end browser-input pass.

## Cleanup acceptance

Before the 01:25 UTC deadline, normal Manage → Destroy, confirmation checkbox
and exact name removed **only** `CANARY_CLAUDE_0906`. The UI returned to Home
with the original four computers and two agents, all Running. Read-only checks
by 01:24 UTC confirmed:

- Agent tombstone `status=deleted`, `vmid=null`, API token and tunnel reference
  cleared, active operation ID/kind null.
- `qm status 1130`: configuration absent; `pvesm list local-lvm --vmid 1130`:
  no volumes; original installer PID file absent.
- The owned public hostname returned no DNS answer.
- Full `qm list` hash returned to the pre-test value above; Caddy's complete
  file fingerprint and active state matched the pre-test baseline.
- Shared-default manifest hash and VERSION mtime unchanged; Canary remains `.10`.

The VM and disposable marker are irreversibly erased. No retained computer,
existing login or user file was targeted. The external Cloudflare tunnel object
was not separately enumerated; DNS removal and the erased persisted reference
are the evidence here. Never target historical VM numbers: old test number
1125 is now occupied by an unrelated machine.

PASS for the scoped host-readiness repair, native launch, shell/Files access,
restart persistence and observed cleanup. The source rollback fix is committed
and was used for the live sync; its code is not yet in a new Vercel deployment.

No Hetzner purchase/reservation; cumulative campaign reservations remain
GBP 5.90 / GBP 10, not invoices. This does not close whole-catalog, inference,
Windows, Omarchy, native monitor-unplug or full-goal acceptance.

## Subsequent Canary dashboard release (06 September, 01:33 UTC)

The earlier dashboard-release gap above is now closed. Clean archive source
`6a52696d5c065a772dcdb513e26ffda2e250c740` built Ready as
`dpl_DH7TrdgwaQg9kmstSCZgLYF99GXn` in **hermesos-canary**, then was explicitly
promoted. Vercel inspection of `https://canary.hermesos.cloud` resolves to that
exact deployment, `hermesos-canary-fxwnua74s-ashneil12s-projects.vercel.app`.
The actual production project was not deployed. Previous Canary rollback:
`dpl_ERAD1PFRkhaYRmBhwtVwvj6naPQM`.

The authorized public operator endpoint was called with explicit target `node-b`
and `apply: false`. It returned HTTP 200, `ok: true`, channel `canary`, requested
and observed version `2026.09.05.10`, and `changed: false`. This verifies the
deployed read-only host inspection; the mutation branch was not re-exercised
merely to test deployment. Its prior live execution and regression evidence
remain recorded above.

In the logged-in root-path Mac app, native Refresh returned the original four
computers and two agents, all shown Running. Normal Computers → Launch Computer
rendered the OS picker; selecting Ubuntu visibly selected its card. Omarchy and
Windows remained disabled with explicit readiness explanations. No launch was
submitted and no desktop session, VM, paid resource or credential was created.
This is a post-release UI sanity check, not another provisioning acceptance.

The Mac wrapper has no keyboard-event overrides in the inspected source. The
earlier noVNC modifier uncertainty therefore remains undiagnosed; no speculative
keyboard patch or browser-input pass is claimed. All broader acceptance limits
above remain open.
