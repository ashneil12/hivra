# Provisioner provenance

This directory is the versioned source for Hivra's portable Proxmox runtime.
It was recovered from the active canary provisioner on `fixturenodea` on 2026-08-26,
before portable-path changes were applied. The imported files were checked for
private-key blocks and common committed-token formats; none were found.

The managed host remains runtime evidence, not the source of truth. Changes to
this directory must bump `VERSION`, pass the provisioner contract tests, and be
installed through the explicit host-preparation operation.

Release `2026.08.27.1` adds explicit guest-substrate selection and rejects
unknown runtime names and unsupported architectures before package work. It
does not change any upstream artifact pin below. Its Proxmox lifecycle ABI is
compatible with the reviewed `2026.08.26.10` release; the control plane records
the observed installed version rather than relabeling it as the current one.
Neither the dashboard release nor that compatibility declaration installs a
bundle on an existing host. New provider-VM preparation still needs separate
end-to-end acceptance.

Release `2026.08.27.2` changes only the host's initial SSH/cloud-init readiness
gate: noninteractive, individually bounded probes, a monotonic total deadline,
and explicit completion/error handling before guest installation. It retains
the Proxmox lifecycle ABI of both preceding reviewed releases and all artifact
pins below. This source release does not update installed hosts or guests.

Release `2026.08.27.3` moves native terminal setup from the Proxmox host into
the shared guest installer. It includes the agent-shell helper and both terminal
unit configurations in the explicit bundle, uses the agent user's HOME/PATH,
and checks each loopback terminal before success. A missing selected CLI or
invalid runtime now produces a repair error instead of silently launching
Claude Code. No upstream artifact pins or Proxmox lifecycle ABI change; exact
`.26.10`, `.27.1` and `.27.2` installations retain their observed versions and
are not upgraded by dashboard delivery.

Release `2026.08.27.4` introduces `hivra-install-agent.py`, the synchronous guest
entrypoint used by the Proxmox provisioner and available in the provider bundle.
It accepts a strict stdin document, preserves the selected runtime and substrate,
and runs the existing installer. Named-tunnel configuration is now shared guest
code: exact private files, no credential in argv, no unrelated process kills,
and no implicit replacement of existing credentials or custom systemd overrides.
The host still owns allocation, public health verification and result receipts.
Installer replay reads the pinned bux checkout as its existing root or bux
owner; it does not disable Git ownership checks or change global safe-directory
settings. Unexpected, mixed or symlinked checkout ownership is rejected.
The mutable existing installer is never rerun as root. An incomplete base,
including dashboard-only runtimes that removed coding CLIs, requires trusted
base repair; generic reinstall support for those cases is not claimed here.
The named-tunnel restart has a 195-second client bound for Ubuntu's observed
90-second stop and start budgets; read-only and other service commands retain
their 15-second limits. It does not retry a restart after an uncertain timeout.
All upstream pins and the Proxmox lifecycle ABI are unchanged; `.27.3` remains
an explicitly accepted predecessor. No installed host or guest is upgraded by
this source change, and provider launch/lifecycle activation remains gated.

Release `2026.08.28.1` adds the private provider-VM installer worker. It uses
the existing agent provision identity, fixed guest paths and once-only dispatch;
start/status/cancel are not a new agent lifecycle. The installer is a bounded
systemd service with cgroup cleanup, a suspend-aware guest deadline, private
stdin/log files and an irreversible cancellation journal. A stopped receipt
requires process/cgroup and execution-lock evidence; missing acknowledgements
or an elapsed deadline alone are not completion. The shared runtime installer
and upstream pins below are unchanged. `.27.4` remains an accepted Proxmox
predecessor; dashboard delivery does not install this worker on existing hosts.
The public provider launcher, operation-owning caller and real Linux/provider
acceptance remain separate gates.

Release `2026.08.28.2` adds atomic, authenticated Codex/Venice guest model-setting
receipts and rejects malformed legacy clears. Interrupted private writes are
reconciled with bounded cleanup; saved receipts fence the old direct-write path.
This is guest capability, not completed control-plane credential delivery or
model-inference acceptance. The original native interfaces, runtime catalog,
upstream pins and Proxmox lifecycle ABI are unchanged. Provider worker recovery
retains the exact `.28.1` recipe and adds a separately pinned `.28.2` recipe.
Dashboard delivery does not upgrade existing hosts or guests.

Release `2026.08.28.3` fixes the live provider install failure caused by the
private worker's inherited `077` umask. Only a newly created public bux checkout
and fixed, secret-free public package commands use a subshell with `022`.
The public installer receives a clean environment and a literal dummy browser
key; model, Telegram and tunnel credentials are not inherited. Private worker
journals, launch payloads, model files and tunnel configuration retain their
existing modes. Existing user-customized checkouts are not chmodded or rerun.
The NodeSource signing-key fingerprint, upstream hashes and catalog stay pinned.
Both older provider worker recipes remain available with their original hashes.
This release does not upgrade existing computers or claim live acceptance.

Release `2026.08.28.4` uses the Responses protocol required by pinned Codex
0.149.1 for alternative Venice providers. Credentials remain in per-spawn
environment variables, not argv or a rewritten Codex config. Provider-side web
search and WebSockets are disabled on this connection; managed Responses only
meters text and client-executed tools. Existing native vendor sign-in is unchanged.
Older bundle and worker identities remain available for lifecycle/recovery.
This does not update existing computers; new preparation installs the new bundle.
Model configuration is not evidence of a successful model response.
The authenticated provider summary advertises `responses-v1`; older guests
without that capability remain eligible for lifecycle recovery, not Chat readiness.

Release `2026.08.29.1` adds an explicit, owner-triggered connection-service
update for existing Proxmox computers. The host streams only the four reviewed
Hivra Chat assets into the bound running guest, keeps a root-only rollback copy,
validates JavaScript before installation, requires `post-cookie-v1` readiness,
and proves the box API token and agent-kind identity did not change. The normal
provider-operation journal and lifecycle lock fence the subsequent reboot.
Agent files, native CLI credentials, model credentials and browser data are not
part of the update. Existing provider worker recipes remain pinned; a new
`.29.1` recipe admits only the new exact worker bytes. Provider-VM in-place
updates remain unsupported and fail closed rather than claiming an update.

Release `2026.08.29.2` records a private, deterministic installed-runtime
receipt after every runtime-specific readiness gate. The receipt inventories
the exact Debian package/source versions and Debian copyright-file hashes,
global npm package identities and declared licenses, selected Git checkout
state, pinned Agent Zero image identity, Hivra service states, binary version
outputs and installed Hivra asset hashes. It deliberately excludes credentials,
process environments and command lines, user files, browser profiles and agent
state. Receipt generation and checksum verification are part of provisioning;
failure stops the install instead of advertising incomplete evidence. The
receipt remains installed-state evidence with explicit legal/source gaps, not a
release, vulnerability or redistribution approval. Existing `.29.1` computers
are not relabeled or changed by this source release.

Release `2026.08.29.3` fixes operating-system identity in that receipt without
weakening its no-follow file safety. Ubuntu exposes `/etc/os-release` as a
symlink, so the collector now reads the canonical regular
`/usr/lib/os-release` first and retains a regular `/etc/os-release` fallback for
other distributions. The private verifier now fails closed unless both `ID`
and `VERSION_ID` have safe, non-empty values. No package, runtime, credential,
user file, model setting or existing computer is changed by this source release.

Release `2026.08.29.4` derives two deterministic private review artifacts from
that byte-bound installed-state receipt: a CycloneDX 1.6 SBOM and an exact
notice/source-review manifest. The SBOM covers observed Debian packages, global
npm packages, selected Git checkouts, container images, Hivra files and important
binaries. The notice manifest binds Debian copyright-file hashes, npm declared
licenses and root license/notice-file hashes to the source receipt and preserves
every unresolved gap. All six evidence/checksum files are root-owned mode 0600;
provisioning fails if any checksum is invalid. The fixed operator verifier
requires safe files, exact cross-document receipt binding, inventory/count
agreement and `releaseApproved: false`. This produces review evidence; it does
not generate complete license texts, source offers, vulnerability approval or a
public-release decision, and it does not mutate existing computers.

Release `2026.08.29.5` corrects the installed Debian inventory on provider
computers. `dpkg-query -W` legitimately reports `rc ` rows for packages whose
payload was removed while configuration files remain; those rows are not
installed components. The collector now validates every dpkg status triplet,
excludes non-`ii ` rows from the receipt/SBOM, and continues to fail closed on
malformed or duplicate installed-package evidence. No dependency pin, runtime
binary, credential, or previously recorded receipt is relabeled by this source
release.

Release `2026.08.30.1` replaces the shallow global-npm-root inventory with a
bounded recursive walk of each selected runtime's installed `node_modules`
tree. Every regular package is bound by name, version, manifest hash, install
scope and absolute in-guest install path; nested duplicate versions therefore
receive distinct CycloneDX component identities. Symlinked packages, missing or
invalid manifests, and inventories above the fixed safety limit fail closed.
Receipt schema 2 explicitly records `recursive-node-modules-v1` and
`dpkg-installed-v1` completeness classes. This closes silent omission of nested
npm dependencies; exact license-text and source-obligation review remains a
separate release gate.

Release `2026.08.30.2` removes the hosted Cloudflare credential dependency
from standalone provider-computer launch. In local-auth mode, the control plane
journals the computer's already verified public IPv4 as an exact
`https://<ipv4-with-dashes>.sslip.io` origin before guest mutation. The guest
then installs the pinned Caddy binary, retains its upstream Apache-2.0 license,
and runs a fixed reverse proxy from ports 80/443 to the loopback-only Hivra
surface. Hosted mode retains the existing named Cloudflare tunnel contract.
The guest parser requires exactly one access mode, runtime and power probes bind
the expected access service, and the provider firewall admits only key-auth SSH
plus HTTP/HTTPS. No Hivra account, domain, Cloudflare token, ambient host, retry,
or replacement server is adopted. The installed-state receipt inventories the
Caddy binary and license during install, then refreshes its access artifacts
and service observations only after the exact Caddy unit is active. The refresh
requires the preceding receipt checksum and original runtime/version/substrate;
package and image provenance is preserved. Public readiness remains a separate
authenticated, no-redirect check. Existing SSH-only named-tunnel computers retain
their exact lifecycle and cleanup policy; direct access requires all three
reviewed ingress ports. This source change does not modify installed computers.

Release `2026.09.01.1` adds an explicit post-provision remote-computer profile.
It installs the pinned Selkies X11 OCI image inside a dedicated Docker bridge,
publishes its upstream only on guest loopback, and places a separate unprivileged
broker between the browser and Selkies. A one-time PKCE handoff is delivered by
exact-origin `postMessage`; the exchanged bearer remains in a mode-0600 guest
state file and is never returned to the browser, put in a URL, or forwarded to
Selkies. The broker re-authorizes live WebSockets, serializes one controller,
terminates and acknowledges input release after revocation, and keeps clipboard,
files, microphone, camera, gamepad and upstream commands disabled by default.
The desktop workspace uses one explicit guest bind directory; no Docker socket,
host network or privileged container access is granted. This release is an
experimental Selkies WebSocket profile, not WebRTC WAN acceptance, Omarchy,
Windows/macOS guest support, or a public catalog enablement. Existing computers
are unchanged until the explicit guest profile operation is run.

Release `2026.09.01.2` bounds the remote-computer profile's host-side output and
replaces inherited Docker/package progress with fixed, non-secret stage receipts.
Installer failures identify only the reviewed failed stage and never echo command
arguments, bearer material or registry progress through the SSH control channel.
The Selkies image, isolation policy, remote-session protocol and public catalog
status are unchanged. Historical `.09.01.1` worker and native identities remain
available only for their original lifecycle and recovery operations.

## Reviewed upstream pins

Every network-fetched artifact used by the portable installer is listed here.
The shell sources remain the executable source of truth; this inventory exists
so a reviewer can reproduce the exact download and integrity checks without
inferring them from a live host.

- Ubuntu 22.04 Jammy cloud image:
  `https://cloud-images.ubuntu.com/releases/jammy/release-20260807/ubuntu-22.04-server-cloudimg-amd64.img`
  - SHA-256: `ff271290a23279ce764561dbe2e9c3ec29da899535b571a987c37b47970c2ad9`
- Browser Use bux: `https://github.com/browser-use/bux`
  - commit: `f17c1b31d6688dd92e745ade650e00d46b4dc4da`
- Aeon dashboard: `https://github.com/aaronjmars/aeon.git`
  - commit: `8b8d719715ec9bb68fb858a1e334d23209047d82`
- Cloudflare Tunnel (`cloudflared`) Linux amd64:
  `https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-linux-amd64`
  - version: `2026.8.2`
  - SHA-256: `fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2`
- Caddy Linux amd64:
  `https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz`
  - version: `2.11.4`
  - SHA-256: `527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9`
  - upstream license: Apache-2.0 (`LICENSE` retained at `/usr/share/doc/hivra-caddy/LICENSE`)
- Google Chrome stable Linux amd64:
  `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_157.0.8103.50-1_amd64.deb`
  - package version: `157.0.8103.50-1` (shipped as `chrome-pin.json`, which the installer and the runtime update both read; the build it replaced, `152.0.7977.64-1`, SHA-256 `4eae0736a812d9bc851cd2937f7af00e47dbaf8305845eed452703ff009873c7`, stays in its `previous` list so an existing computer can be put back)
  - SHA-256: `92148bd14dc05823a64061c2fafcf20d4d82b3fc56f5831206f16d2ac9ee3f79`
- GitHub CLI Linux amd64:
  `https://cli.github.com/packages/pool/main/g/gh/gh_2.98.0_amd64.deb`
  - package version: `2.98.0`
  - SHA-256: `f65a3fa2fa0eb2e97c445ee3f5e087a40aae03b64847f45a8f13805e504535d6`
- Anthropic Claude Code npm package: `@anthropic-ai/claude-code@2.1.292`
- Anthropic Claude desktop app for Linux (optional, owner-initiated):
  `https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_2.26454.0_amd64.deb`
  - package version: `2.26454.0`
  - SHA-256: `6d3e4973dcb11511ddd962040b3073b435d1592b3174a82ef52e50377a75a63f`
  - size: 180809792 bytes
  - proprietary Anthropic software, downloaded from Anthropic's repository and never bundled or redistributed by Hivra
- OpenAI Codex CLI npm package: `@openai/codex@0.149.1`
- OpenClaw npm package: `openclaw@2026.6.10`
- Agent Zero OCI image:
  `agent0ai/agent-zero@sha256:d8fd86114b02e9b4b6f14ef6f696b1ba7af46e52327734bb8a77f7aaf8556cf0`
- Selkies X11 desktop OCI image:
  `ghcr.io/selkies-project/selkies-egl-desktop@sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa`
  - observed source commit: `dbc97872dbeae49e7f1e4491c3dee54f437f364d`
  - upstream license: MPL-2.0
  - observed amd64 runtime identity: `Config.User=1000`, named user/group
    `ubuntu=1000:1000`, entrypoint `/etc/container-entrypoint.sh`, no command,
    working directory `/home/ubuntu`

Release `2026.08.31.1` adds the Hivra-authored descriptor-relative file disclosure
guard to the existing guest gateway and its updater. It also stages the native
DeepSeek broker and root-routing policy in this source bundle. The strict launch
schema, installer and public runtime list still reject DeepSeek; preparing this
bundle does not install the package or start its native service.

The staged DeepSeek download recipe pins `@deepseek-ai/dsh@0.1.2-alpha.2` and its
complete registry/integrity-locked npm closure in `deepseek-harness/package-lock.json`.
Reviewed upstream source is `deepseek-ai/deepseek-harness` at
`0a53fb55bea101816fa226bb964ae2bed71c343b`. No upstream runtime binaries or
`node_modules` are vendored here; installation/distribution notices and complete
guest acceptance remain separate requirements. Package-only proof is recorded
in `docs/release/VERIFICATION-STATUS.md` at repository root.

Release `2026.08.31.2` composes the pinned package, immutable gateway, fixed HTTPS
origin and owned service in the shared guest installer. Its **private v2** path
is provider-VM-only and accepts no launch-time model credentials. The existing
public controller/catalog and Proxmox host launcher still select only the five
accepted runtimes; DeepSeek is not enabled. Initial native Models setup, public
browser/reply/ACP proof, real systemd recovery and outer cancellation reconciliation
remain release gates. The package and service files are now bundled, not silently
added to the immutable `.31.1` release. Guest package/state installation is never
performed merely by a dashboard deployment or bundle download.

Release `2026.08.31.3` adds private Python worker-v2 cancellation support. Its
immutable identity binds a DeepSeek-only cleanup profile and the complete
stop-controller closure. Before dispatch it retains the exact worker, service
owner, its file-check dependency and unit template in the original operation's
root-owned private journal. It fences queued work and verifies installer exit
before explicit cancellation invokes that retained service owner under the guest
installation lock. Native cleanup is separate from the immutable install outcome.
Cancellation disables only the exact owned unit before verifying its stop.
Immutable cleanup proofs are boot-bound; a prior boot's proof is pending until
explicit re-verification. Cached proof also requires current owned, disabled,
empty native-service state under the lifecycle lock, without mutation on status.
Drift, custom services, unknown state or failed cleanup do not emit a successful
native-stop receipt. The TypeScript dispatch/store and database identity protocol
still accept v1 only: this is a staged worker contract, not public DeepSeek launch
or end-to-end provider cancellation acceptance. Prior bundle bytes stay frozen.

Release `2026.08.31.4` closes an independently reproduced proxy credential leak.
The Hivra outer session cookie and matching Hivra management bearer are now
consumed only by the root-owned access gateway and stripped before both HTTP and
WebSocket proxy forwarding to bux-owned terminal, VNC and runtime services.
Other backend cookies and non-Hivra authorization schemes are preserved. The
release keeps `.31.3`'s native cleanup semantics and still does not make the
DeepSeek catalog option public. Direct sslip provider readiness also pins the
socket to the IPv4 encoded by the immutable hostname while preserving HTTPS SNI.

Release `2026.09.01.3` fixes the remote-desktop installation trust boundary.
The unprivileged session broker still owns only mutable state below
`/var/lib/hivra/remote-desktop`; immutable capability and input-isolation proof
now live below root-owned `/opt/hivra/remote-desktop`, whose ownership and mode
are independently checked before readiness can be recorded. The installed
revision now binds the installer itself in addition to the broker, gateway and
pinned Selkies image, so a change to installation policy cannot reuse an older
capability identity. This release changes neither public runtime catalog status
nor the staged native DeepSeek wire contract.

Release `2026.09.01.4` fixes remote-desktop startup convergence. The guest
installer now distinguishes systemd process activation from the protected
Selkies HTTP surface becoming ready, and waits for the exact loopback contract:
unauthenticated access must return `401` while the generated installation
credential must return `200`. The wait is bounded to 120 seconds and emits a
specific failure if that contract never becomes true. This release retains the
VMID-bound guest transport and does not weaken input isolation or authentication.

Release `2026.09.01.5` enables the pinned Selkies image's Basic authentication
switch explicitly. Supplying generated username and password variables alone
does not declare that authentication must be active; the protected readiness
contract therefore now binds both the enable flag and those per-install
credentials. The broker remains the only public access path, and installation
still fails closed unless unauthenticated loopback access returns `401` while
the exact generated credential returns `200`.

Release `2026.09.01.6` removes a remaining container-start race in the desktop
installer. A live systemd `docker run` process does not prove that the named
container is already inspectable, especially while an authenticated Selkies
entrypoint is starting or restarting. The installer now waits up to 120 seconds
for the exact named container to be both inspectable and running, then applies
the unchanged image, network, mount, privilege, Docker-authority, and protected
HTTP checks. A missing or crash-looping container still fails closed.

The installer also uses Ubuntu Jammy's signed archive for base OS packages,
including `docker.io`; those packages are distribution inputs rather than
unverified install scripts. The exact installed package versions are therefore
fixed by the dated Ubuntu image plus the repository snapshot available during
preparation, and should be captured in a release receipt if bit-for-bit guest
reproduction becomes a release requirement.

Release `2026.09.01.7` adds the typed DeepSeek Harness v2 guest document to the
Proxmox launcher. It requires pre-journaled named HTTPS access, preserves the
native Models UI as the only credential owner, and never falls back to an
unbound quick tunnel. The public catalog remains closed pending disposable
provider UI/model/restart/revocation/teardown acceptance.

Release `2026.09.01.8` adds rolling, guest-held Selkies controller leases. The
browser still receives no session bearer. Each short renewal rechecks current
owner, computer, capability-generation, transport and exclusive-controller
authority; an independent local deadline closes media and releases agent input
if renewal fails or arrives after the previous lease expired.

Release `2026.09.01.9` keeps the authenticated handoff page as a same-origin
wrapper around Selkies instead of navigating it away. That wrapper can observe
trusted pointer or keyboard input and the next decoded video frame whose sampled
pixels change, then send only the bounded duration, frame count and sequence to
the exact Hivra origin. Browser credentials and the guest-held session bearer
remain outside telemetry. This is browser input-to-changed-frame evidence, not
physical input-to-photon proof.

Release `2026.09.02.1` gives the Proxmox DeepSeek path the same immutable guest
bundle boundary already used by provider computers. The host validates the
root-owned provisioner tree, streams it directly into a fresh root-only guest
directory, and imports the native installer only from that directory. Other
catalog runtimes retain their existing upload path.

Release `2026.09.02.2` binds initial Proxmox host-to-guest provisioning SSH and
SCP operations to the exact VMID's Ed25519 host key, attested through QEMU
Guest Agent before the network path is trusted. Named-tunnel and model launch
material never crosses an IP-only SSH connection.

Release `2026.09.02.3` extends that VMID-attested identity boundary to restart,
start and runtime-update operations through one root-only helper. No supported
host-to-guest SSH or SCP path disables host-key checking or trusts an IP alone.

Release `2026.09.02.4` makes the attestation prerequisite deterministic for
stock Ubuntu cloud images. Operation-scoped, root-only cloud-init vendor data
installs and starts QEMU Guest Agent; provisioning removes the reference and
snippet after cloud-init completes, and failure cleanup removes both the VM and
bootstrap material.

Release `2026.09.02.5` removes deployment-specific host references from the
portable source documentation and points package-only verification at the
sanitized public status record. Runtime behavior, the worker protocol, the
native cleanup closure, and guest authority are unchanged.

Release `2026.09.02.6` publishes neutral private-network defaults and removes
the remaining deployment-specific labels from the portable bundle. The worker
protocol and native cleanup closure remain unchanged; every changed byte is
bound to the new immutable release manifest.

Release `2026.09.02.7` removes the last historical host identity from this
source-only provenance record. Runtime code and guest behavior are unchanged;
the documentation and version bytes are bound to a new immutable manifest.

Release `2026.09.02.8` adds a dedicated, Proxmox-only `linux-desktop` guest
profile without representing the computer as Claude. A strict v3 launch
document binds the lowercase computer UUID, canonical control origin and exact
pre-journaled named-tunnel origin before package work; browser/model inputs and
quick-tunnel launch are rejected. The profile reuses the reviewed Ubuntu/bux
base, then removes Claude/Codex binaries, state and persona, records the exact
Linux Desktop kind, opens both native terminals as ordinary Bash shells, and
roots the Files and terminal surfaces at `/home/bux/Hivra` while HOME remains
`/home/bux`. Its authenticated gateway advertises computer capabilities and
fails agent chat, session and login operations closed. The bundled remote
desktop installer must publish its capability before the runtime receipt and
host launch can succeed. Existing provisioner versions do not gain this new
runtime by compatibility inference, and no installed host or guest is changed
by these source bytes alone.

Release `2026.09.05.1` fixes the Linux Desktop shared-folder identity boundary.
The exact pinned Selkies base runs as numeric uid/gid 1000, while the canonical
guest workspace is owned mode 0700 by the distinct `bux` account. The installer
now builds a local-only derived image from that already-pulled digest with
network access disabled, rejects identity/configuration and pre-existing inode
collisions, and remaps the complete base root filesystem when the observed bux
uid/gid differs. A legitimate bux `1000:1000` instead takes an identity-preserving
derivation. Both retain the named unprivileged `ubuntu` desktop identity plus
the original entrypoint and command. It launches by the resulting immutable image id only after a contained
write-through probe proves that a container-created file is owned by bux on the
guest. Capability inspection independently checks the base digest, recipe,
runtime image id, effective identity and mount ownership. Inspection never
installs or upgrades an older desktop; an old uid-mismatched capability simply
fails fresh proof until the owner explicitly runs the installer. Existing
sessions and public transport semantics are otherwise unchanged.

Release `2026.09.05.2` corrects the pinned Selkies identity derivation after a
real prebuild found two intentional special-mode inodes in the immutable amd64
base: `/usr/local/share/fonts` (`2775`, directory) and
`/opt/google/chrome/chrome-sandbox` (`4755`, regular file), both owned by the
base `ubuntu` identity. The derivation accepts only those two exact paths,
types, modes and source identities; an added path, symlink, changed mode,
changed owner or filesystem walk error fails before remapping. It restores and
re-verifies their exact modes and mapped uid/gid after the complete numeric
rewrite, because Linux ownership changes clear special bits. Fixed categorical
failure markers distinguish the allowlist and restoration gates without
returning Docker output. The failed `.05.1` prebuild did not claim an operation
lease or run the installer, and this source release does not retry it.

Release `2026.09.05.3` corrects the remaining numeric-identity derivation
failure observed in an isolated `.05.2` image build. The complete ownership
scan proved that selected symbolic links retained the base uid after the normal
ownership pass; the overlay copy-up mechanism is inferred, while the remaining
old-uid links are directly observed. Before the numeric inode rewrite, the
derivation now inventories only selected same-filesystem links and recreates
each one through an exclusive adjacent link and atomic replacement. It retains
the exact target, link mode, timestamps and supported extended attributes,
rejects overlay-internal or otherwise unpreservable metadata, and keeps the
full no-old-uid/gid completion guards. Image derivation, immutable-image
inspection and workspace write-through proof now finish before any installed
broker, bypass, Basic-auth or environment file is replaced. The prior failed
preparation therefore is not evidence that the new derivation succeeds; this
source release does not retry a build, restart a desktop, or mutate a live
computer.

Release `2026.09.05.4` changes the browser-desktop session protocol so one
handoff cannot be adopted by another tab. Each media route, cookie, handoff
message and parent-frame event is bound to the exact session identifier; the
wrapper reports connection only after the native transport and decoded video
are ready, ends the embedded document on transport loss or reload, and requires
an explicit reconnect. The control plane admits new, exchanged, authorized and
rolling Selkies WebSocket sessions only for this exact revision. Earlier sealed
desktop revisions remain available to read-only inspection so their owners can
be shown an update requirement, but they are not evidence for a new session.
This source release does not install, restart, deploy, or mutate a live
computer.

Release `2026.09.08.1` makes the browser desktop start in the reviewed HQ
profile at 60 fps and 25 Mbps, with a user-selectable 60 fps, 12 Mbps
Performance profile. The parent sends only an exact-origin, exact-shape mode
message after the authenticated session connects; the broker accepts it only
from the bound parent window and changes the pinned Selkies bitrate/framerate
controls. Clipboard, files, microphone, camera, gamepad and upstream commands
remain disabled. This is an additive stream setting for the existing Selkies
WebSocket transport, not hardware-encoder, native Moonlight, Omarchy, Windows,
audio, WAN-latency or public daily-driver acceptance.

Release `2026.09.08.2` seals the browser broker change that binds the selected
HQ or Performance profile before the Selkies document loads and therefore
before its first frame. It refreshes the immutable provisioner manifest and
desktop capability revision instead of changing the already-sealed `.08.1`
release. This source release does not deploy, install, restart, or establish
live Sunshine/Moonlight acceptance on a customer computer.

Release `2026.09.08.3` removes the redundant authorization request made before
the input-takeover transition during browser handoff. The transition still
binds the exchanged bearer to the exact live capability and rejects revoked or
expired sessions; the retained authorization immediately afterward still
checks the running owner, active controller state and admitted transport before
the browser receives a cookie. A rejected transition terminates the grant and
creates no browser session. This source release does not deploy, install,
restart, or claim a measured live latency improvement before Canary acceptance.

Release `2026.09.15.1` adds the signed `windows-installer` host capability for
customer-owned Proxmox capacity. It authorizes only bounded inventory and
operation-tagged VM setup from an ISO already present on that exact host; it
does not contain, download, redistribute, license, or activate Windows. Earlier
compatible lifecycle releases remain usable for their existing runtimes but do
not inherit this capability. Dashboard delivery does not install this release;
the owner must explicitly prepare the host and complete a fresh preflight before
Windows setup is selectable.

Release `2026.09.21.1` updates the pinned Omarchy Selkies transport so guest
cursor shapes are sent as metadata and rendered by the local browser pointer,
while native cursor pixels remain excluded from the delayed video stream. It
also preserves release `2026.09.15.2` and every earlier manifest unchanged.

Release `2026.09.15.2` adds one host-capacity admission helper shared by launch,
start, restart, and resize. It counts only active non-template guest floors,
keeps a configurable host reserve, rejects a guest maximum larger than the
physical host, and can enforce owner-selected aggregate CPU and memory ceiling
density. Observation is the legacy default. It never resizes or evicts an
existing guest, and a reducing resize remains available on an already
overcommitted host. Inventory and per-guest status errors fail closed, and an
uncapped QEMU guest's CPU maximum counts every configured socket.

Release `2026.09.24.2` builds on `2026.09.24.1` and keeps agent work running
and visible across refreshes, closed tabs, gateway restarts and updates.
Every terminal tab (the agent terminal on every runtime and the Box Terminal)
runs in its own private tmux session slot, and both ttyd units use
`KillMode=process`, so a closed tab or a ttyd restart detaches instead of
ending the shell; the gateway lists and closes those sessions for the dashboard.
The agent terminal runs the exact Claude Code / Codex binary the chat gateway
runs and never another vendor's CLI. The vetted CLI versions ship as
`agent-cli-versions.json`; vendor self-updaters are off (`DISABLE_AUTOUPDATER=1`
and Codex's `check_for_update_on_startup = false` via
`hivra-codex-config-pin.py`, only when unset), and `hivra-agent-cli-update.sh`
moves the CLI to the vetted version in the background once no chat run is in
flight, verifying it and restoring the previous package on failure. Surface
sign-ins are saved as digests bound to the box token, so a gateway restart
keeps them, and `/api/meta` advertises the store's epoch as `bootId`. The
runtime updater now updates in place (only `bux-hivra-chat` restarts) and also
refreshes both terminal units, the CLI pins and helpers, and `hivra-tg-apply`,
which restarts the Telegram bot when a new token or pairing is applied. The
computer's own chat page uses detached runs; the Aeon fork sync never discards
the owner's git work; Agent Zero gets a stop grace that fits the host's
shutdown budget; the DeepSeek native broker renews its upstream session without
a restart. Remote-desktop assets are unchanged, so the remote-desktop bundle
revision and every session revision are preserved. This source release does
not deploy, install, or establish Canary acceptance.

Release `2026.11.12.5` builds on `2026.11.12.4` and adds Nuphos as an agent kind. The guest
installer (`provision-claude-code-box.sh`) installs Docker, pulls Nuphos's official runtime image
(`ghcr.io/nuphos/runtime:latest-claude-code`) and records it by digest, and runs it on the
computer's loopback (port 3102) with all capabilities dropped under `hivra-nuphos.service`. The
box gateway (`hivra-chat/server.js`) serves the runtime's own console at the root of the
computer's address behind the Hivra sign-in, presenting the computer's host as HTTPS, and passes
the WebSocket upgrade of exactly `/acp` through without the Hivra gate (stripping Hivra's
credentials), because Nuphos's servers connect there with a team key the runtime checks itself.
`hivra-agent-app-update.sh` updates it to the latest runtime, copying the runtime's home aside
first and putting the previous image and home back if the new one does not start. The typed
installer, host provisioner, guest runtime update, receipt and agent shell learn the kind.
`hivra-provider-worker.py` advances its release labels. This source release does not deploy,
install, or update any existing computer.

Release `2026.11.12.4` builds on `2026.11.12.3` and adds OpenBot by CopilotKit as an agent
kind. The guest installer (`provision-claude-code-box.sh`) installs Docker, pulls CopilotKit's
official `ghcr.io/copilotkit/openbot` image at its latest release and records it by digest, and
runs it on the computer's loopback (port 3101) in OpenBot's single-user mode under
`hivra-openbot.service`. OpenBot will not start without a CopilotKit Intelligence key, so the box
gateway (`hivra-chat/server.js`) shows a one-step page at `/openbot/` to paste it, keeps it on the
computer at `~/.hivra/openbot-intelligence-key` (0600), and then serves OpenBot's own workspace at
the root of the computer's address behind the Hivra sign-in. `hivra-agent-app-update.sh` updates
it to upstream's latest image, backing up its database first and putting the previous image and
data back if the new one does not start. The typed installer, host provisioner, guest runtime
update, receipt and agent shell learn the kind. `hivra-provider-worker.py` advances its release
labels. This source release does not deploy, install, or update any existing computer.

Release `2026.11.12.3` builds on `2026.11.12.2` and lets the owner turn on Hermes's own
restore points (checkpoints) from Hivra's Manage page. Before Hermes changes files in a turn,
it snapshots the project into its own shadow git store (`~/.hermes/checkpoints`), and the owner
goes back with `/rollback` or `/undo` in a Hermes chat. Hermes keeps the store, its size cap and
its pruning. The box gateway (`hivra-chat/server.js`) adds `/api/restore-points`, which reads and
sets Hermes's `checkpoints.enabled` through `hermes config get`/`hermes config set` as the agent
user, refuses while Hermes is being updated, and answers 404 on other agents.
`hivra-provider-worker.py` advances its release labels. This source release does not deploy,
install, or update any existing computer.

Release `2026.11.12.2` builds on `2026.11.12.1` and keeps Claude Code's per-project
approvals file, `.claude/settings.local.json`, out of commits made on a computer. "Yes, and
don't ask again" saves the approved command there, passwords and tokens included. The guest
installer now adds `**/.claude/settings.local.json` to the agent user's default git ignore
(`~/.config/git/ignore`), and sets the system `init.templateDir` to a copy of git's stock
template with a `pre-commit` hook, so every repository created or cloned on the computer
refuses a commit that stages that file (removing it is still allowed). A repository with
its own `core.hooksPath` runs its own hooks instead. `hivra-provider-worker.py` advances
its release labels. This source release does not deploy, install, or update any existing
computer.

Release `2026.11.12.1` builds on `2026.11.11.7` and lets the owner choose a Hermes
computer's model from Hivra's Manage page. Hermes keeps its model in its own config
(`model.default`), the setting its own model picker writes, and uses it for new chats.
On a Hermes computer, `hivra-chat/server.js` now answers `GET /api/model` from Hermes's own
`hermes config get model.default` and `model.base_url`, and `POST /api/model` runs
`hermes config set model.default <model>`, only when Hermes still points at Venice (Hivra's
managed gateway or Venice's API) and not while Hermes is being updated. Before this
release the endpoint wrote a file Hermes never read. `hivra-provider-worker.py` advances
its release labels. This source release does not deploy, install, or update any existing
computer.

Release `2026.11.11.7` builds on `2026.11.11.6` and shows Hermes's own Desktop workspace
at `/hermes` on Hermes computers. Before this release `/hermes` served `hermes dashboard`,
Hermes's admin page, and its pages went blank when opened under `/hermes`. Upstream Hermes
also serves its Desktop workspace in a browser (`hermes webapp`) from its gateway on
`127.0.0.1:9120` once `webapp.enabled` is on. `provision-claude-code-box.sh` now turns that
setting on and builds the Webapp with Hermes's own `hermes webapp --build-only`.
`hivra-chat/server.js` proxies `/hermes` to the Webapp when it is served and signs the owner
in with the one-use launch link `hermes webapp --no-open --skip-build` prints; while the
Webapp is not served it keeps proxying the dashboard, so older computers keep working.
`hivra-agent-app-update.sh` (Update Hermes) turns the setting on, runs `hermes update`, then
builds the Webapp and restarts Hermes's gateway, which is how existing Hermes computers move
over. Hermes itself is still installed and updated unmodified by its own commands.
`hivra-provider-worker.py` advances its release labels. This source release does not
deploy, install, or update any existing computer.

Release `2026.11.11.6` builds on `2026.11.11.5` and lets the official Hermes installer
finish on a fresh Hermes computer. Hermes's installer downloads the official Node.js
build, which links the host's `libatomic.so.1`; the Ubuntu 22.04 cloud image leaves that
library out, and the installer can only add it with root (`sudo -n apt-get install -y
libatomic1`), which the agent user does not have. Every Node step then failed and the
installer exited non-zero, so no Hermes computer finished its launch.
`provision-claude-code-box.sh` now installs the `libatomic1` OS package as root just
before it runs Hermes's installer. Hermes itself is still installed unmodified by its own
installer. `hivra-provider-worker.py` advances its release labels. This source release
does not deploy, install, or update any existing computer.

Release `2026.11.11.5` builds on `2026.11.11.4` and runs Hermes's gateway on Hermes
computers. Upstream Hermes runs scheduled tasks and chat channels (Telegram, Discord,
Slack) in its gateway process, separate from the dashboard, so before this release they
never ran. `provision-claude-code-box.sh` now turns on linger for the agent user, starts
its user manager and runs Hermes's own installer for the gateway as that user
(`hermes gateway install --start-now --start-on-login`, then `hermes gateway start`, with stdin from /dev/null and one retry without the flags for an older stable channel), the
setup upstream recommends for headless machines so `hermes update` restarts the gateway
without root. Hivra writes no gateway unit and no drop-in. A gateway failure only warns
and is recorded; the dashboard still comes up, and readiness reports the gateway as
active or as a warning. `hivra-guest-runtime-update.sh` does the same, idempotently, for
an existing Hermes computer and does nothing on any other kind; it never fails the update.
`hivra-provider-worker.py` advances its release labels. This source release does not
deploy, install, or update any existing computer.

Release `2026.11.11.4` builds on `2026.11.11.3` and adds the official Hermes Agent
(NousResearch/hermes-agent) as a kind of Hivra computer, as thinly as possible. There is
no Hivra-built image, fork, overlay or patch: `provision-claude-code-box.sh` downloads
Hermes's own installer over HTTPS and runs it as the agent user with
`--non-interactive --skip-browser --channel stable`, writes `~/.hermes/config.yaml` with
`hermes config set` and the inference key to `~/.hermes/.env` (mode 600) from the launch
model settings (default model `deepseek-v4-1-flash`, the managed inference endpoint), and
runs Hermes's own web UI as `bux-hermes.service`
(`hermes dashboard --host 127.0.0.1 --port 9119 --no-open`). The gateway
(`hivra-chat/server.js`) serves it at `/hermes/` behind the same token gate as every other
route: HTTP and the dashboard's WebSockets (`/api/ws`, `/api/pty`), with the prefix
stripped, `X-Forwarded-Prefix: /hermes`, `Host` set to `127.0.0.1:9119` and `Origin`
rewritten to loopback, because the dashboard refuses any other host or origin. It records
the installed version from `hermes --version` and reports it on `GET /api/meta`. Owners
update with `hermes update` in Terminal, or the Update Hermes button, which runs exactly
`hermes update --yes` as the agent user (`hivra-agent-app-update.sh hermes latest`, a
runtime update asset): exit status 2 (local changes, or another update running) is
reported as such and nothing is forced. Hermes has no Hivra-pinned version, so the update
target is the literal `latest`. The runtime-update scripts, the receipt and the install
allow-lists learn the `hermes` kind. `hivra-provider-worker.py` advances its native and
desktop release labels. The placement minimum for `hermes` is this release. This source
release does not deploy, install, or update any existing computer.

Release `2026.11.11.3` builds on `2026.11.11.2` and makes the chat's reasoning effort
real. The gateway (`hivra-chat/server.js`) accepts an optional `effort` on
`POST /api/chat`, strictly one of `low`, `medium`, `high`, `xhigh` or `max` (anything
else is ignored), and advertises the levels it will pass as `chatEffort` on
`GET /api/meta`. It was verified against the pinned CLI packages, not assumed. Claude
Code `2.1.292` (`@anthropic-ai/claude-code-linux-x64`, the native binary the main
package installs): the binary declares `--effort <level>` with the description "Effort
level for the current session (low, medium, high, xhigh, max)" and an allowed list of
those five; an unknown value is warned about and ignored there. Releases older than
`2.1.117` differ (`2.1.100` stops at `max`, and a value outside its list ends the turn
with a usage error), so the gateway passes `--effort` only when the installed CLI
reports `2.1.117` or later. Codex `0.149.1` (`@openai/codex@0.149.1-linux-x64`): the
binary has the `model_reasoning_effort` config key and a reasoning-effort enumeration of
`minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `ultra`; the gateway passes
`-c model_reasoning_effort="<level>"` for `low`, `medium`, `high` and `xhigh`, and maps
`max` to `xhigh`, because each model lists the levels it supports and the pinned CLI
cannot be asked which. That ceiling is one table in `server.js`. The override is placed
with the other `-c` overrides, so it applies to fresh and resumed turns and next to a
configured provider. Generic, Aeon, OpenClaw and Agent Zero computers ignore `effort`
and advertise nothing. No other asset changes: `server.js` is already a runtime update
asset, so existing computers receive it with the update. `hivra-provider-worker.py`
advances its native and desktop release labels. No runtime's placement minimum moves.
This source release does not deploy, install, or update any existing computer.

Release `2026.11.11.2` builds on `2026.11.11.1` and moves the agent's pinned Google
Chrome from `152.0.7977.64-1` to `157.0.8103.50-1` (SHA-256
`92148bd14dc05823a64061c2fafcf20d4d82b3fc56f5831206f16d2ac9ee3f79`), the Linux stable
that Google's version history lists as serving all users on 2026-11-09. The versioned
`.deb` is in Google's pool at the URL the installer already used. Because the previous
release turned Chrome's outdated-build warning off and holds the package, the pin no
longer moves by itself; this release moves it deliberately, and ships it as data.
`chrome-pin.json` carries the version, the SHA-256 and a `previous` list (the build it
replaced, with its SHA-256); the installer reads it instead of carrying its own copy,
and it is a runtime update asset, so the installer and the update read one file (the
`CHROME_VERSION` and `CHROME_LINUX_AMD64_SHA256` variables still override it when both
are set). New computers install the pinned build. For an existing computer, the guest
half of the runtime update moves `google-chrome-stable` to the pin when the installed
version differs, and only when the browser can be restarted right then: the unit is not
running, or nothing is established on its debugging port (re-checked just before the
binary is replaced, after the downloads). Otherwise it prints
`HIVRA_AGENT_BROWSER state=deferred` and leaves Chrome alone, because replacing the
binary under a running Chrome shows "Finish update". It downloads the `.deb` over https
with the installer's curl flags, verifies its SHA-256, then lifts the hold, installs it
with apt, drops Google's apt source again, holds the package, restarts the unit and waits
up to 30 seconds for `/json/version`, which must report the pin's major version. Before
it touches anything it keeps a recovery copy of the installed build: `dpkg-repack` when
installed, else the build's own `.deb` when the pin's `previous` list names it with its
SHA-256; with neither, the upgrade is skipped (`deferred`). If the new browser does not
answer, or apt refuses it, the previous build and the previous keeper are installed back
and the state is `restored`. It does not start without 600 seconds of the update's budget
and 1 GiB of free disk, so the update unit's own time limit cannot cut an install short.
None of this can fail the committed update. The sandbox stays on, there is no
`--no-sandbox` or `--test-type`, and the managed policy is unchanged. The keeper's
`--hide-crash-restore-bubble` and `--window-position=0,0` were checked against Chrome
157: both switches are present in the binary, a headless run with the keeper's flags
answers on its debugging port as `Chrome/157.0.8103.50`, and
`chrome/browser/ui/startup/bad_flags_prompt.cc` at tag `157.0.8103.50` lists none of the
keeper's flags (it adds Landlock and WebNN compiler sandbox switches, which the test now
covers too). Chrome's outdated-build detector (`upgrade_detector_impl.cc`) is still
skipped for a managed browser. Google keeps old versioned `.deb` files in its pool for an
unpublished period, so the pinned build and the `previous` build must be re-checked at
every Chrome move. The remote-desktop assets, service units, broker and other package
pins are unchanged. `hivra-provider-worker.py` advances its native and desktop release
labels and raises the number of files it accepts in a bundle manifest from 64 to 72:
`chrome-pin.json` is the 65th file, and the previous bundle already held 64. The bundle
stays far below the worker's size limits, and no other check in the worker changes. This
source release does not deploy, install, or update any existing computer.

Release `2026.11.11.1` builds on `2026.11.10.5` and gives the agent's live browser a
clean view. Computers provisioned before `2026.11.03.1` still ran a keeper that passes
`--no-sandbox`, which Chrome answers with an "unsupported command-line flag" infobar
(`chrome/browser/ui/startup/bad_flags_prompt.cc` lists the flag; nothing else the keeper
passes is listed), and the runtime updater never reinstalled the keeper. The pinned
Chrome `.deb` (packaged 2026-08-24) also passed Chrome's own outdated-build threshold
of eight weeks (`UpgradeDetectorImpl`, `kOutdatedBuildAge`), which shows the "Can't
update Chrome" bubble and the "Finish update" chip; that detector is skipped whenever
the browser is managed, and any mandatory machine-level policy makes it managed
(`ChromeBrowserPolicyConnector::HasMachineLevelPolicies`). The installer and the guest
half of the runtime update now write `/etc/opt/chrome/policies/managed/hivra-browser.json`
with `DefaultBrowserSettingEnabled`, `PromotionsEnabled`, `BrowserSignin` and
`SuppressUnsupportedOSWarning`, all documented Chrome policies and none of them touching
the sandbox, site isolation or the debugging port. Chrome stays on its pinned build:
`/etc/default/google-chrome` is written with `repo_add_once="false"` before the `.deb`
installs (Google's documented switch), Google's apt source is removed and
`google-chrome-stable` is held, so an apt upgrade cannot replace the binary under the
running browser. The keeper also passes `--hide-crash-restore-bubble` and
`--window-position=0,0` (beside its `--window-size`, equal to the Xvfb screen, so the
window fills the Browser tab where no window manager places it), and still launches
with Chromium's sandbox on and `about:blank` as its start page. The runtime
update installs this release's keeper and policy on computers that have the browser
unit, restarts the browser only when nothing is attached to its debugging port (the
keeper and policy otherwise apply at its next start), and puts the previous keeper
back when the browser does not answer on its port within 30 seconds. The remote-desktop
assets, service units, broker and package pins are unchanged. `hivra-provider-worker.py`
only advances its native and desktop release labels. This source release does not
deploy, install, or update any existing computer.

Release `2026.11.10.5` builds on `2026.11.10.4` and gives DeepSeek Harness its model
at launch. The upstream web UI only allows settings writes from a local browser, so a
remote owner could not choose one, and the guest refused launch-time model settings.
The strict version 2 launch document (`hivra-install-agent.py`) now carries the model
key, the HTTPS base URL and the model name as a complete set or not at all, with typed
validation that never echoes an input; `hivra-provision-on-host.sh` forwards the set
and refuses a partial one. On a fresh install only, `deepseek-harness/install-guest.py`
runs a child with dropped privileges as the `bux` account (no supplementary groups,
umask 077, minimal environment, the secret on its stdin alone) that creates the
runtime's private home directories with mode 0700 and writes `settings.yaml` (one
hand-declared OpenAI-compatible route plus the default model) and `.credentials.yaml`
(mode 0600, the key by reference) exclusively and without following links. A replay or
restart never rewrites them, so later owner edits survive, and the shared base
installer no longer receives the model variables for this kind. The Linux computer
documents still refuse a model. The service unit, broker, gateway policy, native
package pins and remote-desktop assets are unchanged, so the remote-desktop bundle
revision and every session revision are preserved. `hivra-provider-worker.py` only
advances its native and desktop release labels. This source release does not deploy,
install, or update any existing computer.

Release `2026.11.10.4` builds on `2026.11.10.3` and adds the `linux-server` kind:
the Ubuntu computer without a desktop (Files and the two terminals only). It reuses
the whole `linux-desktop` guest base and skips only the desktop capability install
and the Claude app helper. `hivra-provision-on-host.sh`, `hivra-install-agent.py`,
`hivra-runtime-receipt.py`, `hivra-agent-shell`, `hivra-chat/server.js`,
`hivra-guest-runtime-update.sh` and `provision-claude-code-box.sh` accept the new
kind; the strict launch-document parser takes a version 3 document for it (computer
id, control origin and named tunnel, exactly as `linux-desktop`) on Proxmox only and
still refuses every document it refused before. The kind reports `linux-server` from
`/api/meta`, so a control plane that expects it can tell it from a desktop. Every
`linux-desktop` line is unchanged. `hivra-provider-worker.py` only advances its
native and desktop release labels. Not touched: `hivra-start-on-host.sh` (no kind
logic), `prepare-proxmox-host.sh` and the remote-desktop assets, so the
remote-desktop bundle revision and every session revision are preserved. An older
host that has not synced this release rejects the kind and stays out of placement.
This source release does not deploy, install, or update any existing computer.

Release `2026.11.10.3` builds on `2026.11.10.2` and ships the Codex sign-in
freshness fix. `hivra-chat/server.js` reports a repeat Codex sign-in as fresh only
when the credential actually changed, and says why a repeat sign-in is not finished
yet. `hivra-provider-worker.py` only advances its native and desktop release labels.
No installer, sudoers rule, service or credential path changes, and the
remote-desktop assets are unchanged, so the remote-desktop bundle revision and every
session revision are preserved. This source release does not deploy, install, or
update any existing computer.

Release `2026.11.10.2` builds on `2026.11.10.1` and lets Claude Code run on
Hivra credits. `provision-claude-code-box.sh` gains
`configure_claude_managed_model`: for a Claude Code computer launched with a
managed model key, it validates the key's format, the Hivra Anthropic Messages
base URL (`https://<host>/api/managed-venice/anthropic`) and the model name, then
merges them into the agent user's `~/.claude/settings.json` `env` block
(`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and every model tier mapped to the
chosen model, with non-essential traffic disabled) through a mode-0600 atomic
write, keeping the owner's other settings. With no managed key the computer keeps
native `claude auth login` sign-in, and every other agent is untouched.
`hivra-provider-worker.py` only advances its native and desktop release labels.
No sudoers rule, service or credential path outside that settings file changes,
and the remote-desktop assets are unchanged, so the remote-desktop bundle
revision and every session revision are preserved. This source release does not
deploy, install, or update any existing computer.

Release `2026.11.10.1` builds on `2026.11.03.1` and hardens first launch and
start against slow or flaky networks, and tells the agent how to look after its
own computer. `provision-claude-code-box.sh` waits for the dpkg lock (a fresh
cloud image runs apt-daily right after first boot) and retries `apt-get` up to
four times through one `apt_get` helper, retries the bux checkout, the pinned
Claude Code and Codex npm installs through `with_retries`, and adds
`--retry-connrefused --retry-delay 3` to every pinned download, whose size and
SHA-256 checks are unchanged. `qemu-guest-agent` is still installed and enabled
on Proxmox computers and its failure still stops the launch. The Codex CLI is
installed under `~/.npm-global` and the installer now requires it at exactly
that path, where chat, the terminal and the CLI updater run it. Agent Zero's
model name and base URL are validated before they are written to its env file,
the default port in messages matches the unit's (50080), and its readiness wait
is five minutes. `hivra-provision-on-host.sh` bounds the provisioner copy (600
seconds) and the in-guest install (45 minutes) with `timeout` and SSH
keepalives, still through the VMID-attested key (`GSCP`/`GSSH`), and fails the
launch with a reason instead of hanging in "provisioning"; the existing EXIT
trap still reports `ready:false` and cleans up. `hivra-start-on-host.sh` waits
up to five minutes, matching provisioning, for the named tunnel after a start.
`system-prompt.md` and `system-prompt-codex.md` gain a "Looking after this
computer" section that points the owner to Manage for updates, restarts and
restore points, tells the agent not to upgrade its own CLI or touch the Hivra
connection services, and asks it to confirm before deleting anything of the
owner's. No runtime behaviour, sudoers rule, service or credential path
changes, and the remote-desktop assets are unchanged, so the remote-desktop
bundle revision and every session revision are preserved. This source release
does not deploy, install, or update any existing computer.

Release `2026.11.03.1` builds on `2026.10.20.2` and makes the optional Claude
app easier to work in. `hivra-claude-app` gains the owner's clipboard switch for
the desktop: `clipboard on|off` sets a root-only flag in
`/var/lib/hivra/desktop-clipboard` (off by default, kept apart from the app's own
state so removing the app never changes it), and `clipboard-put` /
`clipboard-get` move UTF-8 text, at most 256 KB, between the gateway and the
desktop's X clipboard through `xclip` run as the desktop user inside the
container. They refuse while the switch is off. Selkies' own clipboard stays
disabled, as do files, audio, microphone, camera, gamepad and upstream
commands: text moves only when the owner presses Paste in or Copy out on the
Desktop strip (`/api/claude-app/clipboard`, `/clipboard/paste`,
`/clipboard/copy`, behind the box token), and the gateway passes pasted text to
the helper on stdin, never as an argument. The sudoers rule written by the
installer and by the runtime updater's guest half grows by exactly those four
verbs. The app's launcher now starts in `~/Hivra`, the desktop's one persistent
folder, and is rewritten before every launch. Claude Code's own data from the
app's Code tab (`~/.claude`, `~/.claude.json`) is saved in a second root-only
archive with its own 512 MB cap and restored only into an empty home, so a
desktop restart keeps Code tab sessions; `remove` deletes it. The agent's own
browser (`local-browser-keeper.py`) no longer passes `--no-sandbox`: the pinned
Google Chrome runs as `bux` with its setuid sandbox, and Chrome's errors reach
the keeper's log. The runtime updater does not reinstall the keeper, so that
change reaches computers provisioned from this release. The Claude app itself
still runs with `--no-sandbox`, because the contained desktop keeps Docker's
default seccomp profile and no-new-privileges; the remote-desktop assets are
unchanged, so the remote-desktop bundle revision and every session revision are
preserved. This source release does not deploy, install, or update any
existing computer.

Release `2026.10.20.2` builds on `2026.10.20.1` and lets owners update the
hosted app of an Aeon, OpenClaw or Agent Zero computer the way Claude Code and
Codex computers already update their CLI. The tested Aeon dashboard commit,
OpenClaw version and Agent Zero image digest move out of
`provision-claude-code-box.sh` into `agent-app-versions.json` (unchanged:
`8b8d7197`, `2026.6.10`, `v2.2`), which the installer, the runtime updater and
the dashboard all read. The installer records the version it put on the
computer in a root-owned `/var/lib/hivra/agent-app.json` and installs the
root-only `hivra-agent-app-update.sh`. The runtime update's guest half reports
the installed and tested versions (`HIVRA_AGENT_APP` line, re-validated by the
host half in each app's own version form) and, when they differ, starts the
helper as a transient unit. The helper prepares the new version next to the
running one (an npm download for OpenClaw as the agent's user, an image pull by
digest for Agent Zero, a separate dashboard build for Aeon that leaves the
owner's fork clone untouched and is served through a unit drop-in with
`AEON_REPO_ROOT`), waits until nobody has used the app through Hivra for five
minutes and the app has no work in flight, holds the app's surface while it
swaps, restarts only the app's own service, and puts the previous version
(and, for Agent Zero, its data as it was) back when the new one does not answer
on its loopback port. The gateway reports the version, the update's progress
and when the app was last used as `agentApp` on authenticated `GET /api/meta`.
Remote-desktop assets are unchanged, so the remote-desktop bundle revision and
every session revision are preserved. This source release does not deploy,
install, or update any existing computer.

Release `2026.10.20.1` builds on `2026.10.07.1` and gives a DeepSeek computer
an owned in-place runtime update. The runtime updater's guest half moves out of
`hivra-update-guest-runtime.sh` into its own file,
`hivra-guest-runtime-update.sh`, sent to the guest on stdin as before, so other
transports can run the same reviewed bytes. On a DeepSeek computer it no longer
refuses: it stages the archive root-only and runs
`deepseek-harness/update-guest.py`, which first proves the computer is exactly
the generation its reference bundle installed (gateway tree, pinned package
receipt, service unit and the running owned service), then stages the new
gateway (and a new package beside the live one when its pins move), stops the
old generation through the service-owner checks, swaps by rename, and requires
the same readiness a fresh install proves. Any failure stops the new generation,
puts the previous one back and starts it. The configuration and intent files
launch wrote, the agent's files and its private home are left as they are. The
generic gateway update is unchanged. Remote-desktop assets are unchanged, so the
remote-desktop bundle revision and every session revision are preserved. This
source release does not deploy, install, or establish Canary acceptance.

Release `2026.10.07.1` builds on `2026.09.24.4` and adds an optional Claude app
for Ubuntu Desktop computers, plus the vetted Claude Code CLI pin move from
`2.1.246` to `2.1.292`. A root helper (`hivra-claude-app.py`), an inert
supervisor unit (`hivra-claude-app.service`) and a package pin
(`claude-desktop-pin.json`) are installed on a desktop computer by provisioning
and by Update & restart, together with a sudoers rule that lets the gateway run
exactly five commands: `status`, `install`, `mode app`, `mode desktop` and
`remove`. Nothing is installed or started until the owner adds the app. Adding it
downloads Anthropic's own Linux package from `downloads.claude.ai`, checks its
size and SHA-256 against the pin, and unpacks it without root inside the existing
contained desktop; Hivra never bundles or redistributes it. The desktop
container is unchanged: no mount, port or privilege is added, so the isolation
proof and the remote-desktop bundle revision are preserved. The app's own data is
kept across desktop restarts as a size-capped, root-only backup on the same VM that
no Hivra service reads; because that data includes whatever the app keeps there, a
sign-in session among it, `remove` deletes it. The gateway gains four
owner-authenticated routes under `/api/claude-app/` and advertises `claudeApp` in
`/api/meta`. The owner signs in to the unmodified app themselves; Hivra's own
systems never receive or read that sign-in. Remote-desktop assets are unchanged. This source release does not
deploy, install, or establish Canary acceptance.

Release `2026.09.24.4` builds on `2026.09.24.3` and fixes two terminal
follow-ups from the socket move. The runtime updater's "is anyone on this
terminal" check now counts clients on the owner-only unix sockets as well as on
the loopback ports (a computer updating from an older release still runs its
terminals on the ports when the check runs), so Update & restart no longer
restarts a terminal someone is using. The gateway falls back to a terminal's
loopback port only while its installed unit is still the port-bound one; a unit
from the socket release answers "restarting" (503) until its socket is back,
so no other local process that bound the port during a restart can receive the
owner's terminal traffic. Remote-desktop assets are unchanged, so the
remote-desktop bundle revision and every session revision are preserved. This
source release does not deploy, install, or establish Canary acceptance.

Release `2026.09.24.3` builds on `2026.09.24.2` and hardens the computer for
agents added to it. Both terminals keep their persistent tmux session slots
and `KillMode=process`, and now listen on unix sockets in bux-owned `0700`
runtime folders (`/run/hivra-terminal`, `/run/hivra-box-terminal`) instead of
loopback ports, so no other local user or service can open a shell as bux; the
gateway proxies to a socket only when it and its folder are its own, falls back
to the loopback port for a terminal whose unit predates the move, and reports
which it uses in `/api/meta` (bearer only). The runtime updater restarts an
idle terminal onto its socket and checks it through the gateway; a busy one
moves at its next start. On a computer the gateway answers `/api/git/*` with
404 before any process starts, and it serves an agent added to the computer
through `/agents/<installation id>/` (a fixed route allowlist, JSON only, none
of the agent's headers forwarded, CSP sandbox, no WebSocket), advertising
`attachedAgents: "hivra-attached-agent-v1"` in `/api/meta`; the attached
instance itself listens only on the socket systemd passes it. This source
release does not deploy, install, or establish Canary acceptance.

Release `2026.09.24.1` builds on `2026.09.22.2` and makes agent chat turns
survive the browser going away. `hivra-chat/chat-runs.cjs` runs each turn under
a detached runner that owns the Claude Code/Codex CLI and records its stream and
outcome under `~/.hivra/chat-runs`; the gateway tails that log, and only an
explicit stop ends a detached run. The CLI arguments and permission flags are
unchanged. The guest installer and runtime updater add a
`bux-hivra-chat.service` drop-in with `KillMode=process` for chat runtimes so a
gateway restart leaves in-flight runs alone, and `hivra-agent-shell` keeps the
interactive agent terminal in a private tmux session so a closed tab detaches
instead of ending the CLI. Remote-desktop assets are unchanged, so the
remote-desktop bundle revision and every session revision are preserved.

Release `2026.09.22.2` builds on `2026.09.22.1` and aligns the provider-VM
desktop service planner with the Selkies environment the sealed desktop
installer has written since `2026.09.15.1` (`SELKIES_SCALING_DPI=96` with
`SELKIES_USE_CSS_SCALING=true|locked`). The planner still demanded the retired
`96|locked` value, so provider-VM Ubuntu desktop preparation rejected its own
installer's configuration. Guest desktop assets (installer, broker, server,
image) are unchanged, so the remote-desktop bundle revision and every session
revision are preserved, as are all earlier manifests.

Release `2026.09.22.1` builds on `2026.09.21.1` and adds the agent-run reporter
for Claude Code and Codex computers on Proxmox. `hivra-agent-trace.py` and
`hivra-agent-trace.service` read only the structure of the agent's own session
transcripts (task start and end, tool name, duration and a structured outcome)
and deliver bounded OTLP records to the dashboard ingest with a per-computer
seven-day credential that the reporter renews itself; prompts, replies,
commands, tool inputs and tool outputs are never recorded or sent. Parse cost
is bounded per line, a line that crashes the reporter is skipped on the next
start, and heartbeats stop while delivery is failing so a stuck reporter shows
as a gap rather than as healthy. The host launch script stages the credential
from the existing root-only secret handoff only when this bundle is present and
emits launch document version 4 only for Claude Code and Codex; other runtimes
keep the unchanged version 1-3 documents, and an older dashboard that writes no
credential still launches. The guest installer validates the credential
strictly and passes it to the reporter's installer on stdin only; installing
the reporter is fail-open, so a reporter failure never fails a launch or a
start, and both paths print one `HIVRA_ACTIVITY_COLLECTOR` status line that the
control plane records. Start, restart and resize reinstall the reporter from a
fresh VMID-bound credential file, which also brings computers launched before
this release into reporting. The runtime receipt does not list the reporter,
because it is written before the reporter is installed. This is agent-reported
evidence, not an operating-system audit, and this source release does not
deploy, install, or establish Canary acceptance.