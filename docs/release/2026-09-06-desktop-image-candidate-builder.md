# Desktop image candidate builder

## Scope

Source-only preparation tool for a future pinned desktop-image release. This
does not change the guest installer, provider bundles, running computers, or
Canary. It does not make launches faster yet.

Use a dedicated, owned Linux amd64 Docker builder with `/usr/bin/docker`, enough
disk for the base image, derived image and archive, and a trusted private parent
directory. Do not run on a retained customer desktop or shared hypervisor. Local
Docker images and layers remain after a build; inspect ownership before cleanup.

From the repository root, choose a new absolute output path:

```sh
python3 dashboard/scripts/build-desktop-image.py --uid 1001 --gid 1001 --output /absolute/private/new-candidate
```

The tool pulls the installer's pinned base and calls its unchanged identity-image
builder. It never copies a running guest, starts a desktop, publishes an image,
or adds an approval. `candidate.json` says `candidate-not-approved`, records the
hash of the installer bytes actually executed, and hashes `desktop-image.tar`.
The source builder validates image identity and filesystem-layer ancestry; the
archive hash alone is not independent verification of its contents.

Output is exclusively created (directory 0700, files 0600). Export and hashing
use a stable file descriptor, with output-directory identity checks across long
operations. A replaced directory aborts without overwriting files there. Use a
trusted parent: this is not a sandbox against hostile same-user processes.
Failed attempts retain partial output for inspection and are never approved.
Commands have bounded timeouts; no automatic retry or deletion is performed.

## Verification and remaining work

- Eight local tests pass, including archive-entry replacement and directory replacement during build and
  export, exclusive output, invalid identity, empty archive rejection, permissions,
  source provenance, and stdout-based export.
- Existing installer and sealed runtime source remain unchanged.
- Existing guest-phase tests pass (19), as do guest-installation,
  capability-inspection and provisioner-release suites (69 tests); CLI help and
  whitespace checks pass. These are local checks, not live acceptance.
- At the source-only checkpoint, no real candidate image had been built,
  published, or accepted with this tool. The later campaign below supplies build
  and import evidence. Local tests alone do not prove a usable artifact or faster launch.
- Next: build on an owned Linux builder; independently inspect/load the artifact;
  define pinned distribution and approval; integrate admission in an additive
  versioned provider release; then measure a normal Canary launch.
- Rollback: revert the source-only tool and tests. No live rollback is needed.

Independent review caught an overwrite hazard in the initial pathname-based
export. The retained-directory/exclusive-file-descriptor implementation and
replacement regressions address that finding.

## First real candidate campaign

Source `fae3bc43ec71b032dbe518f775bf0e90284c734a` was staged on a newly
created, owned Canary fixture on 2026-09-06. The normal Hivra launch flow created
`CANARY_IMAGE_BUILDER_0906`, computer `00000000-0000-4000-8000-000000001099`,
at 09:16:05 UTC, using included 2 CPU / 4 GB capacity, not new Hetzner spend.
Its allocation operation was `00000000-0000-4000-8000-000000001100`;
VM 1130 on node-b had binding `hivra-bind-f006bd57e8cef021fd1c9fb32b25591c`.
All retained computers were excluded. Canary remained on deployment
`dpl_BgQgoW5ySZixG5n3hycdXd4YNHKi`; no dashboard deployment was needed.

The original installer completed, its PID file disappeared, and the operation
cleared before the candidate builder began at 09:29:44 UTC (guest PID 26468).
The builder invoked the unchanged source recipe with UID/GID 1001, using the
fresh build cache. It did not snapshot a running container or guest filesystem.
Export exited zero by 09:31 UTC. Guest root storage still had 19 GB available.

- Builder source SHA-256:
  `6e1908d2e232a68cd1979d277dc02f67a2c6a63e9235115dc66b77c463a28d8f`.
- Executed installer SHA-256:
  `6f5c3825589e882507bad5db35c28c6a6ce52e055db149516f9eeb87eaca5433`.
- Recipe SHA-256:
  `fb3ff9f7074c8f021f2470f13fff72f6fc6063be12494d0e66646f413d577b39`.
- Runtime image:
  `sha256:ee596064f9a341a3a75841027e8d0a5f251b299ac144fab6ce7d1421f6c8a34b`.
- Candidate archive: 4,124,832,768 bytes, SHA-256
  `08e5d4f557da6f037ada4630bcd4ba9bf96083cbe11f98c84105bcf08e4b8578`.

The source-stage checks above are distinct from independent artifact inspection,
distribution, installation, and cleanup, whose results must be recorded below.

### Artifact inspection and import

Local archive readback matched the recorded SHA-256 exactly. Independent review
verified all 34 content-addressed blobs, compressed-layer digests and all 34
ordered uncompressed diff IDs, with no mismatch. The source archive matched the
committed installer and builder; the generated RUN matched the final filesystem
history command. No guest home directory or running-container snapshot was used.
The review's final-layer metadata scan also found UID/GID 1001, no remaining
1000-owned entries in that layer, and the two reviewed special modes preserved.

The pinned base is an OCI index. Its Linux/amd64 child manifest is
`sha256:79872baa12a761512f4395655bfc53aeb692058f46feaeda20793e963b9bfbd0`.
A read-only registry query and direct comparison proved that its 33 ordered
layer digests exactly match the candidate's first 33. Base config preservation
remains supported by the source builder's checks rather than an independent
base-config retrieval in this campaign.

Actual local Docker import succeeded. Inspection found Linux/amd64, user
`ubuntu`, `/etc/container-entrypoint.sh`, `/home/ubuntu`, 34 layers, no tags,
and the exact recipe/UID/GID labels. No container was started. This is import
acceptance, not prepared-image guest or public-desktop acceptance.

**Important admission constraint:** the originating engine reports OCI manifest
digest `ee596064f9a341a3a75841027e8d0a5f251b299ac144fab6ce7d1421f6c8a34b`
as its image ID. Local Docker reports config digest
`0a82b716e1e744f7344ea857bd7b69dba29500d893a40867bf13f524fb76bef0` after
importing the same archive. A release approval must bind archive, manifest,
config and platform separately; it must not assume the receipt's originating
`runtimeImageId` is portable across Docker storage backends or weaken identity
checks to accept arbitrary IDs. No admission shortcut was enabled.

### Cleanup

Normal Manage → Destroy, with the exact fixture name, completed before
09:36 UTC, ahead of the 10:00 deadline. Database state is deleted with null VM
and operation, and cleared token/tunnel reference. VM config, VM-1130 volumes,
installer PID/file and the owned temporary SSH-known-host directory are absent.
Both authoritative DNS servers return NXDOMAIN for the fixture hostname.
Caddy remains active; full host VM inventory hash returned to
`337f1c3b2eee15e644950801a1e886f9fd37be360b74de05b16f8e0cc2beb868`.
The session row `00000000-0000-4000-8000-000000001101` was revoked at
09:35:15.532802 UTC and input released at 09:35:15.784897 UTC. Although Manage
was selected during setup, a session did exist; do not claim zero sessions.
External tunnel deletion was not separately enumerated.

The locally imported image was uniquely additional to the pre-test inventory,
had no tags or containers, and was removed with its unused layers. Image-list
hash returned to `944ce8af8202705e99a5aa3f916ddb7b6df812ccd3e50fa2c3cb1d4c528b106c`;
container-list hash remained
`b6a575920bbe8885091b511496c77b309e660550ef72e3890e0d7102db5da35e`.
The archive, source archive and candidate receipt are retained locally under
`.hivra-data/desktop-image-candidates/fae3bc43e-uid1001-gid1001/` (Git-ignored),
with the original temporary directory moved rather than a second archive copy.
The UI returned to the four original running computers. Artifact integrity and
import gate: PASS; prepared-image runtime acceptance remains open. No new spend,
retained-computer mutation, image publication, or prepared-image deployment
occurred. Launch speed is not yet improved or measured on an optimized path.
