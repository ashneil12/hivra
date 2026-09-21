# Omarchy and Windows Canary lab acceptance

Date: 2026-09-07  
Target: `node-b` (`10.252.12.213`), private bridge `vmbr1`  
Scope: disposable/private Canary lab only; this is not public managed-profile acceptance.

## Omarchy 4.0.2

- VM `2099`, claim `019d13b0-4f19-7f55-9a22-83e72232d8c1`
- Official ISO SHA-256 verified as `2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8`.
- Full-disk installation and deferred owner provisioning completed.
- Hyprland rendered at `1280x800`; SSH key access and outbound networking passed on `10.240.20.99`.
- Sunshine `2026.516.143833-4` started with the `libx264 [software]` H.264 encoder.
- Streaming TCP ports were reachable only from the approved private relay address; administrator port `47990` remained blocked.
- After a clean reboot, the owner compositor, graphical-session target, Sunshine, DNS, and streaming listeners returned.

The live run exposed two UFW parsing defects: destination-address-prefixed rules and `/32` display normalization. Commit `55e194c32` fixes both and adds regression coverage.

Remaining public-profile gates: controller-owned pairing, browser/client transport, video and audio acceptance, input/revocation proof, and lifecycle wiring. The launch button must remain disabled until these pass.

## Windows 11 Enterprise evaluation 25H2

- VM `2098`, claim `00000000-0000-4000-8000-000000001005`
- Microsoft evaluation ISO SHA-256 verified as `6e861b93eb9501182ad2e4dc3fa8c411afb6d7ed86a8ccbe37ca67d75470b95f`.
- UEFI Secure Boot, TPM 2.0, Q35, 4 vCPU, 8 GB RAM, and a 64 GB persistent disk were exercised.
- Unattended installation reached the Windows desktop on `10.240.20.98`; console input opened Start and private RDP port `3389` was reachable.
- Both installation media were detached, the plaintext answer ISO was deleted, and the VM then cleanly shut down and booted from its installed disk.
- The desktop and RDP listener returned after that clean reboot.

This is a 90-day evaluation image for lab verification, not a managed-production license. Remaining public-profile gates: a licensed image/entitlement policy, browser RDP gateway, credential brokering, snapshot/recovery integration, and claim-bound teardown in the application lifecycle. The launch button must remain disabled until these pass.

## Shared lab infrastructure

The desktop guests use exact-MAC DHCP reservations on `10.240.20.98-99`, routed through the host's existing private NAT boundary. The declared `hivra-desktop-lab-dhcp-dnsfix.service` unit is enabled on `node-b`, advertises the Hetzner resolvers that are reachable from this network, and restarts automatically. The service remains scoped to these two retained Canary lab VMs; it is not a generic fleet DHCP configuration.
