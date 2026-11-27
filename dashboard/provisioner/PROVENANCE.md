# Provisioner provenance

This directory is the versioned source for Hivra's portable Proxmox runtime.
It was recovered from the active canary provisioner on `fixturenodea` on 2026-08-26,
before portable-path changes were applied. The imported files were checked for
private-key blocks and common committed-token formats; none were found.

The managed host remains runtime evidence, not the source of truth. Changes to
this directory must bump `VERSION`, pass the provisioner contract tests, and be
installed through the explicit host-preparation operation.

Earlier release notes are in [historical provisioner provenance](../../docs/release/PORTABLE-PROVISIONER-PROVENANCE.md).

Release `2026.11.27.5` seals the host-side Hermes standby helper and its
launch integration. It adds no third-party assets and leaves the catalog image
pins and the desktop and native workload contracts unchanged.

Release `2026.11.27.6` adds optional, digest-bound managed Canary images for
Agent Zero and the shared Claude Code/Codex system dependencies. The producer
locks Ubuntu packages, reviewed tooling, the upstream installer and the Agent
Zero OCI index; the image files themselves are not distributed by this bundle.
The scoped selector is unset by default. It leaves tenant configuration, CLI
updates and non-selected launches on their existing paths.
The stock QEMU Guest Agent refresh skips optional translation, command and
desktop metadata; signed package indexes, SSH attestation and the clean
cloud-init gate are unchanged.
