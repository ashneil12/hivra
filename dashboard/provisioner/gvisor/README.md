# gVisor adapter: local image operation

The adapter pulls the pinned Linux/amd64 image on create and update by default.
On an already prepared, registry-isolated host, an operator can opt the adapter
into **local-image-only** create and update:

1. Install the exact adapter bytes from the Git revision serving the control
   plane. Verify their SHA-256 before installing the file as root, mode
   `0700`, at `/opt/hivra/gvisor-adapter/hivra-gvisor-adapter`. Preserve the
   verified runsc bundle, runtime and sidecar receipts; host preparation itself
   still downloads its pinned dependencies and is not an offline installer.
2. Import the trusted image into the host's Docker image store. The import
   must preserve the repository digest, not merely the image ID or a tag.
   `docker image inspect` of the full reference below must resolve to a single
   image whose `RepoDigests` contains the exact Docker Hub Python digest, with
   `Os` set to `linux` and `Architecture` set to `amd64`.
3. Write the full reference below as the only line of
   `/opt/hivra/gvisor-adapter/offline-image`. Make it a root-owned regular file
   with mode `0600`. A missing, mismatched or unverified local image is an
   error in this mode, not a reason to fall back to the registry.
4. Run the normal product host inspection and gVisor readiness check again to
   record the new adapter digest before launching. Keep the host dedicated
   during its identity transition: existing managed bindings are tied to the
   exact adapter digest. To restore normal image pulls, remove the opt-in file.

```text
python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285
```

## Managed storage admission (off by default)

`HIVRA_MANAGED_GVISOR_DISK_ADMISSION_ENABLED=true` requires storage admission
for managed Create and owner Start. It does not change self-managed operations
or gate Stop and Delete. Do not enable it on a target until its storage
mapping, quota enforcement, and recovery and workload budgets have been
verified. Host preparation installs the fixed XFS probe and the exact
quota helper. There is no default budget or automatically enabled policy.

The shipped probe reads root-owned mode `0600` policy
`/opt/hivra/gvisor-adapter/storage-admission.json`. Version 1 supports
`backing: "reserved-fixed"` with a provisioner-verified, thick-backed writable
XFS mount, its exact `mountSource` and `mountUuid`, Docker's `local` log driver,
and a standalone containerd whose persistent root is on the same XFS mount.
Docker and containerd runtime state must use the same `/run` tmpfs.
Configure both services to require the XFS mount before starting so mount
failure cannot redirect persistent writes to the OS filesystem.

The policy supplies `xfsWorkspace` with `docker_socket`, `docker_root`,
`xfs_mount`, `first_project`, `last_project`, `hard_bytes` and `hard_inodes`
(and optional `docker_pid_file`). The project range and workspace filesystem
must be dedicated to this allocator. It reserves an ID before workspace use,
proves XFS project accounting, enforcement and inheritance, and rejects
drift or an identity collision without retagging an existing volume. It
does not recycle quota IDs automatically. Set `persistent` and `volatile`
with separate measured `bytes` and `inodes` values for `recovery`, `setup`
and `restart`.

The root-owned, non-symlink executable at
`/opt/hivra/gvisor-adapter/storage-admission-probe` receives four arguments: operation
(`create` or `start`), owned container name, workspace volume name and network
name. It runs under the adapter's host lock and must return fresh evidence
without changing Docker, mount or pool state. If it cannot verify every write
path, the backing topology, and the workspace quota, it must exit nonzero.
The adapter denies admission on missing or malformed probe evidence and never
pulls an image to satisfy an admitted Create.

The probe returns a single JSON object with `version: 1`, `backing: "fixed"`
or `"thin"`, `filesystems` and `pools`. Each filesystem has a real directory
`path`, grouped by kernel filesystem identity, and separate `bytes` and
`inodes` budgets. The adapter samples availability at each path with
`statvfs`. Include all storage used by Docker, containerd, runsc, logs and the
workspace. Sum distinct write costs that share a filesystem; never list
another path on the same filesystem as separate capacity.

Each budget supplies nonnegative integer `recovery`, `outstanding`,
`workspace`, `setup` and `restart` quantities, with a positive recovery
floor. Count outstanding unallocated quota commitments across running and
stopped workspaces, excluding bytes and inodes already reflected in used
space. For the workspace mount, the adapter adds live XFS commitments to any
outstanding non-workspace commitments from the probe. Create adds the new
enforced workspace quota and measured setup peak.
Start adds only the measured restart peak and does not add the retained
workspace quota again. For Create the adapter applies and reads back hard
byte and inode quotas before initializing the Docker named volume.

A thin pool entry supplies an exact `identity`, `writable: true`, and
separate `data` and `metadata` objects, each with `available` bytes and a
`budget`. Check filesystems and backing pools independently. Only use
`"fixed"` with an empty pool list when the outer storage is verified as
physically backed without an applicable thin constraint. A VM's guest
filesystem stats alone do not establish that. For a shared pool, provide an
exclusive or pre-reserved envelope; the adapter lock cannot serialize other
pool writers. The shipped probe rejects thin or unverified backing; it does
not infer fixed capacity from guest filesystem stats. No values for production
are supplied by this repository.

A typed low-disk Start refusal can settle a managed computer as stopped only
after separately verified stopped evidence. Unknown outcomes remain held.
Read off and drain existing managed bindings before updating a target's
adapter digest; refreshing a ready target while bindings pin its prior digest
can block their lifecycle calls.
