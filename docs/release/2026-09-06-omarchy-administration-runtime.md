# Sunshine administration runtime acceptance

Scope: actual pinned Sunshine authentication using the unchanged v3 preparation
from source `4445e9426`. This is a local disposable Linux runtime test, not an
Omarchy guest, desktop, pairing, guardian or public connection acceptance.

The previous source-only hash-format check was insufficient to establish that
Sunshine would load and accept the generated administrator file. This checkpoint
starts the actual official binary as non-root UID/GID10000 with the preparation's
unchanged configuration and tests its HTTPS administration interface.

## Artifact and containment

- Official release `v2026.516.143833`, GitHub release target
  `14ffa6fdaa53f7b51512be2b3d24f3939695403c`.
- [Official Debian trixie amd64 package](https://github.com/LizardByte/Sunshine/releases/download/v2026.516.143833/sunshine-debian-trixie-amd64.deb)
  SHA256 `b9b65f2be93b3e30be0710a940a616b1381da5bc6d858dce33bc0094d7fd4131`,
  matched GitHub release asset digest before use.
- Extracted `/usr/bin/sunshine` SHA256
  `d1cd30c8aa06824801b074de6aadc7ff3f75f9d63a0b69e2cddfb1a15b3f633c`;
  `--version` reports the same release and source commit. The smoke test checks
  both before starting a service.
- Local test image
  `sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763`.
  Built from cached Debian trixie image
  `sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
  satisfying the package's declared dependencies through Debian apt. Sunshine
  was extracted with `dpkg-deb -x`; its modprobe/setcap/udev postinstall was
  inspected but not executed. Dependency versions are not a release lockfile;
  this is a test fixture, not a shipped runtime image.
- Runtime: `--platform linux/amd64 --network none --read-only`, repository
  read-only mounted, `/tmp` tmpfs, no published ports or device mounts. Service
  environment and test credentials are newly generated, with no provider secrets.
- The test trusts its generated TLS certificate; hostname comparison is disabled
  only because the certificate names the fixture computer while the test connects
  over loopback. Certificate validation is not disabled.

## Actual observations

On each of two fresh Sunshine process launches, against the same prepared files:

| Action | Result |
| --- | --- |
| GET `/api/config`, no credentials | 401 |
| GET `/api/config`, incorrect password | 401 |
| GET `/api/config`, prepared administrator credentials | 200, expected runtime version |
| POST `/api/password`, no credentials and no Origin/Referer | 401 |
| GET `/api/clients/list`, prepared credentials | 200, zero paired clients |
| Compare all prepared resources after requests | Original bytes unchanged |
| Stop process, inspect TCP ports47984/47989/47990/48010 | Closed before next launch |

The test's temporary directory was removed. No customer computer, VM, cloud
server, live firewall, route, Canary deployment or external authentication was
changed. Hetzner reservation remains £6.90/£10; no additional spend.

The initial fixture refused before launching because Docker Desktop's network-none
namespace includes dormant kernel tunnel interfaces. Read-only inspection found
no IPv4 routes and no traffic on those interfaces. The corrected guard requires
every non-loopback interface to be down and no IPv4 routes; it never changes them.
This was a fixture prerequisite correction, not a Sunshine product failure.

## Repeatable command

```sh
docker run --rm --name hivra-sunshine-admin-auth-check \
  --platform linux/amd64 --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev -e PYTHONDONTWRITEBYTECODE=1 \
  --mount type=bind,source=/Users/example/Projects/Hermesdeploy-canary,target=/work,readonly \
  sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763 \
  /work/dashboard/runtime-adapters/omarchy-native/admin-auth.smoke.py
```

Final main-agent rerun passed both launches with the exact binary hash check.
Independent reviewer `core_gap_map` found no concrete P1/P2 and independently
reran the exact image: both launches passed, process waits completed, checked
TCP listeners closed, temporary state was removed, and no test container
remained. `git diff --check` passed. Status: PASS for this isolated
administrator-authentication smoke only.

No activation API or capability flag is enabled by this test.
Omarchy's Arch package/Hyprland, capture/encoder/audio,
input, client certificate enforcement, guardian deadlines and cgroup teardown,
native broker/Mac integration and the private connection path remain unverified.
Rollback is a source revert of this test/receipt; no live rollback is needed.
