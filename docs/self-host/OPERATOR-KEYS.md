# Operator-owned custody keys

This is the standalone **fresh-install encryption-key helper** for advanced
operators and recovery work. The simple end-to-end setup is documented in
[QUICKSTART.md](QUICKSTART.md); it provisions local authentication and the
database as well as private configuration. Do not use Hivra's managed keys for
an independent installation.

## Before starting

- Use Node.js 22.22 or newer in the Node 22 line, on Linux or macOS.
- Use a local, unshared directory owned by your operating-system user. The
  helper refuses unsafe permissions, links, and macOS ACL access grants; it does not change
  permissions on existing files or directories for you.
- **If the installation already has encrypted data, restore its original keys.
  Do not generate replacements.** Losing the matching key can make provider
  credentials and stored conversations unrecoverable. The offline helper cannot
  determine whether your database is empty.

## Generate a dedicated key file

From `dashboard/`, choose an explicit, new file in your private configuration
directory, outside the repository. Substitute your actual directory below:

```bash
npm run setup:keys -- init --output /absolute/private/config/operator-keys.env
npm run setup:keys -- check --file /absolute/private/config/operator-keys.env
```

The command generates separate random 32-byte `ENCRYPTION_KEY`,
`CHAT_ENCRYPTION_KEY`, and `LAUNCH_FINGERPRINT_KEY` values. The third key binds
idempotent launch requests without coupling their long-lived identity to a
database-encryption epoch. It creates a new owner-only file, never overwrites
an existing path, and refuses initialization if custody-key variables are
already present in its shell environment. It prints status and the destination
path, **not the key values**. It makes no network request and does not connect to
or change a database.

`check` accepts a dedicated key-only file, not a general `.env` configuration:
ASCII comments/blank lines and one assignment per encryption-key variable.
Values must be exactly 64 hexadecimal characters, optionally single- or
double-quoted. `export` is allowed. Duplicate variables, public aliases,
interpolation, multiline values, colon assignments, and unrelated variables
are rejected. Optional legacy variables are checked but do not establish that
a rotation is safe.

Configure these three values through your deployment's **server-side** secret
configuration, or put them in the dashboard's private `.env.local` for a new
local installation. The generated file is not automatically loaded. Never use
`NEXT_PUBLIC_` names, paste values into a terminal command/history, or commit
the file. Do not replace an existing `.env.local` to perform this step.

Next.js can load values from the process environment and several `.env` files;
checking one file does not prove which values the running application uses.
The checker reports file format and local file-permission checks only, not
effective runtime configuration or full installation readiness. Its filesystem
boundary assumes a trusted local OS and owner; it does not protect keys from
root, malware running as your user, or untrusted network filesystems.

## Backup and recovery

Keep an encrypted backup of the exact keys in operator-owned secure storage,
separate from database backups. Keep the keys for each installation clearly
identified. A plaintext copy of the generated file is not an encrypted backup.
Avoid syncing it into a shared or public folder.

For recovery, restore the matching keys through the same server-side secret
configuration before accessing the recovered data, including the launch
fingerprint key. Do not run `init` to repair a decryption failure. The standalone
installer's encrypted backup/restore command has passed a complete local
source-checkout recovery rehearsal; this offline key helper still does not back
up or restore a database by itself.

## Existing installations and rotation

The runtime rejects malformed key values, including extra characters after a
valid hexadecimal prefix. Check the configured values without logging them
before rolling this validation into an existing deployment.

The low-level rotation tool remains separate from this helper. It defaults to a
read-only inspection and refuses `--apply` when a known transient key-dependent
record exists or its count cannot be read. Its stable writes use
compare-and-swap and identity cursors, so a concurrent edit is preserved and
reported instead of overwritten or skipped. `--coverage-only` performs bounded
non-null counts without loading ciphertext or requiring encryption keys.

Standalone installations should use `npm run self-host:rotate-keys` as described
in [QUICKSTART.md](QUICKSTART.md). That command stops at the coverage boundary,
requires an encrypted pre-rotation backup, keeps owner-only staged recovery keys
for resumability, rewraps stable provider/bootstrap/model/chat surfaces, and
retires the old primary keys only after a primary-only pass applies zero updates.
The launch-fingerprint key is deliberately outside this rotation. Existing
installations with version-1 launch identities remain blocked until those
records have a reviewed migration or retention path; do not delete them merely
to make a count reach zero.

## Still required for the first public release

This helper alone does not finish clean-host runtime and access-broker
installation, credential rotation, or the public-release security/evidence
gates. The simple installer now covers local operator authentication, local
database startup, migrations, private configuration, the production dashboard
build, authenticated encrypted backup/restore, portable export, and guarded
local uninstall with container-residue verification. A source-checkout recovery
rehearsal restored an exact database marker, authenticated the recovered
operator, rejected uninstall while a live computer record remained, and then
rewrapped a real encrypted credential, rejected its retired key, preserved
launch-fingerprint custody, and removed both installations without retained
local resources. A separate live
source-checkout run passed fresh Hetzner creation/preparation, Codex
launch/native access, installed-state evidence capture and exact provider
teardown. Repeating the complete lifecycle from the exact committed
public-source candidate on a clean machine, plus provider-agent restart and
model-inference acceptance, is still pending.
Track those in [ROADMAP.md](../../ROADMAP.md) and the
[canonical design](../superpowers/specs/2026-08-24-hivra-agent-computers-design.md).
