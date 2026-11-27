# Prepared Claude Code and Codex dependencies

`bux-dependencies` is a shared, dependency-only disk for fresh Claude Code and Codex guests. It does not preinstall either CLI, create a tenant account, copy the bux checkout, install Chrome, or set up credentials, services for the tenant, or a tunnel. It is not a managed launch selection.

On a disposable Linux amd64 builder without operator credentials, follow the [shared builder requirements](bake-official-hermes.md#build):

```sh
mkdir -m 0700 bux-bake-output
bash dashboard/scripts/bake-runtime-image.sh bux-dependencies bux-bake-output
```

The profile uses the managed-stock Jammy image digest in `ubuntu-qga-bake-pins.env`. `../provisioner/bux-bake-lock.json` records the reviewed bux Git commit and installer SHA, the resolved Ubuntu package versions and SHA-256 hashes from the signed 2026-11-27 Jammy snapshot, and SHA-256 hashes for the vendor packages, signing keyrings, uv and ttyd. NodeSource Node 24 remains a package in `/usr`, rather than replacing its upstream layout with a separate Node distribution. The producer fetches all locked assets before starting customization, checks those bytes again inside the network-isolated customization appliance, and keeps the normal Ubuntu, NodeSource and GitHub CLI update sources without apt holds. Only QGA is enabled for first boot; normal tenant setup enables atd.

The explicit root bootstrap switch `HIVRA_BUX_DEPENDENCIES_BAKED=1` is for offline verification. It is accepted only for Claude Code and Codex on Proxmox-shaped guests. Stock provisioning remains the default. A selected base verifies the root-owned marker, lock, dpkg state and tool bytes, and refuses to use the baked path on an existing tenant or retained checkout. The bypass removes the base, GitHub CLI and NodeSource package transactions only from the exact reviewed installer preimage. Upstream's own uv and ttyd blocks see the already installed tools. Browser-enabled launches keep an apt refresh for their separate browser packages. Every launch still fetches the bux checkout, installs the selected versions of the stock coding CLIs at their standard prefixes, initializes the tenant account, installs the Python venv dependencies and browser skill, and configures Hivra services. The existing owner-triggered CLI updater remains unchanged.

Before considering a live pilot, match the final disk's SHA-256 and marker, verify standalone QCOW2 integrity and the absence of tenant state, and boot two default BIOS clones of the exact sealed image per runtime profile without network. Check cloud-init, QGA and distinct machine IDs, instance IDs and SSH keys. On separate disposable clones, exercise both fresh tenant install and owner update paths. Do not treat the marker inside the guest or this verification switch as authority; a managed launch needs an independently verified selection of the exact image digest and trusted host launch attestation. Passing offline checks does not authorize staging a disk, enabling a selector or claiming a launch-time speedup.
