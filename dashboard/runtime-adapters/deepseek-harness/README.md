# DeepSeek Harness native adapter (not enabled)

This directory contains tests and evidence tooling for an **uninstalled
experimental component**, not a launchable catalog entry. The immutable runtime
recipe and broker now live in the versioned `provisioner/deepseek-harness/`
source bundle so the guest gateway can be reviewed as one coherent artifact.
The public catalog, strict guest launch schema and existing installer still do
not accept this kind. Merely deploying the dashboard or preparing a host cannot
install or start it.

The staged gateway reserves native root/RPC paths, requires Hivra bearer
authority for exact computer-management routes, and reports unhealthy until the
private native-cookie exchange is ready. Descriptor-relative file access blocks
private state, credential aliases and link/race escapes. Linux and complete
gateway regressions live beside the broker tests. This is integration progress,
not real reply, browser, ACP, service-cgroup or public-origin acceptance.

## Artifact and environment

- Official package: `@deepseek-ai/dsh@0.1.2-alpha.2`.
- Reviewed source: `deepseek-ai/deepseek-harness` at
  `0a53fb55bea101816fa226bb964ae2bed71c343b`.
- `package-lock.json` pins the entire npm closure, including integrity hashes.
  `npm ci --ignore-scripts --no-audit --no-fund` is the tested install. It does
  not execute dependency lifecycle hooks. The staged `install-native.py`
  publishes a root-owned immutable tree, inventories its bytes/modes/links and
  verifies reuse without reinstalling or overwriting custom state. It is **not
  yet bundled or called by the guest installer**. The official subprocess shell
  and interactive PTY passed as uid 1000 against that read-only package. They
  have not passed under the future service unit or through a model tool call.
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
too. An upstream 401 clears readiness without replaying the request. Cookie
expiry remains fail-closed: the lifecycle owner must explicitly reset the broker
and perform a fresh private exchange; no implicit write replay or token in a
browser URL. Tests cover explicit expiry recovery.

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
`bux-hivra-chat.service` template are bundled in `.31.2` and composed by the
private typed provider-VM guest path, **not enabled in the catalog or installed
on an accepted live guest**. They verify the exact disk
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

1. Versioned guest bundle, pinned worker/receipt compatibility and cgroup lifecycle.
2. Existing Hivra native bootstrap + root routing in a real authenticated browser.
3. Typed runtime-bound BYOK delivery, actual model reply and native tool execution.
4. ACP handshake/operation/revocation inside the same computer boundary.
5. Restart, cancellation, failed install, expired access and full cgroup/VM teardown
   through the public connection path on the exact deployed revision.

Buzz connection, Omarchy image and remote-desktop latency acceptance are separate
work; none is implemented or proven by this adapter.
