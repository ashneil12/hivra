# Hivra remote computers: speed and integration direction

**Date:** 2026-08-31

**Status:** Buzz now has real signed cross-agent runtime/reply evidence. DeepSeek
Harness has real native UI, model, PTY, restart, revocation and cleanup evidence
but remains public-gated on ACP. Omarchy has real KVM install, owner desktop,
reboot, Sunshine preparation and teardown evidence but remains public-gated on
native route/pairing/input/audio/latency. The performance budgets below remain
engineering proposals, not measured daily-driver acceptance or purchase authority.

## What changes, and what stays

Hivra should let someone work inside a persistent cloud computer comfortably
enough to use it every day. Full desktop performance is now an active engineering
track alongside portable-release closure; it need not wait for projects, tasks,
or a replacement unified workspace. Those old ordering dependencies are document
drift after this request, not missing prerequisites we should invent.

Keep the original agent launch/native-interface experience. A runtime, a shared
collaboration service, an operating-system image, and an access protocol are
different things. They reuse the existing computer identity, isolation, capacity,
credential, lifecycle and recovery contracts. No new infrastructure lane, forced
project, managed-only feature, automatic purchase or silent isolation downgrade.

## The three additions

Implementation checkpoint (2026-08-31): an uninstalled DeepSeek native adapter
now passes an actual-package Linux smoke for private authentication, synthetic
BYOK persistence and stream revocation. This does not enable its catalog entry
or satisfy real-reply/browser/cgroup acceptance. See the
[scoped evidence](../../release/VERIFICATION-STATUS.md).
The next staged checkpoint puts its immutable source in the provisioner bundle
and wires an unreachable-by-catalog native gateway policy: fixed-origin routing,
native/management authority separation, readiness and descriptor-relative
credential disclosure guards. The strict launch schema and installer remain
closed, deliberately, until service-cgroup and public guest acceptance exist.
The subsequent [package/tool checkpoint](../../release/VERIFICATION-STATUS.md)
adds a staged root-owned immutable installer and proves official shell/PTY
execution as a non-root user. Its evidence does not satisfy the final service,
model-reply or public-guest gates. The latest
[guest-composition checkpoint](../../release/VERIFICATION-STATUS.md)
bundles those components in `.31.2` and wires a private typed provider-VM guest
path under the existing lock. Public dispatch/catalog and the legacy Proxmox
launcher remain closed for DeepSeek until real guest and cancellation proof.
The [offline systemd fixture](../../release/VERIFICATION-STATUS.md)
separates real native service acceptance from full provider bootstrap and public
model/UI acceptance. The independent
[provider cancellation review](../../release/VERIFICATION-STATUS.md)
identifies the required durable cleanup obligation and cached-outcome handling;
adding a runtime enum alone must not bypass those gates.
The [native worker checkpoint](../../release/VERIFICATION-STATUS.md)
stages `.31.3` retained guest cleanup, boot-bound proof and immutable installer
outcomes. Its extended offline Ubuntu run now passes actual worker-failure,
native-cancellation and retained-controller recovery. The subsequent private
database fence adds short-lived cleanup observations and durable cancellation
intent, now applied to Canary. A private server adapter adds fresh cancellation
recovery, and atomic native access admission addresses an independently reproduced
hostname race. Additive `.31.4` removes Hivra authority from proxied HTTP and
WebSocket backend requests. A DeepSeek-only observation caller now converges an
already staged operation through immutable installed-file, service, public
native/terminal/VNC and final operation-CAS checks. Public create/launch and the
catalog remain closed; no user can select or create this runtime from these
private recovery/readiness changes. This is not public acceptance.

The 2026-09-01 managed-Proxmox composition publishes immutable provisioner
`2026.09.01.7` and adds a claim-bound private Canary harness. Its real fixturenodea
preflight found an exact free VM/IP candidate but correctly refused a 4 GB launch
because configured VM reservations exceeded physical host memory. No resource
was created. See the
[Canary preflight receipt](../../release/VERIFICATION-STATUS.md).

| Addition | Place in Hivra | First useful acceptance, before enabling it |
| --- | --- | --- |
| [Buzz](https://github.com/block/buzz) | Workspace-level collaboration connection, with its native client; not a new agent VM for every room | Connect an existing owner-approved relay; two distinct agent identities on two computers exchange signed messages; reconnect preserves identity/history; disconnect revokes only that binding. “Open Buzz” and CLI/ACP access share the binding. |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Experimental agent runtime inside an existing isolated computer | Install a pinned official package; configure the user's model key; obtain a real reply through its native Web UI and test the declared ACP surface; preserve state through restart; revoke access and clean up. |
| [Omarchy](https://github.com/omacom/omarchy) | Optional Linux computer image/profile, not an agent type or hypervisor | Boot a pinned disposable image, enroll the same Hivra computer component, open its actual desktop, install/use an agent, then verify update, recovery, restart and complete teardown. |

Buzz is a relay-backed human/agent workspace. Its cross-computer communication
fits Hivra without granting the relay provider or hypervisor authority. Keep one
signing identity per agent; do not share a workspace private key. The earlier
[integration assessment](../../release/VERIFICATION-STATUS.md)
still governs the credential and distribution work.

DeepSeek's current README describes a developer preview and a loopback Web UI.
Keep that preview warning and upstream authentication. A dashboard token must
not replace the model key, and exposing the Web UI on all interfaces is not a
shortcut to integration. [Upstream README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md),
[safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md).

Omarchy's `quattro/plans/server.md` is explicitly a headless-edition **plan** with
rollout steps and open installer questions. It is not evidence of a released
server image. Track desktop and possible future server edition separately;
never run its OS installer over a customer's existing Ubuntu computer or a
shared Proxmox host. [Server proposal](https://github.com/omacom/omarchy/blob/quattro/plans/server.md).

### Source observations, not installer pins

Read on 2026-08-31 through the upstream GitHub API, with the Guacamole pin
refreshed on 2026-09-02:

- Buzz latest desktop release: `desktop-v0.5.20`, published 2026-08-26.
- DeepSeek Harness master / `dsh-v0.1.2-alpha.2`:
  `0a53fb55bea101816fa226bb964ae2bed71c343b`. No GitHub stable latest-release
  response; this does not mean npm packages are absent.
- Omarchy default branch `quattro`: `b686ed892d9c3020c3336203f6d34cc75b544e2b`;
  latest release observed `v4.0.2`, published 2026-08-31.
- Omarchy `v4.0.2` release commit:
  `346e69e1cec6c4e8924531874af6ba010a1bc99e`; official ISO SHA-256:
  `2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8`.
- Selkies latest tagged release observed: `v1.6.2`, commit
  `7a80d7eea94f7ff5e754407a18364f4008d8b0fd`. Its actively changing `main`
  images are research inputs, not an immutable Hivra runtime pin.
- Sunshine latest release observed: `v2026.516.143833`, commit
  `14ffa6fdaa53f7b51512be2b3d24f3939695403c`.
- Apache Guacamole server release `1.6.0`, commit
  `1f664e08feae6e7d15d8146b78acab2e6fb470ae`. This is a catalog reference,
  not an accepted Hivra Windows bundle.

Before executing an installer, review and pin its complete artifact/dependency
closure, source/notices, supported architecture and upgrade path. A repository
license alone does not cover every shipped OS package, codec or dependency.

## Current access is not a general remote desktop

The portable guest currently uses Xvfb, Chrome, x11vnc/noVNC and an authenticated
WebSocket proxy for its optional browser surface. The shared provisioner and
`hivra-chat/server.js` own this path. Keep it as a baseline and recovery option.

`ConnectDesktopModal` configures the native **Hermes application** against a
remote Hermes backend. That is useful, but it is not a streamed Windows/Linux
desktop, and it does not establish a Hivra desktop latency result.

## Protocol shortlist

| Candidate | Intended evaluation | Important limitation |
| --- | --- | --- |
| Selkies | Embedded Linux desktop; compare explicit WebRTC/UDP with its WebSocket mode on the same guest | Current default is WebSockets, not WebRTC. Check X11/Wayland capture, encoder and browser combinations individually. |
| Sunshine + Moonlight | Native-client performance reference; hardware-accelerated and CPU-only cases | Pairing, input capture, permission scope, packaging and revocation need a Hivra integration. It is not a drop-in browser iframe. |
| RDP / FreeRDP | Windows office/productivity path and native-client integration | Do not assume Microsoft's Azure Virtual Desktop Shortpath feature ships in generic xrdp or every FreeRDP configuration. |
| Apache Guacamole | Browser gateway for RDP/VNC/SSH and compatibility fallback | Gateway support alone proves neither low latency nor graphics parity with a native client. |
| KasmVNC | Browser/text-quality comparison on Linux | Evaluate KasmVNC itself separately from the licensing/feature set of Kasm Workspaces. |
| SPICE / current noVNC | VM console, repair and baseline | Console access and smooth WAN daily-driver desktop access are different acceptance tests. |
| Amazon DCV | Commercial adaptive-streaming benchmark across native and browser clients | Benchmark only: it is not part of the open-source Hivra core and does not replace acceptance on Hivra's selected transports. |

Primary references: [Selkies README](https://github.com/selkies-project/selkies),
[settings](https://docs.selkies.io/settings),
[Sunshine](https://github.com/LizardByte/Sunshine),
[Moonlight setup](https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide),
[FreeRDP](https://github.com/FreeRDP/FreeRDP),
[RDP Shortpath](https://learn.microsoft.com/en-us/azure/virtual-desktop/rdp-shortpath),
[Guacamole](https://guacamole.apache.org/), [KasmVNC](https://kasm.com/kasmvnc),
[SPICE](https://www.spice-space.org/features.html),
[Amazon DCV](https://docs.aws.amazon.com/dcv/latest/userguide/what-is-dcv.html).

**Recommendation to test:** Selkies for browser access, Sunshine/Moonlight as
the native performance reference, and the existing console for recovery. Do not
write a new video codec or transport until measurements identify a specific
shortcoming that these implementations cannot address.

### Capability-selected access plan

| Computer and client | Daily-driver lane | Current admission boundary |
| --- | --- | --- |
| Linux X11 in a browser | Selkies; use WebRTC when its UDP path is verified and the accepted WebSocket/WebCodecs bundle otherwise | The shipped inspection currently admits only the pinned Selkies WebSocket bundle. |
| Linux Wayland / Omarchy from the native Mac client | Sunshine + Moonlight | Select only after that exact computer revision passes private-route, pairing, input, audio, reconnect, revocation, teardown and latency acceptance. |
| Windows in a browser | Apache Guacamole over RDP | Catalog candidate only. The owner API, database capability contract and guest inspector stay closed until the complete client/server/RDP bundle passes acceptance. |
| Any computer needing repair | Existing noVNC or provider SPICE console | Recovery purpose only; never a daily-driver fallback. |

The selector distinguishes installation from revision-bound verification. A
catalog entry or installed package cannot make a lane available, and a recovery
console cannot win a daily-driver request. Selection also remains downstream of
the compositor, client decoder, UDP/private-route and scoped-grant checks.

### The Omarchy browser boundary

Omarchy `v4.0.2` uses Hyprland/Wayland. Selkies' current moving `main` desktop
image can own a separate headless Wayland/labwc session, while the stable tagged
contract recorded above remains X11. Neither is proof that Selkies can capture
Omarchy's existing Hyprland session. Therefore Hivra must not install the present
Selkies lane into an Omarchy guest and claim it exposes that desktop. The first
Selkies experiment belongs on its own disposable X11 guest or upstream desktop
container. Omarchy uses its official Sunshine installer for the native
experiment; browser access remains unavailable until direct Hyprland capture (or
a clearly labelled separate desktop session) passes the same visual, input,
security, restart and teardown acceptance.

The transport catalog enforces that boundary. A compatible installed binary is
still insufficient: Hivra must observe the guest compositor, client capability,
approved private/UDP route and a scoped desktop grant before selecting a lane.
The recovery console stays repair-only and must never satisfy daily-driver
admission.

Primary references: [Selkies component support](https://docs.selkies.io/component),
[Selkies start and transport modes](https://docs.selkies.io/start/),
[Omarchy Sunshine installer](https://github.com/omacom/omarchy/blob/v4.0.2/bin/omarchy-install-service-sunshine),
[Sunshine documentation](https://docs.lizardbyte.dev/projects/sunshine/latest/),
[Apache Guacamole 1.6.0](https://guacamole.apache.org/releases/1.6.0/).

## Where responsiveness comes from

For an action that changes the remote screen, the latency budget includes:

`input dispatch + network round trip + guest work/frame wait + capture/encode + decode/display`

Some stages overlap. FPS measures cadence, not this end-to-end delay. An HTTP
health request measures neither video latency nor exact network RTT. A local
cursor can respond instantly while the remote application is still catching up;
do not present that as instantaneous remote execution.

Priorities for the experiment:

1. Choose a nearby region using measurements from the user's client, not from
   Vercel or the control-plane worker. Show regional latency before buying.
2. Keep Hivra's web API in the authorization/signaling path, not in every video
   frame. Prefer an authorized encrypted direct media path when policy allows;
   use an operator-owned regional relay when needed and expose which path won.
3. Detect actual capture and encoding capability inside the guest. A small cloud
   VM must not be advertised as hardware-accelerated just because its host has
   a GPU. Test CPU contention with the agent working.
4. Bound video queues and prioritize input/audio. Adapt bitrate/resolution before
   allowing seconds of old frames to queue; keep a visible quality setting.
5. Test text, scaling, scrolling and frame pacing, not just video playback. A
   60 FPS stream with unreadable terminal text is not a useful workstation.
6. Let native agent interfaces render locally when possible. Chat/terminal/files
   need not become video just because a full desktop is also available.

## Transport security is a release gate

Selkies' documented secure-mode client handoff uses session tokens in URLs;
Hivra's existing URL-secret prohibition still applies. An adapter needs a
reviewed one-time handoff/cookie or message-based exchange and log/referrer
tests, not direct copying of those URLs. The master credential stays in the
guest/broker, never the browser. Role changes and revocation must terminate the
affected stream/input authority. [Secure-mode contract](https://docs.selkies.io/secure-mode).

Set explicit TURN/STUN policy rather than inheriting public-relay defaults.
Reject unapproved peers and private/control-plane destinations; use short-lived
relay credentials. Do not copy host-network or wide-port-range troubleshooting
recipes onto shared managed hosts. Media reachability must not weaken the
per-computer firewall. [Selkies network documentation](https://docs.selkies.io/firewall).

One input controller at a time: human takeover suspends agent input. Keep
clipboard, files, microphone, camera, USB and sharing separate, off by default
until explicitly enabled. Test cross-user/computer denial, replay, expiration,
revocation and reconnect before advertising an access surface.

Implementation checkpoint (2026-09-01): the
[session-broker foundation](../../release/VERIFICATION-STATUS.md)
now provides owner-bound, short-lived PKCE handoffs, hashed bearer storage,
capability-generation and exact-revision binding, transport revalidation,
single-controller serialization, and guest-receipt fences for input takeover
and release. The API deliberately keeps credentials out of URLs and separates
owner issue/revoke, public one-time native exchange, and machine-only broker
authorization. This is locally and independently accepted control-plane code,
not a live desktop claim: no guest capability publisher, broker media adapter,
regional WAN stream, reconnect campaign or public UI is enabled by this
checkpoint.

A subsequent [managed Canary journey](../../release/VERIFICATION-STATUS.md)
proved a real decoded Selkies video surface, input frames, reconnect, guest
restart, owner revocation and complete disposable-computer cleanup. Its browser
telemetry is not physical input-to-visible evidence. The connected dashboard
now fullscreens the already-authenticated iframe instead of opening a new broker
window that cannot inherit the iframe's partitioned handoff cookie.

The [owner preparation checkpoint](../../release/VERIFICATION-STATUS.md)
adds the missing in-product transition from capability-unavailable to a verified
guest installation on an owner-scoped, identity-bound Proxmox computer. It does
not infer authority for legacy rows: those computers retain their existing
surfaces and require a current launch before Desktop can be prepared.

The following rolling-lease implementation keeps the controller bearer inside
the guest broker and extends only an active Selkies WebSocket in short leases.
The owner UI refreshes capability proof while connected; the server rechecks the
exact session/capability/owner/controller boundaries on every renewal and caps a
continuous session at twelve hours. Broker integration tests prove continuity
past the original lease and fail-closed input release. Immutable provisioner
`2026.09.01.8` carries those guest bytes and retains `.7` recovery. This is
source-level and control-plane evidence, not a real prepared-guest or WAN
performance result.

Provisioner `2026.09.01.9` keeps the authenticated handoff document alive as a
same-origin wrapper around the Selkies surface. The wrapper accepts only trusted
pointer/keyboard events, observes the first decoded frame whose sampled pixels
change, and reports every started measurement as either changed or a two-second
timeout, with only a bounded sequence, outcome, duration and decoded-frame count
sent to the exact Hivra parent origin. The dashboard presents rolling session
p50/p95 together with total sample and stall counts, and labels the result
browser input-to-frame. It does not call this physical input-to-photon evidence. Broker, UI, release-manifest,
historical recovery and provider-admission regressions cover the source change;
a current disposable guest campaign is still required before publishing a WAN
latency result.

## Proposed performance acceptance: `UC-DESKTOP-01`

These are starting engineering budgets, **not current Hivra results**:

- Regional reference network: measured RTT at most 30 ms; 1080p60 profile.
- Physical input-to-visible-response: p50 at most 60 ms, p95 at most 100 ms.
- Warm open/reconnect: p95 at most 2 seconds once the guest is healthy; measure
  cold boot and image provisioning separately, never bury them in this number.
- Record stale-frame stalls, dropped frames and frame-time distributions during
  motion. Never report an average FPS as proof of interactive quality.

Repeat on the same disposable guest with each transport; do not compare a local
GPU host with a distant shared-CPU cloud VM and attribute the difference to the
protocol. Test 720p30 CPU-only, 1080p60, Retina/high-DPI and hardware encoding
only where the corresponding profile is actually supported.

Required test conditions: wired LAN reference, ordinary Wi-Fi, regional WAN,
injected 30/80/150 ms RTT, jitter, packet loss, constrained bandwidth, UDP
blocked/relay fallback, agent CPU load, and simultaneous file transfer. Apply
impairment only inside the disposable lab's network boundary, not the user's
Mac, VPN or shared hosts.

For every condition retain raw samples, not only successful attempts:

- exact client/guest/streamer/adapter revision and image digest;
- client OS, browser/native version, decoder, display refresh/scaling;
- guest region, CPU/RAM, capture method and observed encoder;
- negotiated transport, direct/relay route and codec/bitrate/resolution;
- RTT/jitter/loss, encode/decode times where reported, and delivered frame times;
- at least 200 input samples, p50/p95/p99, errors and reconnect durations;
- a physical input-to-photon method (high-speed camera or equivalent optical
  instrumentation), its resolution/uncertainty, and the raw recording. A
  guest-side timer or requestAnimationFrame callback is not an optical result.

The executable evidence gate keeps browser telemetry and optical evidence as
different classes. A browser campaign may describe its measured input-to-frame
telemetry but cannot be labelled physical input-to-visible proof. Physical
acceptance requires a SHA-256-pinned raw recording, the optical method and its
uncertainty; that uncertainty counts against the p50/p95 budget. Every campaign
contains one exact transport revision, adapter revision, image digest, profile,
condition and negotiated route, with at least 200 unique raw samples.

Perform real daily work: terminal typing, IDE scrolling, dragging/resizing
windows, browser interaction, clipboard opt-in, fullscreen, display change and
audio. Disconnect/reconnect; sleep/wake the client; restart the guest; verify
saved work. Finish with selected-computer isolation and unconditional teardown
receipts. Label every unmeasured profile unavailable rather than estimating it.

## Client and delivery sequence

1. Finish remaining standalone provider acceptance for the staged DeepSeek
   runtime: exact `2026.09.01.9` guest fixture, disposable public TLS/UI/model run,
   restart/revocation and unconditional teardown before catalog enablement.
2. Implement Buzz connection/identity delivery and DeepSeek's pinned native/ACP
   adapter as independent additions to the existing runtime model.
3. Build one disposable Linux desktop recipe and run `UC-DESKTOP-01` against
   current noVNC, Selkies and the native reference. Publish the measurements.
4. Add Omarchy as a second image/profile through that proven access contract;
   validate its actual compositor and unattended boot/recovery separately.
5. Package a signed Mac/Windows client around the same account/self-host API.
   Keep navigation and computer switching local; reconnect existing sessions
   rather than recreate computers. Prototype native fullscreen/Spaces and
   keyboard handling before choosing Electron, Tauri or a native rendering
   component. A web wrapper alone does not eliminate network latency.
6. Add Windows guests through a separately tested image/licensing/lifecycle
   path. macOS guests remain limited to a reviewed Apple-hardware design; a Mac
   client connecting to Linux does not require a Mac server.

No provider purchases or production changes are authorized by this document.
The next user-supplied document can refine these choices without overwriting
verified capabilities or pretending the integrations have shipped.
