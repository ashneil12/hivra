# Omarchy installer and launch version evidence

Source change, 2 November 2026. Deployment and live acceptance are separate.

## Builds resolve the current official stable installer

`dashboard/scripts/omarchy-proxmox-lab.ts` resolves the current official stable
Omarchy v4 release at each operator plan/build invocation. It resolves the
release tag to an immutable Git commit and retrieves the checksum for that exact
ISO filename. It passes those resolved values into the generated launch script,
which verifies the ISO bytes before use. Failed metadata requests do not silently
fall back to an older installer. Unsupported new major versions fail explicitly;
the browser desktop contract currently accepts validated Omarchy v4 releases.
Teardown needs no upstream lookup.

The plan and launch output include the resolved release, commit and ISO checksum.
The host retains the selection in
`/var/lib/hivra/omarchy-receipts/<vmid>-<operation>.installer.json`. This receipt
identifies the selected installer; it does **not** prove the unattended install
finished or that the resulting machine still runs that version. The deterministic
builder's vetted example was updated from 4.0.2 to 4.0.6; the CLI resolves upstream
rather than relying on that example as its future default.

Verified official metadata for 4.0.6:

- Release: `v4.0.6`
- Git commit: `237f1b4071a0bff2296c6d740ba2b9fd695ebfa0`
- ISO SHA-256: `b542db5fecc37395d9af6654a8146ebed225f275ae4d5a6fcf432e40afe7bb88`

Sources: [official release](https://github.com/omacom/omarchy/releases/tag/v4.0.6),
[official ISO checksum](https://iso.omarchy.org/omarchy-4.0.6.iso.sha256),
[official unattended-install contract](https://github.com/omacom/omarchy/blob/237f1b4071a0bff2296c6d740ba2b9fd695ebfa0/manual/51-unattended-installs.md).

## Customer launches claim a prepared computer

The current Launch Omarchy path posts to `/api/hivra/prepared-computers` and
claims the exact slot configured in `HIVRA_PREPARED_COMPUTERS_JSON`. It does not
run the operator installer or build a fresh computer for each customer.

A new claim resolves the official stable v4 release, reserves a real pending
owner row under the paid slot and provider-slot locks, then dispatches a durable
host operation. A five-minute process cache/singleflight bounds repeated
upstream requests; metadata failures never reuse an expired release pin.
Each reservation retains its immutable release/commit/checksum. Retries inspect
that same operation and never select a different release mid-update.

The guest uses the stable native package helpers with existing narrow sudo
grants, backed up root/home/boot/config surfaces, reviewed system migrations,
and user-context migrations. It then verifies the exact requested package/OS
version, selected UKI digest and rebooted running kernel, graphical processes,
audio and the Hivra desktop services. A terminal receipt admits the row to
`running` through an exact owner/operation/authority database RPC. The stored
`omarchy_release_receipt` records the initial claim observation; it is not a
promise that later owner updates preserve that software version. The stale
`/usr/share/omarchy/version` file is deliberately not used.

An existing owner's claim returns their existing computer, without running an
upgrade or consulting GitHub. Owner-initiated upstream updates remain available
inside the desktop. Opening an existing customized computer must not silently
upgrade its OS or reboot it.

## Deployment and acceptance boundary

The durable prepared refresh is implemented in this source revision. It needs
migration `20261103010000` and the matching dashboard release before new claims
can use it. It resumes admission/cancellation through the normal detail GET;
closing the tab does not kill the native job, and opening it again resumes
observation. Generic provisioning recovery and purge exclude these operations.

No live deployment, database migration or customer launch is established by
source tests. See [the rollout and recovery notes](OMARCHY-PREPARED-REFRESH.md)
for migration compatibility, an empty disposable fixture, real desktop/input
acceptance and failure preservation.
