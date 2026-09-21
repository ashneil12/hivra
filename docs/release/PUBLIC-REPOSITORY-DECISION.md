# Public repository history decision

**Decision date:** 2026-08-29

**Decision:** Publish a fresh repository from an exact, reviewed current-tree export. Do not publish or rewrite the existing private repository history.

## Why

The reachable `main` history through audit target `8308da55c1a2` (3,243 commits)
was independently audited and contains a private SSH key, a live-mode Stripe
secret-shaped credential, generated build output, instance-specific operational
metadata, and contributor identity data.
Those objects provide no functional open-source benefit and make preserved
history the higher-risk option. Rewriting history would still require credential
remediation, ref coordination, a complete rescan, and every consumer to re-clone.

The fresh repository is a security boundary only. It must contain the complete
self-hostable functional platform: control plane, provider and runtime adapters,
provisioning, lifecycle, access surfaces, diagnostics, recovery, upgrades,
backup/restore, tests, and operator documentation. It may omit only actual
credentials, customer data, live Hivra infrastructure details, private support or
incident records, Hivra-specific business administration, generated output, and
material Hivra cannot redistribute. It must not be used to create a hidden or
functionally superior private core.

## Release procedure

1. Keep this private Canary repository and its history unchanged as the internal
   engineering record.
2. Close the source-only credential, runtime-distribution, notice, and
   self-host acceptance gates in the private repository. Keep separately built
   images and mirrored runtime artifacts outside the first source release until
   their own byte-level notices, SBOMs, and source obligations are complete.
3. Export one exact accepted commit with `git archive`; never copy the working
   directory or a developer checkout.
4. Run the always-on current-tree hygiene, metadata, forced-text, raw, archive,
   and decoded-payload secret gates on the exported bytes.
5. Receive a fresh-context review of the exact export, including the public/private
   classification and proof that no functional operator machinery was withheld.
6. Initialize the public repository from that reviewed export as a new root commit.
   Do not attach the private Git object database, old refs, or rewritten ancestry.
7. Bind the initial public commit, source archive, source-tree notices and SBOMs,
   and acceptance receipts by exact digest before enabling public visibility.
   Bind runtime artifacts too only when Hivra actually distributes those bytes.

The private review candidate for steps 3–4 is built only from a clean committed
`HEAD`, outside the source checkout:

```sh
node scripts/release/public-source-candidate.mjs --out /absolute/new/private-review-directory
```

The generator refuses to overwrite output, reruns the public-tree and release
metadata checks, verifies that the archive exactly matches every tracked file,
generates the reproducible npm inventory, notice/source review plan and exact
source-tree asset provenance report, validates the source-only runtime boundary
and current credential reconciliation, and writes SHA-256 receipts. Its
`candidate.json` deliberately keeps `releaseApproved: false`; after those
deterministic checks pass, the remaining blockers are exact self-host acceptance
and fresh-context review. The generator conditionally restores the npm notice or
asset-review blocker if either exact evidence set regresses. It does not publish
a repository or make the candidate releasable by itself.

Those last two blockers are closed by a separate fail-closed verifier. First run
the exported-source bootstrap and recovery acceptance against the exact candidate.
Then have a reviewer who did not build the candidate inspect those same immutable
bytes and write an external `hivra-public-source-review-v1` receipt. The review
receipt must bind the candidate receipt and source archive hashes, the exact
commit and tree, the tracked-file count, secret and notice checks, the
public/private classification, and an explicit finding that no functional
operator machinery was withheld. It must contain no gaps.

The external review receipt has this exact shape; values come from the candidate
being reviewed, not from this example:

```json
{
  "format": "hivra-public-source-review-v1",
  "status": "pass",
  "releaseApproved": false,
  "decision": "approve",
  "reviewerKind": "fresh-context",
  "reviewer": "independent reviewer identity",
  "candidateReceiptSha256": "64 lowercase hex characters",
  "sourceArchiveSha256": "64 lowercase hex characters",
  "source": {
    "commit": "40 lowercase hex characters",
    "tree": "40 lowercase hex characters"
  },
  "checks": {
    "publicPrivateClassification": "pass",
    "functionalCoreComplete": "pass",
    "secretScan": "pass",
    "noticeAndLicense": "pass",
    "archiveContents": "pass",
    "noFunctionalOperatorMachineryWithheld": true,
    "reviewedTrackedFiles": 1
  },
  "gaps": []
}
```

The review receipt itself does not approve publication; it records one required
independent judgment. Only the verifier may combine it with exact deterministic
candidate and self-host evidence into a release approval.

Only then create an approval receipt outside both the repository and candidate:

```sh
node scripts/release/public-source-approval.mjs \
  --candidate /absolute/private-review-directory \
  --self-host /absolute/public-source-bootstrap-e2e.json \
  --review /absolute/fresh-context-review.json \
  --out /absolute/new/approval-directory
```

The verifier rehashes every candidate file, requires exact SHA-256 coverage,
rejects links and extra candidate blockers, and binds both external receipts to
the candidate before emitting `releaseApproved: true`. That approval applies only
to the exact source archive and a fresh repository. The command does not create,
push, or make a repository public; it cannot approve private history or any
separately distributed runtime or image bytes.

No public repository is created by this decision. Publication remains blocked
until every remaining Phase 0 gate passes.

## Credential-remediation checkpoint

The exact historical Stripe credential identified by the redacted audit was
matched by its recorded SHA-256 prefix and used only for a read-only account
authentication check on 2026-08-29. Stripe returned HTTP 401, confirming that the
historical value is invalid or revoked.

The exact historical SSH private-key bytes were compared without printing key
material against the current deployment identities; none matched. Its derived
public-key identity was then checked against every active target in the
authoritative Canary host registry. All four active targets authenticated with
their current credentials and none authorized the historical identity. The
eighteen remaining registry targets are maintenance or retired targets without
launch authority. Strict host-key checking remained enabled throughout, and the
temporary historical key material was removed after the comparison. The current
Hetzner project had no servers and its one current SSH key was not the historical
identity. This reconciles the current authorization boundary without claiming
continued access to decommissioned hardware. See the
[redacted reconciliation](VERIFICATION-STATUS.md).

## Source-only runtime boundary

The public source archive embeds no third-party operating-system image, runtime
package, container image, or installer artifact. Every external input used by the
portable installer is classified as an upstream download and bound to an exact
version, checksum, commit, or OCI digest. All three browser-sidecar build stages
also use digest-pinned base images. An installed computer generates its own exact
private runtime receipt, CycloneDX SBOM, and notice-review manifest from the bytes
it actually received. Those receipts do not turn the third-party bytes into part
of the source archive.

This closes the runtime-distribution question for the source-only repository. A
future Hivra-built VM or container image, runtime mirror, desktop bundle, or other
binary distribution is a separate artifact class and remains blocked until its
exact bytes have complete notices, SBOMs, source offers, and terms review.

## Evidence

- [Redacted full-history audit](VERIFICATION-STATUS.md)
- [Open-source and hosted boundary](../OPEN-SOURCE-BOUNDARY.md)
- [Runtime-distribution decisions](RUNTIME-DISTRIBUTION.md)
- [Dependency and current-tree evidence](DEPENDENCIES.md)
