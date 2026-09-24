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
  `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_152.0.7977.64-1_amd64.deb`
  - package version: `152.0.7977.64-1`
  - SHA-256: `4eae0736a812d9bc851cd2937f7af00e47dbaf8305845eed452703ff009873c7`
- GitHub CLI Linux amd64:
  `https://cli.github.com/packages/pool/main/g/gh/gh_2.98.0_amd64.deb`
  - package version: `2.98.0`
  - SHA-256: `f65a3fa2fa0eb2e97c445ee3f5e087a40aae03b64847f45a8f13805e504535d6`
- Anthropic Claude Code npm package: `@anthropic-ai/claude-code@2.1.246`
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