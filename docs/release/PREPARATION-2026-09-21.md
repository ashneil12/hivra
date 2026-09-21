# Public-source preparation: 21 September 2026

Status: private source candidate created; release acceptance still blocked. No
publication or hosted cutover.

The baseline for this rehearsal is main at `1b871926fcc1cce88f703675ec3d577628af777b`.
The workspace navigation test used a non-placeholder resource UUID; replacing it
with a conventional documentation fixture made the current-tree hygiene check
pass. No scanner exemption was added.

The candidate generator with npm 11.19.1 stopped at missing bundled-package path
metadata. With isolated npm 10.9.3 it passed the release regression, dependency,
notice, source/runtime-boundary and credential-record stages, then stopped at
16 assets absent from the provenance policy. A seventeenth asset, the selected
Hivra logo, was added afterward. All 17 now have exact byte-bound records. These
results remain intermediate checks, not a complete candidate, self-host pass or
fresh independent review.

## Completed asset provenance records

The twelve font paths were downloaded again from their official IBM Plex,
Manrope and Google Fonts sources and matched byte-for-byte. Their adjacent
OFL-1.1 files and exact source URLs are bound in `font-license-evidence.json`.
The five artwork records use a separate repository-owner originality assertion;
the independent evidence boundary remains explicit. Four have repository history
only. The selected logo also matches the owner-supplied original byte-for-byte.
No missing prompt, generation tool, receipt or upstream source was invented.

| Asset | SHA-256 |
| --- | --- |
| `dashboard/public/fonts/IBMPlexMono-Regular.ttf` | `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46` |
| `dashboard/public/fonts/Manrope-Variable.ttf` | `d0639be45d0af36e798172419d7bd173c4bd4f29e2b76cbb69db1d11bf8b0a40` |
| `dashboard/public/images/computers/omarchy-workspace.webp` | `4256e8336fee29c3e7a785f214e9150c6a2d63539857a6238b27a42aca6db5e7` |
| `dashboard/public/images/computers/ubuntu-workspace.webp` | `ab85e7d5438042c079119e583b9da925d6f00d7b43b5b7d965f27b2d2caf854c` |
| `dashboard/public/images/computers/windows-workspace.webp` | `360bff5bd1bb52f2877bd7a60d24dea8abfe3051a57b2d334699222f08c525a3` |
| `docs/designs/2026-09-08-hivra-workspace/assets/outfit-latin.woff2` | `92684e4acde79ef07758cd09380b7e01e9824d8b061eddeda046f78c166d7b12` |
| `docs/designs/2026-09-08-hivra-workspace/assets/space-grotesk-latin.woff2` | `a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557` |
| `docs/designs/2026-09-08-hivra-workspace/assets/space-mono-bold-latin.woff2` | `af7cf6d2b897ec453acdcdacde4e9bcc8410718af5914de865b453e09f10eebc` |
| `docs/designs/2026-09-08-hivra-workspace/assets/space-mono-latin.woff2` | `e0c8e616bda27642f4c3cebaecff6525d901e73afc8a227cbbb0f2af4810f300` |
| `docs/designs/2026-09-17-hivra-usability-overhaul/assets/outfit-latin.woff2` | `92684e4acde79ef07758cd09380b7e01e9824d8b061eddeda046f78c166d7b12` |
| `docs/designs/2026-09-17-hivra-usability-overhaul/assets/space-grotesk-latin.woff2` | `a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557` |
| `docs/designs/2026-09-17-hivra-usability-overhaul/assets/space-mono-bold-latin.woff2` | `af7cf6d2b897ec453acdcdacde4e9bcc8410718af5914de865b453e09f10eebc` |
| `docs/designs/2026-09-17-hivra-usability-overhaul/assets/space-mono-latin.woff2` | `e0c8e616bda27642f4c3cebaecff6525d901e73afc8a227cbbb0f2af4810f300` |
| `docs/litepaper/assets/boundary-monolith-v5.png` | `cebb1ae84c23f7eaae8fdc9825c0fc028e90eb66c968e77d11fd9e844ebb5ee2` |
| `docs/litepaper/assets/fonts/IBMPlexMono-Regular.ttf` | `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46` |
| `docs/litepaper/assets/fonts/Manrope-Variable.ttf` | `d0639be45d0af36e798172419d7bd173c4bd4f29e2b76cbb69db1d11bf8b0a40` |
| `docs/brand/hivra-logo.jpg` | `9ddfe937f7ab5e0025c903db1316bb2d960c15190ac49fdc6ab156d9e759a6f4` |

## Exact candidate evidence

From clean commit `63aa1145e16e87bff9a929debc6ff52207a91920`, the
candidate builder ran with isolated npm 10.9.3 and produced a source-only review
candidate containing 3,722 tracked files. The asset pass reported 24 tracked
assets, 18 unique blobs, 24 inclusions, zero held assets and zero asset gaps. Its
font evidence covers twelve paths and six unique OFL-1.1 blobs; its owner record
covers five artworks and identifies one independent original-file byte match.

The source archive SHA-256 is
`6b729a10213b3a45af9874cad7db6451769407ecabae854e251c63a187ccd42d`.
The candidate remains `releaseApproved: false` with exactly two recorded
blockers: `complete-self-host-acceptance` and `fresh-context-export-review`.
The generated dependency and notice records still disclose metadata overrides,
license-text collection work and runtime/image notices outside npm scope; those
records are review evidence, not a claim that separately built images are cleared.

## Remaining acceptance

Run exported-source bootstrap/recovery against this exact archive, then obtain an
independent review of the same bytes and combined approval. Earlier self-host
receipts are not approval for this revision. The separate Home redesign PR is not
included in this preparation branch.

Confirm the new public owner/name before creating its fresh root. Verify GitHub
security/reporting and branch settings, then follow the [transition runbook](PUBLIC-TRANSITION.md).
Production source switching and archival have not been performed.

The GitHub billing API was unavailable to the current CLI credential because it
lacks the `user` scope. Run counts alone do not establish billed usage. The Actions
budget's consumption source remains unverified; no budget was increased and no
required check was disabled.

## Owner follow-up

The owner approved the proposed Hivra repository name; `ashneil12/hivra` was
created empty and private on 2026-09-21. No private history or source has been
pushed to it. The owner also supplied the intended logo; its unchanged bytes,
selection record and source-file byte match are included in the provenance
review.

The owner clarified that the illustrations were not taken from other people;
the earlier transcription must not be treated as evidence of unknown ownership.
The release record identifies the exact asserted files and keeps those assertions
separate from independent evidence without inventing generation receipts.
