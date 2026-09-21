# Prepared desktop boot foundation

Date: 2026-09-07  
Source base: `463833aa2f1b17ec8f216934feffc7c054cda027`  
Target: Canary `node-b`, retained Windows VM `2098` and Omarchy VM `2099`

## Change

- Prepared Windows and Omarchy rows now use an exact-slot lifecycle adapter for
  start, stop, and restart. They cannot fall through to the Ubuntu agent
  provisioner when configuration drifts.
- The adapter verifies the configured host, VMID, IP, profile, VM name, and
  retained preparation claim before taking a provider mutation.
- Desired power state is mirrored to Proxmox `onboot`: running/start/restart use
  `onboot=1`; an explicit stop uses `onboot=0`.
- The Manage surface keeps a plain-language, live progress message visible for
  start, stop, restart, and runtime-update requests instead of presenting only
  a disabled button while the host operation is in flight.
- Fresh Omarchy lab installs include and enable `qemu-guest-agent`, and Proxmox
  exposes the guest-agent channel from the first boot.
- The retained DHCP/DNS unit is ordered before `pve-guests.service`, so DHCP is
  scheduled before Proxmox auto-starts the prepared desktops.

## Verification

- Prepared lifecycle and action-route suites: 63 tests passed.
- Omarchy image/lab contract: 19 tests passed.
- Manage lifecycle feedback: 25 tests passed.
- Dashboard TypeScript check passed.
- Focused ESLint passed.
- Persistent DHCP service contract passed.
- Live unit SHA-256 matched source:
  `ecb504d7991c71af59733260ec194a89de798be146310d1e1ef8b2752df480bf`.
- Live service remained active and enabled; systemd reported
  `Before=pve-guests.service`.
- VMs `2098` and `2099` remained running and now report `onboot: 1` and
  `startup: order=30,up=15,down=60`.

## Preservation and limits

- No VM, guest OS, desktop session, Sunshine service, firewall, disk, snapshot,
  credential, or owner row was restarted or changed during this checkpoint.
- A full `node-b` cold reboot was not performed because a separate authorised
  native-streaming task was actively using the retained guests. This proves the
  persistent configuration and ordering, not complete cold-host recovery.
- The retained Windows and Omarchy fixtures predate the new Omarchy guest-agent
  image contract; this change does not claim that either retained guest was
  retrofitted while the native-streaming task owned their live session state.
