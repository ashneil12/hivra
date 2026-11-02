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

A new claim now records the guest's observed pacman `omarchy` package version,
matching `/etc/os-release` version, kernel release and observation time before
inserting an owner row. The host stores that observation atomically as
`<vmid>-<claim>.observed.json` and the new-claim response includes
`launch_os_receipt`. That field is a launch-time observation, not a new database
column or a stored promise that a later GET represents the same software state.
The stale `/usr/share/omarchy/version` file is deliberately not used: it can say
`4.0.0.alpha` on released packages.

An existing owner's claim returns their existing computer, without running an
upgrade or consulting GitHub. Owner-initiated upstream updates remain available
inside the desktop. Opening an existing customized computer must not silently
upgrade its OS or reboot it.

## Remaining automatic-refresh gap

This change makes new operator builds follow current upstream releases and makes
new customer claims report the actual installed version. It does not make a
prepared slot automatically update itself before every future customer claim.
The live prepared computer must be updated separately through the native updater
and then accepted on its public desktop path.

A safe automatic refresh of an **unclaimed** prepared slot needs a durable
operation and a status the launch flow can observe while updates and reboots run.
The current claim holds a 30-second synchronous host call and inserts its owner
row only after readiness. Existing `desktop_prepare` requires an already owned,
bound, running computer; it cannot supply an unclaimed-slot update identity.
Putting a long `omarchy-update` call inside the claim would time out and invite
concurrent or repeated updates. A refresh operation must resolve and retain the
requested official stable version, serialize against claims/lifecycle, preserve
ownership and user state, verify the rebooted package/kernel/desktop, and admit
the claim only after its own completed receipt. That operation is not implemented
by the installer resolver or by a version observation.
