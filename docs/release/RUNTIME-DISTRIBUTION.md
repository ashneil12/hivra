# Runtime and infrastructure distribution decisions

**Status:** Source-only publication boundary complete for the current portable
installer. New installs generate an exact private installed-state receipt.
Separately distributed Hivra-built images or mirrored runtime artifacts remain a
different artifact class with their own notice, SBOM, source-offer, and terms gates.

Hivra's Apache-2.0 license covers Hivra-owned adapters, provisioners, brokers,
guest services, and control-plane code. It does not relicense software fetched
from another project or service.

The current default is **download**, not bundle: an installer retrieves a pinned
artifact from its official source directly onto the operator's computer. A
future release that embeds any of these bytes in a Hivra image changes the
decision to **bundle** and must repeat the license and notice review.

| Input | Pinned identity | Decision | Upstream terms observed | Release boundary |
| --- | --- | --- | --- | --- |
| Hivra provider/guest bundle | `dashboard/provisioner/VERSION` and committed asset hashes | Bundle | Apache-2.0 | Hivra-owned source and generated guest files may ship with the root license and notices. |
| Ubuntu Jammy cloud image | `release-20260807`, SHA-256 in `PROVENANCE.md` | Download | Ubuntu packages retain their individual free-software licenses | Download from Ubuntu; do not mirror until image/package notices and source obligations are captured. |
| Browser Use `bux` | `f17c1b31d6688dd92e745ade650e00d46b4dc4da` | Download | MIT | Clone the pinned upstream commit. The nested Node, ttyd, skill, and package downloads performed by its installer still need an exact transitive receipt. |
| Claude Code | `@anthropic-ai/claude-code@2.1.246` | Download | Proprietary; package license points to Anthropic legal terms | Download from npm only for an operator who chooses that runtime. Never describe or redistribute it as Apache-2.0. |
| OpenAI Codex CLI | `@openai/codex@0.149.1` / upstream tag `rust-v0.149.1` | Download | Apache-2.0 | Download from npm; preserve the upstream project/license link. The npm tarball declares Apache-2.0 but currently omits the full license file, so release documentation must retain the upstream license reference. |
| Aeon | `8b8d719715ec9bb68fb858a1e334d23209047d82` | Download and modify in guest | MIT | Clone the exact commit, retain its MIT notice, and identify Hivra's generated `next.config.ts` as a local integration change. |
| OpenClaw | `openclaw@2026.6.10` | Download | MIT | Download from npm and retain its root license plus packaged third-party notices. |
| Agent Zero | OCI index `sha256:d8fd86114b02e9b4b6f14ef6f696b1ba7af46e52327734bb8a77f7aaf8556cf0` | Download | Upstream source is MIT; the image also contains Kali/OS packages under their own terms | Pull the immutable index directly. Image-layer SBOM, license, and source-offer evidence is still required before Hivra mirrors or bundles it. |
| `cloudflared` | `2026.8.2`, verified SHA-256 | Download | Apache-2.0 | Download the verified official binary. |
| Google Chrome | `152.0.7977.64-1`, verified SHA-256 | Download when browser support is selected | Proprietary Google terms | Never bundle or imply an open-source license. First-release browser acceptance still needs a documented open Chromium-compatible option or an explicit operator opt-in to Chrome's terms. |
| GitHub CLI | `2.98.0`, verified SHA-256 | Download | MIT | Download the verified official Debian package and retain its notice when redistributed. |
| Ubuntu guest packages, including Docker | Dated repository resolution at preparation time | Download | Package-specific | Capture exact installed package versions and license/source metadata in the release receipt. |
| FingerprintJS Pro browser agent | Fingerprint-hosted v3 CDN loader | Hosted opt-in runtime download | Proprietary service terms | Not present in the dashboard manifest, lockfile, or public build artifact. Only a deployment with `NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY` loads it from Fingerprint's official CDN; an unconfigured self-host degrades to the remaining abuse signals without downloading Fingerprint code. |
| PostHog SDK | `posthog-js@1.318.2` | Application dependency | Apache-2.0 | The package includes its license. Telemetry remains optional and must be configurable for self-hosting. |
| Existing managed Hermes lane | Public MIT source `ashneil12/vanilla-hermes-agent@5f1cb3ac9be694a58e911bf87c3f16f62ab9f18a`; reviewed OCI index `sha256:a2a24bda08a9f5a962dae8293077526e361975c18b5c797994efa7d220934b4b` | Not approved for public distribution; connect/download evidence only | MIT source plus package-specific image contents | The build label and successful source-repository workflow bind the reviewed image to the exact source commit. Current managed defaults still use mutable `latest`/`stable` aliases. Do not include that mutable lane in a public release artifact until the portable configuration uses an immutable reviewed identity and the image-layer SBOM, notices, source obligations, and assets are complete. See the [source/image checkpoint](VERIFICATION-STATUS.md). |
| Buzz | [`block/buzz`](https://github.com/block/buzz); reviewed `8dbc65d9e2c80d9d8516e17b751c46e0568100e6` | Connect; later upstream download after image audit | Apache-2.0 | Use one workspace relay as an optional mediated communication service. Preserve a separate signing key per agent and Buzz's native UI. Do not give the relay Hivra infrastructure authority or mirror its stateful image stack before exact notice and image-closure review. |
| DeepSeek Harness | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness); reviewed adapter baseline `cd5ef8148158c3a752a658978873241fdf8e2bbc`; staged package source `0a53fb55bea101816fa226bb964ae2bed71c343b` | Experimental operator-selected download | MIT plus separately disclosed third-party terms | Run only inside an isolated agent computer; use ACP for orchestration and the loopback Web UI through Hivra's authenticated native-view path. Its same-world sandbox is not the Hivra containment boundary. |
| Legacy Operator OS instances | Existing rows may retain an explicitly stored external image identity | Compatibility only; no new launch or default image | Unresolved external runtime | Hivra does not advertise, build, or launch Operator OS in this release. Lifecycle compatibility only honors a row's already-pinned image and fails closed when it is absent. Reintroducing the runtime requires its complete source, license, portable build, and artifact evidence inside the public boundary. |

## Buzz and DeepSeek provenance checkpoint

These are dated review identities, not floating installer inputs and not an
assertion that Hivra owns either upstream project.

| Runtime | Canonical upstream | Reviewed source | License | Release observation |
| --- | --- | --- | --- | --- |
| Buzz | [`block/buzz`](https://github.com/block/buzz) | `8dbc65d9e2c80d9d8516e17b751c46e0568100e6` | Apache-2.0 | Desktop `v0.5.20` is tag `desktop-v0.5.20` at `95154bee4034ca7a40b33095c2ddbde8c9aa1614`; the Apple Silicon DMG reports SHA-256 `0471456eaa7c3a4ab83ed93cc75d14b21eb57032f96bf2cfa49c0f9fa847bde6`, and official updater assets include detached Tauri signatures. |
| DeepSeek Harness | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) | `cd5ef8148158c3a752a658978873241fdf8e2bbc` | MIT | The reviewed baseline is tag `dsh-v0.1.2-alpha.1`. The earlier npm review observed `@deepseek-ai/dsh@0.1.1-rc.2` at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` with integrity `sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==`. The current staged recipe pins `@deepseek-ai/dsh@0.1.2-alpha.2` from source `0a53fb55bea101816fa226bb964ae2bed71c343b` and its complete registry/integrity-locked npm closure. |

Buzz is a collaboration substrate, not a replacement for Hivra's computer
boundary or infrastructure authority. DeepSeek Harness is an experimental
runtime whose same-world sandbox is not Hivra's isolation boundary. Hivra's
source adapters are part of the source-only candidate, but no Buzz image,
desktop artifact, DeepSeek package, proprietary Anthropic/Claude payloads, or
other third-party runtime bytes are bundled in that source archive. Buzz relay
distribution closure, DeepSeek ACP acceptance, and any mirrored runtime/image
notice bundle remain separate gates.

## Npm application findings

The reproducible npm inventory at [DEPENDENCIES.md](DEPENDENCIES.md) covers four
locked components. The current exact-artifact review pass deduplicates the npm
graph into 1,259 unique components from 1,476 occurrences. License metadata
inspection found no unresolved license after exact review and no AGPL-only
dependency. It classified 53 reciprocal source-correspondence reviews, three
manual license-choice reviews and one CC-BY attribution review. These are review
obligations, not findings that Hivra-owned Apache-2.0 source changes license.

Seven current dashboard lock entries lack normalized SPDX metadata. Exact npm
tarball identities resolve them as follows: `buildcheck`, `cpu-features`, `exit`,
`format`, and `ssh2` are MIT; `duck` is BSD-3-Clause; and `posthog-js` carries
Apache-2.0. The committed review policy binds each classification to the exact
registry URL and SHA-512. FingerprintJS Pro is no longer in the manifest or
lockfile; its optional hosted-CDN boundary is recorded separately above. This
classification supplements the generated SBOM; it does not mutate registry
metadata or claim that artifact notice collection is complete.

The candidate's generated npm review evidence still reports four nested optional
packages without an independent distribution URL/integrity in the lock graph,
one reviewed package without a root license file, and pending license-text and
copyright collection for the exact built subset. Those are explicit fail-closed
gaps, not silently inferred approvals.

## Source-tree asset findings

The exact-tree asset policy and generator now cover all seven remaining tracked
visual assets. Eighteen unreferenced starter files, duplicate root favicons,
legacy HermesOS logos/social cards and two stale roadmap PDFs were removed. A
second replacement pass removed the five remaining QuiverAI-derived or
unrecorded generated blobs. The roadmap remains available as the canonical live
page, social previews use the current generated Hivra card, and product headers
use a project-authored inline SVG mark.

Three project-created Playwright UI baselines, the Hivra SVG and three new
litepaper illustrations are classified for inclusion. The illustration record
retains exact prompts, built-in-tool output receipts, hashes, current terms
review and visual acceptance. The evidence generator checksum-binds that record
to the committed tree and requires one complete record for every generated
asset. The resulting asset evidence has zero held assets and zero gaps, closing
the source-tree asset-review blocker without changing the separate runtime and
image-layer evidence boundary.

## Separate built-image and runtime-distribution work

- Review the exact installed-runtime receipt and generate publication-ready
  notices from those artifacts, not the development dependency superset alone.
- Select the exact built npm subset, collect and verify its license/copyright
  texts, resolve every reciprocal/source-choice review, and bind the final notice
  bundle to the release artifact.
- Inventory the complete Agent Zero image and every installed OS package.
- Inventory the transitive downloads executed by the pinned `bux` installer.
- Replace or explicitly opt in to the proprietary Chrome browser surface.
- Complete real isolated-computer, identity, BYOK, native-view, restart, and
  teardown acceptance before enabling the reviewed Buzz or DeepSeek Harness
  adapter directions. See the [bounded assessment](VERIFICATION-STATUS.md).
- Make the portable Hermes configuration consume an immutable reviewed image
  identity, or exclude the existing mutable managed lane from the first public
  artifact and claims. The current source/image link is verified, but its exact
  image-layer SBOM, notices, source obligations, and assets remain open.
- Keep new Operator OS launch paths absent until its complete source, license,
  portable runtime configuration, and artifact evidence enter the public boundary.

Those gates block Hivra from publishing or mirroring the corresponding runtime
bytes and built images. They do not block the exact source-only archive, which
contains none of those external artifacts and validates every upstream download
identity through `runtime-distribution-boundary.json`. The source candidate still
remains unreleasable until its self-host acceptance and independent export review
are complete.
