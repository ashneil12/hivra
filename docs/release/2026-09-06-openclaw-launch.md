# Canary OpenClaw launch, restart and cleanup

## Target

Normal logged-in root-path Hivra Mac Alpha → Agents → Deploy Agent → OpenClaw.
Canary alias rechecked after the test: deployment
`dpl_DH7TrdgwaQg9kmstSCZgLYF99GXn`, source
`6a52696d5c065a772dcdb513e26ffda2e250c740`, Ready in **hermesos-canary**.
Host `node-b` Canary provisioner reports `2026.09.05.10`. No new deployment.

Owned fixture `CANARY_OPENCLAW_0906`, agent
`00000000-0000-4000-8000-000000001131`, created
`2026-09-06 01:46:47.895538+00`, type `openclaw`, managed channel `canary`.
Selected managed pool, browser on, 2 CPU / 4 GB, and **managed Venice unchecked**.
VM 1130 / `10.240.20.80`, disk `local-lvm:vm-1130-disk-0`, 40 GB; tags
`hivra-bind-03f4702e476e911f8765fc0785fe4a7e` and
`hivra-op-c033932d90d0471aa6071791b532d538` match the test operation.
Installer PID 3671502 was observed running with advancing child/log state.

The original four computers and two agents were preserved. Test deadline was
02:05 UTC including cleanup. No Hetzner purchase/reservation, model key, cookie
import, account sign-in, messaging-channel connection or paid inference.

## Actual workflow

- Submitted once. The initial Launching button lasted roughly a minute before
  automatic navigation to Setting up. Fresh status responses continued. The
  native dashboard arrived about five and a half minutes after submission;
  no reload or duplicate launch was needed.
- Native OpenClaw rendered `v2026.6.10`, Gateway Online, and an update-available
  banner for `v2026.9.2`. Did not click Update. Expanded the native sidebar and
  opened Sessions; its table loaded with no matching sessions. This exercises
  native navigation, not model inference. Saved Hivra inference mode was
  Native sign-in; no model request was submitted.
- Public Box Terminal accepted shell commands as `bux`, UID/GID 1001. Created
  only `/home/bux/canary-openclaw-0906/proof.txt`, containing
  `HIVRA_OPENCLAW_PERSIST_OK` plus newline (26 bytes). Files opened the owned
  folder and displayed that content. SHA-256 matched an independent local
  calculation:
  `63db3f9d880d7c2c5778a52b3b6a0cd57a911f8a52410a6462079555f23ea7ca`.
- Normal Manage → Restart (not Update & Restart) showed Restarting and returned
  automatically to Running. Reconnected Box Terminal reported the identical
  hash. Boot ID changed from `00000000-0000-4000-8000-000000001132` to
  `00000000-0000-4000-8000-000000001133`. Native dashboard also reconnected,
  still `v2026.6.10` with Gateway Online.
- Browser rendered Chrome over noVNC after reboot. A rapid triple-click plus
  typing sequence dropped leading URL characters and produced a Google search
  for URL text. No consent accepted. One bounded second attempt separated the
  address-bar click, screenshot confirmation of selection, typing, screenshot
  confirmation of the exact URL, then Enter. This loaded Example Domain at
  `example.com`. Evidence supports ordinary pointer/text navigation with those
  separate steps; focus/input timing is a plausible contributor to the first
  failure, not a proven root cause. Modifier combinations and rapid input are
  not accepted. Existing `--no-sandbox` warning and restore-pages prompt remain;
  no browser-security pass is claimed.

## Cleanup

Normal Manage → Destroy, checkbox and exact fixture name permanently removed
the VM and test marker. UI returned to the original four computers and two
agents, all Running. Read-only checks by 02:00 UTC confirmed:

- Agent tombstone `deleted`, VM and operation fields null, API token and tunnel
  reference cleared.
- VM 1130 configuration absent; `pvesm list local-lvm --vmid 1130` has no
  volumes; installer PID file absent. Follow-up process check also found
  original installer PID 3671502 absent.
- Full `qm list` SHA returned to the exact pre-test baseline:
  `6bcd71708f0374d062cd039a8957e635efa8539fe653739a40fe5631939d66cf`.
- Both authoritative nameservers, `carrera.ns.cloudflare.com` and
  `neil.ns.cloudflare.com`, returned authoritative NXDOMAIN for
  `agents-canary-box-redacted.hermesos.cloud`. The local recursive resolver
  still held a positive answer with 218 seconds remaining; that cached answer
  is not treated as failed authoritative deletion. The external tunnel object
  was not separately enumerated.

PASS for scoped fresh launch, native navigation, shell/Files, restart
persistence, separated-step browser navigation and observed cleanup. Model
reply, messaging integrations, rapid input/modifiers, native monitor unplug,
Windows, Omarchy and full-catalog completion remain unverified or incomplete.
This acceptance adds evidence; no source/runtime fix was made in this test.
Independent evidence review by `core_gap_map` found no P1/P2 overclaims and
recomputed the marker length/hash. It did not independently reproduce the live
journey or mutate any resource.
