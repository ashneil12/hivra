# Dependency and runtime-distribution evidence

**Status:** Complete source-only inventory and evidence boundary. This is not
approval to redistribute separately built images or third-party runtime bytes.

## Reproduce the npm inventory

From the repository root, with Git, Node.js 22.22 or newer and npm 10.9.3:

```sh
node --test scripts/release/dependency-inventory.test.mjs
node scripts/release/dependency-inventory.mjs --out /absolute/path/to/new-private-evidence-directory
```

The output directory must not exist; its parent must exist. The command never
overwrites an earlier receipt. Keep evidence private until the release review.
It generates `inventory.json` and one `sbom.cdx.json` per tracked npm package
with a supported tracked lockfile. Exit zero means generation succeeded, not
that publication is allowed; `releaseApproved` is always `false`.

The generator uses npm's [lockfile-only SBOM mode](https://docs.npmjs.com/cli/v11/commands/npm-sbom/)
with offline operation, ignored lifecycle scripts and explicit inclusion of dev,
optional and peer dependencies. Each package is copied into an isolated private
temporary directory with empty npm configuration and a separate cache. Installed
`node_modules`, untracked manifests/locks and user npm credentials are not inputs.
The exact temporary directory is removed at exit. Workspace/link dependencies
and non-public-registry download locations currently fail with redacted errors;
they need an explicit inventory adapter rather than silent omission.

The receipt records Git HEAD as an anchor, exact **working-tree input hashes**,
generator hash, Node/npm versions, artifact hashes, declared licenses and coverage
gaps. It does not assert that uncommitted inputs equal HEAD. npm's optional random
serial and timestamp are removed; the dependency graph, hashes, declared licenses
and tool metadata are retained. Equivalent inputs and tool versions should produce
identical bytes. A changed generator, npm version, lockfile or manifest requires
regeneration. The JSON receipt is written last, after every component succeeds.

### Release toolchain compatibility

Use an isolated npm 10.9.3 installation for release evidence; do not replace a
contributor's global npm. In a fresh temporary directory:

```sh
npm install --prefix /absolute/new/toolchain --ignore-scripts --no-audit --no-fund npm@10.9.3
PATH="/absolute/new/toolchain/node_modules/.bin:$PATH" node scripts/release/public-source-candidate.mjs --out /absolute/new/candidate
```

The September 2026 rehearsal found that npm 11.19.1 omits package-path properties
needed to bind bundled components to their containing artifact. The notice
verifier correctly rejects that output. npm 10.9.3 passes that stage on the
reviewed lockfiles. This is a verified release-toolchain choice, not a claim that
every other npm version is incompatible or that the full release has passed.
Keep the path check intact and regenerate all receipts when changing toolchains.

## Generate the npm notice/source-offer review evidence

The source-candidate builder now follows the lockfile SBOM inventory with a
second deterministic, owner-only evidence pass:

```sh
node --test scripts/release/notice-source-offer-evidence.test.mjs
node scripts/release/notice-source-offer-evidence.mjs \
  --inventory /absolute/path/to/dependency-inventory \
  --out /absolute/path/to/new-notice-evidence-directory
```

The generator checksum-validates every referenced SBOM, deduplicates exact npm
package URLs, SHA-512 identities and purls, classifies notice, attribution,
reciprocal source-correspondence and manual license-choice review, and records
every remaining gap. The seven lock entries whose npm SBOM metadata omits a
license are covered by the committed exact-artifact review policy in
`npm-license-overrides.json`. An override is accepted only when its package,
version, registry URL and SHA-512 all still match; a newly declared license,
changed artifact, stale override, conflicting duplicate or unchecked SBOM is a
hard failure.

Outputs are `notice-source-offer.json` and `NOTICE-INDEX.review.tsv`, both mode
`0600` inside a mode `0700` directory. They remain `releaseApproved: false`.
They are a reproducible review plan, not collected license text, legal advice,
a complete notice bundle or a source offer. Nested packages bundled inside
another npm tarball are path-bound to the nearest exact containing artifact
rather than misreported as independently downloadable packages. The
`format@0.2.2` review is bound to its packaged `Readme.md`, which declares the
MIT license and copyright holder even though the tarball has no standalone
license file. Runtime, OS and image boundaries remain outside this npm-only
scope.

## Generate exact source-tree asset provenance evidence

The separate asset pass inventories every tracked image, vector, PDF, font,
archive and media file in the exact committed tree:

```sh
node --test scripts/release/asset-provenance-evidence.test.mjs
node scripts/release/asset-provenance-evidence.mjs \
  --out /absolute/path/to/new-asset-evidence-directory
```

The policy in `asset-provenance.json` is exhaustive and byte-bound. Adding,
removing or changing an asset without reviewing that policy fails generation.
Symlinks, unsafe paths, dirty source trees, stale provenance commits, mismatched
hashes and output overwrites also fail closed. The owner-only output is
`asset-provenance.json`, mode `0600` inside a mode `0700` directory, and remains
`releaseApproved: false`.

Licensed third-party fonts use a separate fail-closed evidence class. Every font
record must match an official upstream artifact byte-for-byte, retain an adjacent
OFL-1.1 file, and bind both local files plus the official source URLs in
`font-license-evidence.json`. The generator rejects missing records, changed font
or license bytes, non-adjacent license files, non-HTTPS source URLs and evidence
that is not committed at the exact candidate revision.

Owner assertions for artwork are stored separately in
`asset-owner-assertions.json`. Those records identify the exact asserted files and
the limited independent evidence for each; they are not generation receipts. Four
artworks have repository-history evidence only. The owner-selected Hivra logo also
has a byte-identical match to the supplied original file. No prompt, generation
tool, upstream source or terms receipt is inferred where none was supplied.

The 2026-08-29 cleanup removed 18 unreferenced starter, duplicate root, legacy
HermesOS brand/marketing and stale downloadable roadmap assets. A second pass
then removed the five remaining QuiverAI-derived or unrecorded generated blobs.
The Hivra mark is now simple project-authored SVG geometry. Three replacement
litepaper illustrations retain exact prompts, built-in-tool output receipts,
hashes, current OpenAI terms review and recorded visual acceptance in
`asset-generation-records.json`. The generator checksum-binds that record to
the committed tree and validates an exact record for every project-generated
asset.

The 21 September review covers 24 tracked assets: three first-party Playwright
baselines, the project-authored Hivra SVG, three generated litepaper illustrations
with creation receipts, twelve OFL-1.1 font paths representing six exact upstream
font blobs, and five owner-asserted original artworks. The policy classifies all
24 for inclusion while keeping the evidence boundary visible. Overall release
approval remains false because candidate generation, exact-source secret review,
exported-source self-host acceptance, runtime/image work and fresh independent
review are separate gates.

## Apache-2.0 metadata checkpoint — 2026-08-29

Exact source revision `e3ad690487828d0543a4291d289264709ec0c8ba` was
inventoried from a clean working tree with Node `22.23.1` and npm `10.9.8`.
All four tracked npm application roots declare Apache-2.0 consistently in their
manifests and lockfile roots. The inventory contains 1,477 dependency component
occurrences. The later current-tree inventory has seven dashboard dependencies
whose normalized license metadata is omitted; their exact package artifacts and
terms are covered by the fail-closed review policy above and classified in
[the runtime-distribution record](RUNTIME-DISTRIBUTION.md). Registry metadata
remains unchanged.

Artifact SHA-256 values:

- Inventory receipt: `2eff14ff2e74b014a0fcb8f3ac3e0301cdb3ad94f1fe730390a57ffe1bb87f67`
- Dashboard CycloneDX: `eff2a78a11763efb80bf72c2370c75fd41001bfb3cc1836345d5ade96eac8919`
- Browser sidecar CycloneDX: `7830a616103d4517d24979fa31f35450884f34d50b884352cee2a01f2089aca0`
- PostHog Worker CycloneDX: `0a1b1bee3813499832e245b140c1e5eff60ef1011164e86c1683116703a57b61`
- Venice Worker CycloneDX: `1d8bf62b742ab31b3682fc6b95c0d4f18065ad9f177ff61811280fddf4e52a62`

The release metadata, attribution, separate Solidity MIT boundary, trademark
competition rights, DCO contribution terms, security/incomplete-release
language, and CI path coverage passed 23 regression checks plus YAML and diff
validation. Fresh-context review found and then verified corrections for three
documentation/CI inconsistencies before the milestone commit. The exact-revision
[Worker CI run](https://github.com/ashneil12/hermesdeploy-canary/actions/runs/33224830472)
passed both Worker builds/runtime tests and the combined release evidence gate.
This closes the root-license metadata milestone, not the exact runtime/image
notice, credential-rotation, cleaned-history, or first public-release gates.

The exact private evidence directory was intentionally excluded from the public
source tree. Regenerate it from the proposed release rather than treating a
developer-local temporary directory as a durable publication artifact.

## Verified 2026-08-28 snapshot

Source anchor: `8fcac5630dffd7b26d98cb4f99bc518759347ea8`, with the exact
working-tree dashboard/browser-sidecar manifest and lock hashes recorded in the receipt.
Node `22.23.1`, npm `10.9.8`. Two independent runs produced byte-identical output.
All four tracked manifests have lockfile coverage. This snapshot includes the
dashboard/browser-sidecar security updates described below. The previously
verified Worker inputs are unchanged. Application source, routes, infrastructure
settings and Worker compatibility dates were not changed in this pass.
The generator's 14 regression checks passed, including real offline npm execution,
determinism, script/config isolation, missing locks/licenses, failed-graph handling,
refusal to overwrite receipts and symlink/source-location rejection. Syntax and
whitespace checks passed. Inventory generation alone is not runtime acceptance.

| Component | Locked dependency components | Lockfile coverage | Missing dependency license metadata |
| --- | ---: | --- | ---: |
| `dashboard` | 1,050 | npm v3 | 8 |
| `services/browser-sidecar` | 241 | npm v3 | 0 |
| `services/posthog-proxy-worker` | 93 | npm v3 | 0 |
| `services/venice-proxy-worker` | 93 | npm v3 | 0 |

Counts include development and optional dependencies, not just deployed runtime
packages. At that historical snapshot, all four application manifests lacked a
declared license and no root license was committed. Those gaps are resolved by
the current Apache-2.0 package metadata and root license; the old receipt remains
unchanged evidence of its exact input tree.

The eight dashboard entries without license metadata are:

- `@fingerprintjs/fingerprintjs-pro@3.12.9`
- `buildcheck@0.0.7`
- `cpu-features@0.0.10`
- `duck@0.1.12`
- `exit@0.1.2`
- `format@0.2.2`
- `posthog-js@1.318.2`
- `ssh2@1.17.0`

This list belongs to the immutable historical inventory above. The current
dashboard no longer includes `@fingerprintjs/fingerprintjs-pro` in either its
manifest or lockfile. Hosted deployments that explicitly configure a public
Fingerprint token load the proprietary browser agent from Fingerprint's
official CDN at runtime; a default self-hosted build downloads no Fingerprint
code.

Review the exact package artifacts and their notices. Missing metadata does not
mean no license exists; declared lockfile metadata does not establish distribution
rights, source-offer compliance or compatibility with the eventual Hivra license.

Artifact SHA-256 values for this snapshot:

- Dashboard CycloneDX: `e5f52140d2502d20f5d15096979bbe298cc8d57daf48ea5f2a874553a4f6485e`
- Browser sidecar CycloneDX: `2659b7e5d7a6297395b83288aeb703c79429b30d0490c232cff4a3a031a083ed`
- PostHog Worker CycloneDX: `b3ce0d060b448989bdf987912a028965659b36c429b2e127cd106f0f059a9878`
- Venice Worker CycloneDX: `4a34d3fcfbe06f891a1be75455132482cc97b0514ce4b1904076d16c09c50e86`

The exact local evidence directories were intentionally excluded from the public
source tree. Temporary evidence is not a durable public artifact; regenerate it
for a proposed release revision and attach it to that revision's private review.

## Worker build coverage

Both Workers now pin Wrangler `4.127.0`, TypeScript `5.9.3` and compatible
Workers types `5.20260828.1`, with Node 22 as the minimum. Miniflare
`5.20260826.0-alpha` is also a direct test dependency, matching the exact version
required by the pinned Wrangler rather than depending on an undeclared transitive
import. No runtime compatibility date was advanced during this toolchain update.

Each Worker passed an isolated `npm ci --ignore-scripts`, typecheck, dry-run
bundle build and actual workerd smoke tests (PostHog: 4; Venice: 10). Outbound
HTTP is intercepted with fake hosts/keys; telemetry and automatic Cloudflare
variable-file loading are disabled. The tests dispose their local runtimes.
Four harness regressions separately verify delayed assertion propagation,
completed-call notification, pending-handler drainage and bounded-time cleanup.
These fail against the original harness, which could miss an assertion made
after workerd disposal, and pass after its pending-handler fix.
The clean-copy runner and raw results remain in the private release record; their
developer-local temporary path is intentionally excluded from public source.

The [Worker CI workflow](../../.github/workflows/worker-builds.yml) repeats these
checks without deployment credentials, with read-only repository permissions and
commit-pinned actions. This is a local build/runtime regression boundary, not
evidence of a Cloudflare rollout, live billing settlement, complete security audit
or public-release readiness. The unchanged proxy implementations still require
their own live acceptance and resource-limit/reconciliation review before a new
production rollout.

Delivery checkpoint: commit `eb9f1ac2364975d6ed0fdc7020a34b43fb1dc54c`
was pushed to Canary `main`. The [Linux CI run](https://github.com/ashneil12/hermesdeploy-canary/actions/runs/33144336007)
completed successfully on 2026-08-28: both Worker clean installs, typechecks,
dry-run builds and runtime tests, plus all 18 inventory/harness regression tests.
Fresh-context review independently repeated the local runtime and delayed-failure
checks and passed the corrected snapshot. No Cloudflare Worker deployment was
performed. Application source and deployment bindings remain unchanged.

## Dependency security checkpoint

On 2026-08-28, GitHub's authenticated repository alert API reported **37 open
Dependabot alerts** against dashboard/browser-sidecar lockfiles: 24 high, 12
medium and 1 low. This is the observed repository-alert count, not a claim that
37 deployed exploit paths were demonstrated. The checked source anchor was
`eb9f1ac2364975d6ed0fdc7020a34b43fb1dc54c`.

That alert count describes the pre-update tree, not the current lockfiles.
The updated dashboard and browser-sidecar each returned **zero findings** from
`npm audit --json --ignore-scripts` on 2026-08-28. This is the registry's dated
advisory result for those npm trees, not a complete security audit or proof of
zero vulnerabilities. The new Next.js critical advisories were checked directly
against the upstream release, not inferred from a lagging repository alert list.

The dashboard now pins Next.js, its environment package, third-party helpers and
ESLint configuration to `16.3.3`; PDF.js to `6.2.108`; and Undici to `7.29.0`.
Patched transitive versions include sharp `0.35.4` (supported natively by this
Next.js release), DOMPurify `3.4.14`, PostCSS `8.5.26`, nanoid `3.3.18`, js-yaml
`3.15.1`/`4.3.1`, and brace-expansion `1.1.18`/`5.0.9`. The sidecar uses fast-uri
`3.1.5`/`4.1.3` and html-to-text `10.0.1`, whose supported dependency range
resolves deepmerge-ts `8.0.2`; no incompatible deepmerge major is forced underneath
an older parent. Its Playwright lock and runtime image remain aligned at `1.59.1`.

Sources and exposure boundaries:

- [Next.js 16.3.3](https://github.com/vercel/next.js/releases/tag/v16.3.3)
  includes critical Windows-hosted HTTP and AVIF/libheif fixes. Windows hosting
  was not tested here. Next.js disables AVIF optimization as part of that release;
  do not re-enable it to work around the change.
- [PDF.js advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)
  concerns viewer scripting. The checked Hivra utility uses text extraction,
  not PDFViewer, and currently has no non-test callers. Its native parser test
  does not establish a live browser attachment workflow.
- Behavioral regressions exercise DOMPurify's detached-subtree hooks, real PDF
  text extraction, native sharp decode/resize/encode, and mailparser HTML-to-text
  extraction. Lock guards cover nested copies and preserve reviewed major-specific
  floors for fast-uri, js-yaml and brace-expansion.
- Browser image publishing now fails if Chromium installation or the real
  persistence test fails. That test uses an owned loopback server and cleans up
  both contexts even on assertion failure, rather than depending on example.com.

Every third-party GitHub Action used by the current workflows is pinned to an
immutable, explicitly approved 40-character commit rather than a mutable major
tag. The current action set uses Node 24 action runtimes. The public-release
metadata test inventories the exact 34 references across every workflow and
fails on a floating, unreviewed, or omitted action identity. This closes the
workflow-reference mutability finding; it does not replace the remaining exact
image, runtime, notice, and source-offer review.

Re-query the [repository alerts](https://github.com/ashneil12/hermesdeploy-canary/security/dependabot)
for current state. Release/runtime acceptance remains separate from the SBOM and
from vulnerability counts; see the scoped [security-update receipt](VERIFICATION-STATUS.md).

Delivery checkpoint: commit `caaa752e05dc20540e68906ea30eb5d97dd1add3` reached
the Canary alias and passed signed-in infrastructure/catalog/resource-preview
checks on 2026-08-28. The exact-revision [Linux sidecar CI run](https://github.com/ashneil12/hermesdeploy-canary/actions/runs/33146080805)
passed all gates and published its immutable Canary image tag; the receipt records
the manifest digest and verification limits. GitHub subsequently reported zero
open repository dependency alerts. Production, existing agents and provider
resources were not changed. This closes this dependency-update milestone, not the
complete security, self-hosting or public-release gates.

## Runtime inputs are a separate inventory

The npm SBOMs above do **not** describe installed agent computers. The observed
default direct inputs of bundle `2026.08.28.1` are below. These are implementation
facts, not final legal bundle/download/connect approvals. Full upstream URLs and
checksums live in [provisioner provenance](../../dashboard/provisioner/PROVENANCE.md);
the [guest installer](../../dashboard/provisioner/provision-claude-code-box.sh)
is the executable authority.

Bundle `2026.08.29.2` adds a deterministic private receipt at
`/var/lib/hivra/runtime-receipt.json`, with a byte-binding SHA-256 companion. It
is written only after runtime-specific readiness succeeds and inventories exact
Debian package/source versions, copyright-file hashes, global npm packages,
selected Git checkout state, pinned container identity, Hivra artifacts,
services and binary version outputs. The receipt excludes credentials and user
state and keeps `releaseApproved: false`; its explicit gaps still require notice,
source-obligation and image-layer review before publication.

Bundle `2026.08.29.3` corrects that receipt's Ubuntu OS identity by reading the
canonical regular `/usr/lib/os-release` file rather than following the normal
`/etc/os-release` symlink. Operator verification now requires both the OS ID
and version ID; it still returns only fixed identity and inventory counts.

Bundle `2026.08.29.4` deterministically derives a private CycloneDX 1.6 SBOM and
notice/source-review manifest from the exact installed-state receipt. Both have
independent SHA-256 companions and are bound back to the receipt checksum. The
notice manifest records Debian copyright-file hashes, npm declared licenses and
root license/notice-file hashes plus exact missing counts. The fixed operator
verifier returns only checksums and counts after cross-document validation. These
artifacts close silent installed-SBOM omission for a freshly provisioned guest;
they remain `releaseApproved: false` and do not themselves supply complete
license texts, source offers, image-layer review or vulnerability approval.

Bundle `2026.08.30.1` upgrades the installed receipt to schema 2 and recursively
walks the selected system and agent-user global `node_modules` roots. Each
regular nested npm package is bound by manifest hash and install path, and the
SBOM uses that path to distinguish duplicate package versions installed in
different runtime subtrees. Symlinked packages, malformed or missing manifests,
and over-limit inventories fail closed. The receipt explicitly records the
`recursive-node-modules-v1` and `dpkg-installed-v1` completeness classes. This
closes the earlier shallow top-level npm inventory defect; license-text,
copyright, source-offer and exact image-layer review remain open.

| Input | Observed installation behavior | Default identity |
| --- | --- | --- |
| Browser Use bux | Fetch a Git checkout; run its installer after pinning two CLI downloads | `f17c1b31d6688dd92e745ade650e00d46b4dc4da` |
| Claude Code | Download npm package into the guest | `@anthropic-ai/claude-code@2.1.246` |
| Codex | Download npm package into the guest | `@openai/codex@0.149.1` |
| Aeon | Fetch Git checkout, modify dashboard configuration, install dependencies and build | `8b8d719715ec9bb68fb858a1e334d23209047d82` |
| OpenClaw | Download npm package into the guest | `openclaw@2026.6.10` |
| Agent Zero | Pull an OCI image by digest | `sha256:d8fd86114b02e9b4b6f14ef6f696b1ba7af46e52327734bb8a77f7aaf8556cf0` |
| cloudflared | Download and SHA-256 verify Linux executable | `2026.8.2` |
| Google Chrome | Download and SHA-256 verify Debian package | `152.0.7977.64-1` |
| GitHub CLI | Download and SHA-256 verify Debian package | `2.98.0` |
| Proxmox guest base | Download and SHA-256 verify dated Ubuntu image | Jammy `release-20260807` |
| Guest system packages | Install from Ubuntu package repositories | Installed package/version receipt still required |

Important coverage limits:

- The pinned bux installer has its own downloads/builds, including Node, ttyd and
  skills. Its Git pin alone is not a complete transitive artifact inventory.
- The selected global npm runtime trees now have recursive installed identities,
  but their exact license texts, copyright statements and source obligations
  still need release review. Aeon's separate application build and the pinned
  bux installer downloads remain outside that global-tree scope. Agent Zero's
  digest likewise needs an image-layer and OS-package inventory.
- The browser-sidecar Dockerfile uses digest-pinned `node:22-bookworm-slim` build
  images and a digest-pinned `mcr.microsoft.com/playwright:v1.59.1-noble` runtime,
  plus apt packages. Its npm SBOM is not a container-image SBOM; publishing a
  built sidecar image still requires image-layer evidence.
- Hermes and Operator OS use the separate instance/image lane; their image build,
  upstream fork and asset distribution audit is still outstanding. They are not
  covered by the portable five-runtime installer inventory.
- Planned Buzz and DeepSeek Harness adapters are not artifacts covered by this
  inventory. Adding them requires exact upstream identity and distribution review.
- Brand assets, fonts, videos, documentation-derived material, model terms,
  browser distribution terms and generated images are outside npm lockfile coverage.

## Separate artifact-distribution work

1. Generate required notices from the exact dependency and runtime artifacts;
   complete the recorded bundle/download/connect decisions for transitive downloads.
2. Inventory built container images and installed OS/runtime packages, not only
   source lockfiles. Preserve image digests and original artifact integrity evidence.
3. Complete exact release-image notices, source-offer obligations and asset rights.
4. Preserve the completed current credential reconciliation and cleaned-tree
   secret/operational-data scans. This inventory does not replace the remaining
   exact self-host acceptance or independent export review.
5. Recheck dependency alerts against the exact proposed release, retain scoped
   regression evidence, and audit the installed runtime/image dependencies that
   are outside these npm lockfiles.

No history rewriting, repository publication, credential mutation, package
installation or live deployment is performed by this inventory.

For an exact clean-HEAD private source candidate, use
`scripts/release/public-source-candidate.mjs`. It includes this inventory and its
SBOM artifacts, the generated npm notice/source-offer review evidence, a
byte-bound source archive and checksum file. It retains `releaseApproved: false`
until the npm review evidence is completed and every non-npm release gate is
closed.
