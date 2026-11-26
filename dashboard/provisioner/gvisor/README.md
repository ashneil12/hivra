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
