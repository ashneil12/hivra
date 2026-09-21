# Browser-sidecar dependency repair — 2026-09-06

## Scope and decision

Source-only repair on `codex/hivra-core-experience-plan`, based on `4452a85cb`.
Local dependency/install gate: PASS. Live image/publishing gate: not accepted;
no image was published or deployed and no fleet security claim is made.
Canary authority was not used to modify a runtime. No spend or user data changes.

## Cause and repair

An earlier private-address redaction commit (`5084c91c46c78c4699394e3f7c392b0931dd3995`)
also changed valid package version strings and registry tarball names. Installing
the old manifest failed with a registry 404 for nonexistent `html-to-text@10.240.1`.
Existing installed modules contained the real `10.0.1`, obscuring the defect.

Restore `html-to-text@10.0.1` and the `peberminta@0.10.0` tarball URL. Upgrade
Fastify to locked `5.12.3` (manifest floor `5.12.1`) and fast-uri v3 to `3.1.6`;
retain patched fast-uri v4 `4.1.3`. Fastify requires the accompanying
`process-warning@5.1.0` update. No private operational identities were restored.

Security floors follow the primary
[fast-uri advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-jqff-g426-hqxp)
and [Fastify advisory](https://github.com/fastify/fastify/security/advisories/GHSA-w2qp-rph6-63g4).
The actual AJV-linked URI parser previously converted an encoded scheme into
an unexpected authority in the new regression; the patched version passes.
This is a library reproduction, not demonstration of a remotely exploitable
sidecar endpoint. The mail parser's real HTML verification-code test remains.

## Evidence

- Baseline security tests: three failures (Fastify floor, fast-uri floor,
  encoded-scheme behavior); four passed.
- Updated full suite: 130 passed, four failed. All four failures are unchanged
  image-build tests reading absent `.github/workflows/browser-sidecar-publish.yml`.
  No test was skipped or weakened and no publishing workflow was recreated.
- Main-checkout TypeScript build passed.
- A new owned directory and empty npm cache installed the exact manifests with
  `npm ci --ignore-scripts --no-fund`: 186 packages installed, 187 audited,
  zero known vulnerabilities reported at execution time.
- From that fresh install, dependency-security, routes, auth-bearer and auth
  tests passed: 58/58 across four files, followed by a successful TypeScript build
  (08:34 UTC). Routes use real Fastify injection and a fixture session manager;
  they are not public-path acceptance.
- Independent reviewer passed all eight security tests and checked the five
  changed/repaired registry tarball URLs and SHA512 integrities against official
  metadata. No remaining actionable P1/P2 finding for this source slice.
- Added a regression checking registry tarball filenames against package
  versions. A fresh-cache install complements it because a jointly corrupted
  version and URL could otherwise agree.

## Limits, preservation and rollback

The required Playwright Chromium revision was not cached on this Mac. The
existing real-browser persistence integration was not run; no browser was
downloaded solely for this check. Container build, image publication and live
browser workflow acceptance remain unverified. The four missing-workflow tests
keep the full-suite gate red and must be resolved deliberately before publication.
Separate dashboard dependency alerts are outside this repair.

Only an isolated npm install and source-copy fixture were created; no account,
browser profile, live session, guest, infrastructure or provider resource changed.
The owned clean-install directory and cache were removed after checks, with
absence verified. Source rollback is a normal revert of this repair; no live
rollback was needed or exercised.
