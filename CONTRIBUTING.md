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
