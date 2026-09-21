# Omarchy guardian client-certificate prerequisite

Status: PASS for the corrected certificate prerequisite and isolated runtime
smoke. No session admission or guardian activation is implemented by this
checkpoint.

## Why the planned guardian step changed

The next step was a session-bound guardian. Its exact-client requirement could
not safely rely on a supplied fingerprint plus one paired Sunshine record:
[pinned Sunshine's verifier](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/crypto.cpp)
uses OpenSSL certificate-chain trust, and
[the native HTTP handler](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/nvhttp.cpp)
allows a successfully verified certificate unless its exact record is disabled.
An unlisted descendant of a paired CA therefore has a path to authorization.

The initial actual-runtime experiment confirmed that behavior. This is not a
claim of a newly exposed live Hivra vulnerability: native session activation is
still absent and disabled. It is a necessary admission condition for the
unimplemented guardian, identified before enabling it.

## Source change

`client_certificate()` in the existing v3 supervisor module checks a single
bounded PEM, exact DER SHA256, explicit basicConstraints `CA:FALSE`, no
certificate-signing key usage, matching issuer/subject, and the actual
self-signature. It returns canonical public certificate PEM, never a private
key. OpenSSL runs with a fixed environment, bounded calls, and a private
temporary public-certificate file removed afterward. Invalid input fails closed.
There is no new command, activation marker, network API, grant consumption,
broker path or capability publication.

Independent review found a P2 in the initial absent-CA-text check: X.509 v1
and legacy Netscape certificate-type inference can grant issuer capability
without `CA:TRUE` text. A failing v1 regression was captured before tightening
the implementation to require explicit `CA:FALSE`. The test suite also covers
Netscape inference, absent constraints, keyCertSign, malformed/multiple PEM,
wrong fingerprint and a corrupted self-signature with a matching fingerprint.

Compatibility is deliberately explicit: the forthcoming isolated native client
recipe must generate a non-CA certificate with `CA:FALSE`. A stock Moonlight
certificate without that constraint is not accepted. This is not yet wired
into a functioning Moonlight client profile or guardian.

## Actual pinned-runtime evidence

Runtime image, official package and binary identities are the same as
[the administrator authentication check](2026-09-06-omarchy-administration-runtime.md):
Sunshine `14ffa6fdaa53f7b51512be2b3d24f3939695403c`, binary SHA256
`d1cd30c8aa06824801b074de6aadc7ff3f75f9d63a0b69e2cddfb1a15b3f633c`,
image `sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763`.
The runtime smoke checks that exact binary hash before launch.

Five fresh Sunshine process launches in a disposable `--network none` container
tested the following test-owned pairing states. Unsafe fixtures are intentionally
loaded despite the policy rejection only to establish their trust semantics.
No live service or existing pairing store is used.

| Sole paired certificate | Guardian policy | Same client `/applist` | Signed unlisted child `/applist` |
| --- | --- | --- | --- |
| A: explicit CA:TRUE | Reject | 200 | 200 |
| B: explicit CA:FALSE | Accept | 200 | 401 |
| C: v3, no constraints | Reject | 200 | 401 |
| D: true v1, no extensions | Reject | 200 | 200 |
| E: Netscape sslCA, no constraints | Reject | 200 | 200 |

These are XML protocol status codes. Sunshine returns HTTP200 even for these
401 authentication refusals; the smoke checks the protocol result. Every other
test identity was rejected for each paired state, including A/A-child after B
started. All original prepared resource bytes remained unchanged.

Commands:

```sh
docker run --rm --name hivra-sunshine-client-cert-smoke \
  --platform linux/amd64 --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev -e PYTHONDONTWRITEBYTECODE=1 \
  --mount type=bind,source=/Users/example/Projects/Hermesdeploy-canary,target=/work,readonly \
  sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763 \
  /work/dashboard/runtime-adapters/omarchy-native/client-certificate.smoke.py
```

The same container options with `supervisor.test.py` passed **18 tests**. On
macOS, **11 passed / seven explicitly skipped** (six Linux OpenSSL policy tests
and one root/service UID test). `git diff --check` passed. Independent reviewer
`core_gap_map` reran all 18 Linux tests and the five-identity actual Sunshine
smoke, found no remaining P1/P2, and confirmed listener/state/container cleanup.

## Limits and next work

This proves the corrected certificate prerequisite and actual configured
Sunshine trust behavior. It does not prove a functioning guardian, one-use grant,
revocation, media/input termination, cgroup backstop, controller release, native
Mac pairing/profile, Omarchy/Hyprland guest or private connection path. The
test-owned state switch is not a product session transition implementation.

Next implementation must use this prerequisite within the already planned
root guardian and one-use lease lifecycle, with separately owned session state
and systemd backstop. Do not add another public pairing or activation shortcut.

Owned process waits completed, checked TCP ports closed after each launch, and
test temporary state was removed. Final main-agent Docker inventory after
review found no named test containers remaining. No VM, provider server,
route, firewall or Canary deployment changed;
no additional spend, £6.90/£10 conservative Hetzner reservation unchanged.
Rollback is a source revert through the existing branch/PR; no live rollback
is needed.
