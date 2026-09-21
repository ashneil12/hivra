# Contributing to Hivra

Hivra welcomes fixes, runtime and provider adapters, security improvements,
documentation, design work, and operational tooling in the functional core.
Managed-service convenience is not a reason to withhold generally useful code.

## Before opening a pull request

1. Read [VISION.md](VISION.md), [the product architecture](docs/PRODUCT-ARCHITECTURE.md),
   and the canonical design linked from [AGENTS.md](AGENTS.md).
2. Keep current behavior distinct from target behavior. Do not present a route,
   runtime, security control, or release as working without acceptance evidence.
3. Never commit secrets, customer data, live host inventory, private support
   material, or generated environment files.
4. Add a regression test for each real bug fix unless the pull request explains
   why a deterministic test is impossible.
5. Run the verification level required by the affected risk surface. Dashboard
   contributors can start with `cd dashboard && npm run verify:plan -- --risk normal`.

Security vulnerabilities follow [SECURITY.md](SECURITY.md), not public issues.

## Contribution terms

Unless a file says otherwise, contributions are submitted under Apache-2.0.
Use a Signed-off-by trailer to certify the Developer Certificate of Origin 1.1:

```text
Signed-off-by: Your Name <you@example.com>
```

Add it with `git commit -s`. By signing off, you certify that you created the
contribution, are permitted to submit it under the indicated open-source
license, or received it under a compatible license that permits submission;
and that the contribution and sign-off may be publicly retained.

Do not contribute third-party code, generated assets, model output, brand
material, or runtime binaries without recording provenance and redistribution
terms. Hivra does not require assignment of copyright in ordinary contributions.

## Pull-request evidence

Describe what changed, what you tested, what you intentionally left untouched,
and anything that remains uncertain. User-facing and high-risk changes should
include revision-bound live evidence appropriate to their blast radius.

## Acceptance and managed hosting

Open pull requests against `main`. A contribution is a proposal, not a promise
of acceptance or a production release. Maintainers may request changes or decline
work based on security, product fit, maintenance cost, or operational risk.

Generally useful capabilities belong in the public project. A self-hosting feature
that is unsuitable for the managed service should use an explicit optional setting
or adapter and remain disabled in managed hosting until separately accepted.
New providers, integrations, background jobs, privileged operations, and billable
paths must not become enabled merely because their implementation was merged.
Include tests for the disabled path and authorization boundary where applicable.
Do not weaken tenant isolation, billing checks, or authentication to support an
optional configuration.

`main` contains accepted code. `canary` selects the revision being tested on the
managed Canary service. Production deployment requires a separate, explicit
promotion by an authorized operator. See the
[managed release process](docs/release/MANAGED-HOSTING-RELEASES.md).
