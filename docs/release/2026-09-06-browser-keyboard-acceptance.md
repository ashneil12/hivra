# Mac agent-browser keyboard check — 2026-09-06

Automated keyboard modifier acceptance: FAIL; the local diagnostic below identifies
an automation event-sequence limitation, not an established Hivra defect.
Physical-keyboard acceptance remains unverified. Target: Canary deployment
`dpl_n5XLDxTL3iPQUBgFrTZR8VXLPTeh`, inspected Ready at 07:41 UTC.
Purpose: distinguish a real Mac-to-Linux keyboard defect from the earlier
uncertain automation sequence, using a disposable Claude Code browser.

The retained Codex browser still shows its connection-update requirement;
it was neither updated nor restarted. The retained Agent Zero dashboard opened.
No credentials, model requests, cookie imports or existing guest changes.

Owned proposed fixture: `CANARY_BROWSER_KEYS_0906`, managed Canary 2 CPU / 4 GB,
browser enabled. Fresh host inventory found VM 1130 absent, existing guests
preserved, Canary bundle `2026.09.06.1`, and 310964649 KiB free thin storage.
Allocation must be observed, not assumed from this available VM number.
Deadline: 08:02 UTC including normal UI destruction and exact ownership cleanup.
No Hetzner spend; cumulative conservative reservations remain GBP 6.90 / 10.

Test only an owned blank/local browser page with no account data. Inspect focus
and complete typed text between actions. Record result and teardown below.

## Launch observation

One normal launch submission created agent
`00000000-0000-4000-8000-000000001091` at 07:41:54.410230 UTC. The page
advanced automatically to Setting up, without refresh or duplicate submission.
It initially offered only a disabled `LAUNCHING CLAUDE CODE...` button; unlike
the separate dashboard-agent form, no pending-confirmation explanation appeared.
This feedback gap is observed, not repaired in this check.

Allocated VM 1130 has 2 cores, 4096 MiB and 40 GB
`local-lvm:vm-1130-disk-0`. Binding tag
`hivra-bind-388635a86c1972897720dfd93e0e4f3e`, operation tag
`hivra-op-e55fb63eb87447b687273da96044ee1e`. Installer PID 3892741 was observed
running, not inferred from its PID file. Pre-test complete `qm list` SHA-256:
`6bcd71708f0374d062cd039a8957e635efa8539fe653739a40fe5631939d66cf`;
Caddy was active. Early QEMU guest-agent unavailability was not treated as
terminal failure or permission to restart the installer.

## Browser result

The page advanced to Running and opened the native terminal without a refresh.
Browser then opened the real noVNC view with Chrome on `about:blank`. Pointer
focus, typing the complete `data:text/plain,HIVRA_BROWSER_KEYS_OK` URL, and
Return successfully rendered the local marker. No external page navigation,
model request, account login, credential import or guest file was used.

Clicking the canvas and sending Mac automation `ctrl+l` did not select the
remote address bar, including one repeat after proven text input and a two-second
settle. `super+l` likewise did not select it. In contrast, noVNC Extra keys →
Ctrl, canvas focus and plain `l` selected the complete URL. The Ctrl toggle was
explicitly released before leaving Browser. This narrows the failure to the
modifier-event path; it does not establish whether physical keyboard events,
the automation mechanism, WKWebView, or noVNC is responsible. Do not patch the
guest or globally remap Mac keys on this evidence alone.

The actual guest reported Ubuntu package `novnc 1:1.0.0-5`; its
`/usr/share/novnc/core/input/keyboard.js` SHA-256 was
`7e74db1de4e4950323eeec08eeeec4003b439b244261775c99e19d1cd8176825`.
Source inspection confirms separate modifier-key events drive remote key state;
the normal Mac branch maps left Command/Super to Alt, not Control. The
[current upstream handler](https://github.com/novnc/noVNC/blob/master/core/input/keyboard.js)
also retains that mapping, so merely upgrading is not an evidenced fix.
Chrome still showed the existing `--no-sandbox` warning; sandbox safety is not
accepted by successful browser input.

## Cleanup

Normal Manage → Destroy, exact fixture name and irreversible confirmation
removed the owned fixture before 07:52 UTC, within the 08:02 deadline.
The database tombstone is `deleted`, VM and operation fields null, API token
and persisted tunnel reference cleared. VM configuration, VM volumes, PID file
and original installer PID are absent. Complete `qm list` hash matches the
pre-test baseline and Caddy remains active. Home again shows the original four
computers and two agents, all Running. Only the disposable VM and its browser
profile were irreversibly removed; existing computers and data were preserved.
No additional provider spend. External tunnel-object absence is not independently
verified; a cleared database reference is not proof of it.
Both authoritative nameservers, Carrera and Neil, returned NXDOMAIN for the
owned hostname. An earlier recursive resolver still returned cached Cloudflare
addresses; that cached answer was not treated as an authoritative cleanup failure.

Next diagnostic: observe modifier events on an owned local page under the same
Mac input path before choosing a client or noVNC repair. Do not repeat cloud
launches just to reconfirm this established failure.

## Local diagnostic: classification corrected

A disposable AppKit window with a stock `WKWebView`, a nonpersistent data store,
inline local HTML and network-denying CSP reproduced the event sequence without
Hivra code, noVNC, accounts or a cloud connection. Its focused box displayed
keydown/keyup metadata; an app-local NSEvent monitor recorded only event type,
key code and modifier flags. No global keyboard monitor was used.

Through the same native automation tool:

- Plain `l`: DOM `KeyL` down/up, no modifier flags.
- `ctrl+l`: DOM `KeyL` down/up with `ctrlKey: true`, but **no** Control keydown
  or keyup event. Native flagsChanged events had key code 0, not the physical
  Control key code; native `KeyL` carried flags 262144.
- `super+l`: DOM `KeyL` down with `metaKey: true`, but no separate Meta key
  event. Native `KeyL` carried flags 1048576.

This explains why noVNC's separate-key state never sees Control down from this
automation shortcut, while its explicit Ctrl button works. It does not prove
that a physical keyboard has the same sequence. No product keyboard remapping,
guest patch, noVNC upgrade or global event interception was made. The appropriate
next live check uses a real physical modifier sequence, not another identical
automated cloud reproduction.

Probe source SHA-256:
`604479a8ac5cf85a1cc3401ec8b5a7c446a615adda3ebb9709b4a67b5b10cdb6`.
The first
local script literal was corrected before the accepted event check; no result
from that preparation attempt is used. The corrected probe closed normally with
process exit zero. Its exact owned temporary app/source directory was removed
and absence verified; no installed app or persistent browser profile remains.
