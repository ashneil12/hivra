# Self-host Hivra quickstart

**Status:** Implemented review path. Local authentication and the production
dashboard build have passed focused tests and a local HTTP/browser smoke test.
A local source-checkout recovery rehearsal has also passed authenticated
encrypted backup/restore, exact database-marker and uploaded-file byte checks, guarded uninstall,
master-key rewrap with rejection by the retired key, and zero retained Hivra
containers, volumes, or networks.
A live source-checkout acceptance run also created and prepared a fresh Hetzner
computer, launched Codex through the original agent flow, opened the native
interfaces, captured the installed-state receipt/SBOM/notices, and removed every
provider resource. Clean-machine repetition from the exact committed public
source candidate, provider-agent restart and model inference remain release
gates.

Release reviewers can now repeat the local control-plane half from the exact
committed source archive rather than trusting a developer checkout:

```bash
mkdir -m 700 /absolute/private/public-source-rehearsal
cd dashboard
npm run test:self-host-public-source -- \
  --work-dir /absolute/private/public-source-rehearsal
```

The command requires a clean committed tree, builds the private fail-closed
public-source candidate, installs the candidate's exact dashboard lockfile in
the extracted Git archive, runs the prerequisite doctor, then completes the
authenticated encrypted backup/restore, master-key rotation, and guarded
uninstall rehearsal from that Git-free export. On success it removes the
candidate, extracted source, and nested local state and leaves one owner-only
`public-source-bootstrap-e2e.json` receipt. It does not create provider capacity
or turn a private review candidate into a public release.

This is the simple single-operator path. It keeps the control plane, database,
credentials and provider connections under the operator's control. It does not
require a Hivra Cloud account or Clerk, and hosted payment endpoints are disabled.

## Requirements

### Failed recovery and interrupted Docker operations

If a restore fails and Docker cannot prove that its temporary containers,
volumes and network were removed, the launcher retains its owner-only
`.hivra-restore-…/state` directory and prints that exact path. Keep it and the
original encrypted backup: `database-runtime.json` and the private control-plane
configuration identify the resources that need reconciliation. Do not delete
the directory or start a second restore to hide an unresolved cleanup failure.
The incomplete directory is recovery evidence, not a ready installation.

Backup/restore also reconciles the original storage container after a lost stop
acknowledgement. It restores a previously running service only after inspecting
that exact container; an unavailable Docker daemon remains an explicit failure.

### Supported local environment

- Linux or macOS. On Windows, use WSL 2 for this review path.
- Node.js 22.22 or newer in the Node 22 line.
- At least 4 CPU cores, 8 GB RAM and 20 GB free disk for a comfortable local
  control-plane setup. Agent computers need additional provider capacity.
- A running Docker-compatible engine: Docker Desktop, OrbStack, Rancher Desktop,
  Podman with Docker compatibility, or Colima.
- `npx`, used to run the pinned Supabase CLI `2.116.0` regardless of any older
  machine-global CLI. A repository-local Supabase binary takes precedence when
  present, but it must match the pinned version before services can start.

The local Supabase services are containerized. The launcher explicitly binds
published ports to `127.0.0.1` and checks both stored bindings and actual mappings.
The network's default binding alone is not sufficient on Docker Desktop.
Do not expose these ports directly to the public internet.

## Install

From a clean checkout:

```bash
cd dashboard
npm ci
npm run self-host:doctor
npm run self-host:init
```

`init` performs these concrete steps:

1. verifies Node, dependencies, the container runtime, the Supabase CLI and the
   committed database inputs;
2. creates a private container network and scopes explicit loopback port bindings
   to this installation's Supabase commands;
3. starts the local Supabase subset and applies every committed migration plus
   the deliberately empty seed;
4. asks for one operator email, name and password;
5. generates separate encryption, chat-encryption, session, API and cron keys;
6. writes an owner-only private configuration and non-secret receipt outside
   the repository; and
7. builds the dashboard in local-auth mode with hosted credentials removed from
   the child environment.

The default private state directory is `~/.config/hivra` on Linux/macOS and
`%APPDATA%\Hivra` on Windows. To select an explicit location outside the source
checkout:

```bash
npm run self-host:init -- --state-dir /absolute/private/hivra-state
```

The command refuses to overwrite an existing installation. It never runs
`supabase db reset`, never links a cloud Supabase project and never prints secret
values. For non-interactive test automation only, provide the password through
the process environment as `HIVRA_SETUP_PASSWORD`; it is removed from build and
runtime child environments after hashing.

Options use separate name/value pairs, such as `--state-dir /absolute/path`.
Unknown, command-inappropriate and duplicate options are rejected before any
operation starts. A misspelled state-directory option does not fall back to the
default installation. Keep passwords in the interactive prompt or the documented
test environment variable, not in command-line arguments.

## Start and stop

```bash
npm run self-host:start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The sign-in page is the
installation-owned Hivra operator screen. Its session is a signed, expiring,
HttpOnly, SameSite-strict cookie. The self-host build does not load Clerk's
browser runtime. Self-hosted `/sign-up` redirects to this operator screen
instead of implying that the independent installation can create a hosted
account.

When Local Hivra is created through the macOS app, the app stores the exact
installation-only operator sign-in in macOS Keychain. It submits those
credentials only after the app has verified its managed runtime is running at
`http://127.0.0.1:3000`; redirects are rejected. The app uses the existing local
login endpoint, installs the returned session cookie into its private web view,
and then opens the same dashboard used in a browser. It never sends the local
credential to a Hivra Cloud, custom, alternate-port, or alternate-loopback
profile. Browser and remote access still use the local operator screen, and
none of these paths requires a Hivra Cloud account.

Remote provider computers need an HTTPS route back to the control plane during
automatic first-boot preparation. If an operator-managed tunnel already routes
to the local `127.0.0.1:3000` listener, bind its origin explicitly:

```bash
npm run self-host:start -- --public-url https://your-control-origin.example
```

Hivra persists only an origin-only HTTPS URL; credentials, paths, query strings,
fragments and plain HTTP are rejected. Run with `--public-url local` to return to
local-only mode. The dashboard itself remains bound to loopback, and this release
does not claim that an account-less quick tunnel is a production ingress.

The control-plane callback URL above is separate from each agent's public
interface. Provisioner `2026.08.30.2` adds a standalone provider-VM access path:
the computer's verified IPv4 receives an exact `sslip.io` HTTPS hostname, and
the computer terminates TLS using a pinned Caddy installation. This path does
not require a Hivra Cloud or Cloudflare account. It requires the prepared
computer's verified SSH/HTTP/HTTPS firewall policy and does not silently alter
older SSH-only computers. The hosted service retains its named tunnels.
This addition remains under [live acceptance](../release/VERIFICATION-STATUS.md);
do not treat local tests as proof of TLS issuance, model inference or teardown.

Check the two local processes without printing credentials:

```bash
npm run self-host:status
```

Stop the database containers while preserving their volumes:

```bash
npm run self-host:stop
```

Older review installations may have Docker Desktop containers with wildcard
port bindings. The updated launcher refuses to reuse those containers. Run
`self-host:stop`, then `self-host:start` with the same `--state-dir` to recreate
the containers while retaining their database and storage volumes. This does
not uninstall the application or erase its data. Do not start old containers
directly through Docker Desktop before that migration.

Stopping the foreground dashboard with `Ctrl-C` does not delete the database,
provider connections or agent records. Do not use `supabase stop --no-backup` or
`supabase db reset` on an installation you intend to keep.

## Encrypted backup and recovery

Stop the dashboard, create an owner-only directory outside the checkout and
installation state, then write an encrypted backup:

```bash
mkdir -m 700 "$HOME/hivra-backups"
npm run self-host:backup -- --output "$HOME/hivra-backups/operator.hivra"
```

The command asks for a 16-character-or-longer passphrase, streams a data-only
dump of the local `auth`, `public` and `storage` schemas, and captures uploaded
file bytes from this installation's local storage volume. The storage service
is stopped for both captures and restarted afterward. The dump, files,
configuration and installation receipt are bound to an authenticated manifest
and encrypted with AES-256-GCM. It does not print credentials, database rows or
uploaded contents. `self-host:export` is an alias for the same portable artifact.

This backs up the standalone control plane, not remote agent-computer disks.
It supports the pinned local file-storage backend; external S3 storage is not
silently treated as backed up. Older payload-v1 archives never included uploaded
file bytes. Restore rejects those archives if they contain uploaded-object
metadata; create a new backup from the original installation instead. Empty
legacy storage remains compatible.

Restore is deliberately non-overwriting. Choose a new state directory whose
parent already exists; Hivra creates the restored state as owner-only:

```bash
mkdir -m 700 "$HOME/hivra-restores"
npm run self-host:restore -- \
  --input "$HOME/hivra-backups/operator.hivra" \
  --state-dir "$HOME/hivra-restores/recovered"
npm run self-host:start -- --state-dir "$HOME/hivra-restores/recovered"
```

Restore authenticates every byte before extraction, validates the exact payload,
creates an isolated local database and storage volume, restores the captured
schemas and uploaded files without overwriting existing object data, rebinds
the recovered dashboard to newly generated local Supabase credentials, and
builds it before publishing the new state directory. Keep the passphrase outside
the checkout; a lost passphrase cannot be recovered by Hivra.

## Rotate the standalone master keys

Stop the dashboard, ensure no model-key change, agent launch, or first-boot
enrollment is in flight, and preview the installation-bound operation:

```bash
npm run self-host:rotate-keys -- --state-dir "$HOME/.config/hivra"
```

The preview performs read-only coverage checks and prints a confirmation token.
Choose a new backup path outside both the checkout and installation state, then
run the exact displayed command:

```bash
npm run self-host:rotate-keys -- \
  --state-dir "$HOME/.config/hivra" \
  --backup-output "$HOME/hivra-backups/before-key-rotation.hivra" \
  --confirm ROTATE-REPLACE_WITH_PREVIEW_TOKEN
```

Before changing ciphertext, Hivra creates the encrypted backup using the backup
passphrase. It stages new and recovery keys in owner-only files, compare-and-swap
rewraps every supported stable secret and stored-chat surface, then repeats the
complete scan with only the new primary keys. The active configuration changes
and the staged recovery keys are removed only when that second pass applies zero
updates. `LAUNCH_FINGERPRINT_KEY` is intentionally unchanged.

If any bounded dependency count is non-zero or unknown, rotation fails closed.
Finish or cancel the reported transient operation before retrying. If a rewrap
is interrupted, keep the dashboard stopped and rerun the same confirmed command;
Hivra resumes from the staged keys. Never delete staged files or the encrypted
pre-rotation backup as a workaround.

## Local uninstall

Delete every agent computer and provider capacity order through Hivra first so
the local control plane cannot leave a billable server behind. Keep an encrypted
export if you may need the installation again, stop the dashboard, then preview
the exact local removal:

```bash
npm run self-host:uninstall -- --state-dir "$HOME/.config/hivra"
```

The preview prints a confirmation token bound to that real state directory and
local database identity. Re-run the displayed command with `--confirm TOKEN` to
remove the local Supabase containers, volumes, private configuration and state.
The command fails closed if a non-deleted computer or provider capacity order is
still recorded, verifies that local container resources are gone before erasing
the state directory, and never deletes provider servers, hosts or cloud accounts.

## Connect compute

After signing in, open **Infrastructure**.

- Simple mode: add a Hetzner Cloud API token, select a location and size, create
  a server in Hivra, then prepare it. The token is encrypted at rest. The provider
  remains the source of truth for the server and its charges.
- Advanced mode: connect an existing host by pinned SSH identity, inspect the
  discovered capabilities, choose the supported isolation backend, then prepare
  it. Hivra must verify authority and readiness before that host becomes eligible
  for launches.
- Hivra Cloud remains an optional hosted provider. It is not required by this
  local installation and its commercial purchase flow is not embedded in the
  open self-host build.

Provider credentials belong in the encrypted Infrastructure flow, not in the
dashboard environment file. Model/API keys belong in the selected agent's
credential flow, not in source control or a URL.

## What is not yet a completed release claim

Reusable operator procedures are included for
[Proxmox storage and existing-VM repair](../operations/proxmox-fleet-storage.md)
and [state-preserving Workspace migration](../operations/workspace-migration.md).
These maintenance procedures require an explicitly selected target and backups;
they are not automatic installation steps.

- Windows-native packaging and an Electron wrapper are not implemented in this
  review path.
- The initial public source export passed a clean local installation and recovery
  rehearsal, including database recovery, storage, restart and key rotation.
  This does not certify every provider or runtime deployment.
- Source-export, SBOM and notice review passed for the initial public source
  release. Separately distributed images and installers need their own
  dependency, notice and source-obligation review.
- Fresh provider desktop admission and the staged cursor/profile update need
  the coordinated release work described in [staged desktop changes](../release/staged-patches/README.md).
- Provider-agent restart and model login/inference were not exercised by the
  source-checkout acceptance run.
- Hivra Cloud account linking from an independent local control plane is still a
  hosted integration boundary, not a local billing surface.

Use [the active roadmap](../../ROADMAP.md) and
[the canonical design](../superpowers/specs/2026-08-24-hivra-agent-computers-design.md)
for the remaining release gates. Target behavior in those documents is not proof
that the corresponding runtime path has passed acceptance.
