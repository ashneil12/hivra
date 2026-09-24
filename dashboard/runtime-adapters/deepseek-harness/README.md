# DeepSeek Harness native adapter (not enabled)

This directory contains tests and evidence tooling for an **experimental
runtime that no user can launch**. The immutable runtime recipe, broker, service
owner and guest installer live in the versioned `provisioner/deepseek-harness/`
source bundle so the guest gateway can be reviewed as one coherent artifact.
The host launcher and guest installer accept a typed v2 DeepSeek launch, which
only the claim-bound operator harness (`scripts/deepseek-proxmox-canary.ts`) and
the private provider path use. The public catalog keeps the kind unavailable,
so deploying the dashboard or preparing a host cannot install or start it.

The staged gateway reserves native root/RPC paths, requires Hivra bearer
authority for exact computer-management routes, and reports unhealthy until the
private native-cookie exchange is ready. Descriptor-relative file access blocks
private state, credential aliases and link/race escapes. Linux and complete
gateway regressions live beside the broker tests.

## Acceptance so far

- **Live, on a disposable Canary computer, provisioner release `2026.09.02.4`**
  (recorded in `docs/PRODUCT-ARCHITECTURE.md` and summarized in
  `docs/release/VERIFICATION-STATUS.md`): native UI through the computer's
  authenticated Hivra gateway, a real BYOK model reply with the key entered in
  DeepSeek Harness's own settings, a non-root PTY over the public WebSocket,
  restart with a new boot identity (old native session rejected, model reply
  after restart), access revocation and unconditional teardown. The operator
  harness was later pinned to `2026.09.02.8`; this repository records no live
  DeepSeek run on any later release, **including the current bundle**. The
  harness now pins the current Canary release and delivery directory, so it can
  re-run that acceptance (`npm run lab:deepseek-proxmox`, fenced to the Canary
  origin and allowlisted targets).
- **Offline systemd fixture** (`scripts/test-deepseek-systemd-vm.py`,
  GitHub-hosted QEMU, no network): real service stop/restart, detached
  cgroup-member cleanup, retained replay and worker cancellation last passed
  with its payload pinned to release `2026.08.31.4`. It now builds its payload
  from the committed release, so it must be re-dispatched after each sealed
  bundle. It is not model, browser or public access proof.
- **Native session renewal** (this broker revision): proactive renewal before
  cookie expiry and one re-exchange after an upstream 401 are covered by unit
  tests against a fake upstream. Not yet exercised on a live computer.

## Artifact and environment

- Official package: `@deepseek-ai/dsh@0.1.2-alpha.2`.
- Reviewed source: `deepseek-ai/deepseek-harness` at
  `0a53fb55bea101816fa226bb964ae2bed71c343b`.
- `package-lock.json` pins the entire npm closure, including integrity hashes.
  `npm ci --ignore-scripts --no-audit --no-fund` is the tested install. It does
  not execute dependency lifecycle hooks. The staged `install-native.py`
  publishes a root-owned immutable tree, inventories its bytes/modes/links and
  verifies reuse without reinstalling or overwriting custom state. The guest
  installer calls it through `service-owner.py`. The official subprocess shell
  and interactive PTY passed as uid 1000 against that read-only package, and the
  live Canary run above passed a non-root PTY under the service unit. A
  model-driven tool call is not separately recorded.
- The installer can restore only the reviewed Linux-x64 `spawn-helper` execute
  mode after validating its identity. That helper is absent from this Linux
  package; the actual PTY test passes without it or any lifecycle hook. Do not
  extrapolate this to another platform or enable arbitrary npm hooks.
- Tested: non-root Linux amd64, Ubuntu 24.04 / Node 24.14.1; amd64 Docker guest
  on this Mac. Other OS/architecture combinations are unverified.
- The tested loader needs `node --expose-internals` for HMR initialization;
  without it the pinned package exits before web readiness. The supervisor
  passes that flag explicitly without modifying upstream source or suppressing
  a startup failure. This is compatibility work, not a sandbox bypass: arbitrary
  guest code is already part of the agent's authority. The VM/cgroup remains
  mandatory. Upstream's developer-preview and unaudited warnings still apply.
- Runtime libraries need executable storage. The test gives `/opt/hivra`
  an executable tmpfs; temporary files remain on a separate noexec tmpfs.
- These are upstream **downloads**, not vendored runtime bytes. The upstream
  MIT license and each dependency's own notices/terms remain applicable; this
  recipe is not approval to redistribute all third-party packages or images.

## Native access contract

`createNativeBroker` accepts a fixed per-computer HTTPS origin, fixed loopback
port and a synchronous Hivra authorization callback. Re-evaluating that callback
must detect expiry/revocation. All native paths, including static/plugin/SSE
paths that are public upstream, go through it.

The broker captures only the exact owned child's startup line, exchanges its
launch token internally with redirects disabled, and keeps the upstream cookie
in memory. It never forwards Hivra cookies, bearer keys or forwarding headers.
The original public Host/Origin/Fetch Metadata are checked before rewriting
upstream headers. Response cookies and token redirects are not exposed, and
pre-existing management CORS headers are removed.

Native API writes and WebSocket upgrades require the computer's exact HTTPS
Origin. Authenticated initial root document navigation can follow Hivra's
cross-origin bootstrap POST/303; cross-site API and plugin requests cannot.
The native UI occupies the computer origin's root, **not** a `/deepseek` prefix.
When integrating, reserve only explicit Hivra endpoint/method pairs and require
bearer authority for management; do not swallow upstream `/api/*` routes or
reuse native cookies as management authority.

SSE and WebSocket connections are owned and reauthorized once per second.
Revocation aborts both sides; rejected half-open upgrades are bounded and owned
too.

Upstream keeps one launch token for its whole process lifetime (its cookies last
30 days by default). The broker therefore keeps the validated token privately in
its closure (never logged, forwarded or placed in a browser URL) and re-exchanges
it at the fixed loopback destination: proactively inside the cookie's last day
(or the last half of a shorter lifetime), and exactly once after an upstream
401. A 401 clears readiness and stops live native connections; the rejected
request is never replayed, and a 401 answered to a request that carried an
already superseded cookie is ignored. A transient exchange failure retries after
`renewRetryMs`. If upstream refuses its own token, the broker drops it and fails
closed at expiry until the lifecycle owner resets it for a new child. Only fixed
codes (`renewed`, `renewal_failed`, `renewal_refused`, `upstream_unauthorized`)
reach the gateway journal. A long-running computer keeps its native surface
without the unit restart that would end in-flight agent work.

## Process ownership and limits

`startRuntime` requires a private, canonical, owner-only HOME and a non-root
Linux process. It creates a per-computer `DSH_HOME`, drops inherited credentials
from the child environment and sets `DSH_TELEMETRY_DISABLED=1`. Native Models
credentials therefore remain editable instead of being shadowed by environment
keys. Raw stdout/stderr are suppressed; only fixed diagnostic categories can
appear in startup errors.

An in-process lease fences broker, home and port through startup and leader
shutdown. The actual service owner must also serialize across supervisor
processes. A pre-cancelled launch has no side effects; startup cancellation and
deadlines run owned leader cleanup before returning an error.

**`stop()` is not complete descendant teardown.** It stops the leader process
group and checks the loopback listener; upstream tool processes can detach into
other groups. Its receipt explicitly returns `descendantCleanupVerified:false`.
Production guest integration must stop and prove absence of the immutable owned
systemd cgroup (or entire disposable VM/container) before lifecycle completion,
lease release at the control plane, deletion or recovery. Do not use this helper
alone as a standalone launch/lifecycle API. The smoke runner proves complete
teardown by deleting and inventory-checking its exact owner-labelled container.

The `service-owner.py`, `install-guest.py` and DeepSeek-specific
`bux-hivra-chat.service` template are bundled since `.31.2` and composed by the
typed v2 guest path (operator harness and private provider path), **not enabled
in the catalog**. They verify the exact disk
and loaded definition (including `NeedDaemonReload=no`), finite control-group
stop settings, non-root supervisor membership and stable invocation identity.
Stop acceptance requires idle jobs, zero unit PIDs, empty cgroup v2 and closed
listeners. Tests model real systemctl empty `Job=` and omitted absent-unit
`ExecStart` output. These are filesystem/protocol fixtures, not live systemd
acceptance. The caller retains the existing installation/operation lock while
stopping, publishing immutable assets and verifying a new generation. Replays
do not rerun the mutable base bootstrap. Conflicting configuration/package/
gateway/unit bytes and changed browser intent require explicit repair.

The template does not add blanket namespace/proc/network/JIT restrictions or
change the existing sudo-based browser helper contract. Its receipt therefore
does **not** claim that work submitted to other guest services is gone. Complete
computer cleanup remains the VM lifecycle's responsibility.

## Verification

From `dashboard/`:

```sh
node --test --test-timeout=15000 runtime-adapters/deepseek-harness/*.test.cjs
npx eslint runtime-adapters/deepseek-harness/*.cjs scripts/test-deepseek-native-runtime.mjs
```

For actual-package acceptance, provide an already present, trusted Linux amd64
image with Node 24, npm, Python 3, setpriv and glibc. The runner requires its
exact image ID, refuses implicit pulls, publishes no ports and mounts only this
recipe read-only. It downloads the locked public npm closure. Output must be a
new absolute directory; it never overwrites an earlier receipt.

Only the disposable package-preparation phase uses container root. The container
has a read-only base filesystem, no host namespaces/devices/socket, and only
SETUID/SETGID capabilities to drop to uid/gid 1000 for every runtime check. It
does not run a root agent. Both phases use clean environments and no real keys.

```sh
node scripts/test-deepseek-native-runtime.mjs \
  --image sha256:<full-existing-local-image-id> \
  --output /absolute/new-evidence-directory
```

The receipt hashes every adapter file and the runner, records image/container
identity, verifies immutable install/reuse, actual shell/PTY, native HTML, write-only synthetic credential storage,
0600 permissions, restart persistence, native WebSocket/SSE and revocation, and
unconditionally removes the exact owned container. No real model key is used.
`PASS` means this **local component smoke** passed, never public enablement.

## Remaining public-enable gates

1. **ACP lane.** Handshake, operation and revocation inside the same computer
   boundary. Not accepted; this is the gate the public catalog waits on.
2. **Typed BYOK delivery.** Hivra's launch accepts no model credentials for this
   kind, so neither a saved key nor Hivra credits reach it. Today the key is added
   in DeepSeek Harness's own settings on the computer.
3. **Owned runtime updater.** `hivra-update-guest-runtime.sh` refuses DeepSeek
   computers. A bundle fix, including the session renewal above, reaches only
   newly launched DeepSeek computers.
4. **Gateway/runtime unit split.** The gateway spawns the runtime inside one
   `bux-hivra-chat.service` control group (`KillMode=control-group`), and an
   unexpected runtime exit stops the gateway. Any gateway restart therefore ends
   in-flight agent work. The detached chat-run lane does not apply: DeepSeek's
   native routes are not the Hivra chat surface.
5. **Re-acceptance on the current release** through the public connection path:
   native UI, model reply, restart, cancellation, failed install, expired access
   and full cgroup/VM teardown, then public catalog and provider dispatch.

Buzz connection, Omarchy image and remote-desktop latency acceptance are separate
work; none is implemented or proven by this adapter.
