# agent-overlay: stock upstream Hermes plus Hivra, with no fork

Builds the image Hivra boxes run: the official `nousresearch/hermes-agent` image, pinned by digest,
plus add-only files. Design, evidence and migration plan: `docs/release/NO-FORK-PLAN.md`.

```
Dockerfile              FROM <stock digest>; adds uv, gh, hermes on PATH, files/, the web bundles
files/                  add-only tree copied over /opt/hermes (plugins, tools, skills, gateway helpers,
                        hivra_overlay/ package with the runtime seams)
web/patches/            patch series applied to the upstream source at the release tag to build /webchat
                        and /dash (the Hivra browser bridge)
web-prebuilt/           optional, git-ignored: prebuilt bundles for WEB_MODE=prebuilt
tests/                  run inside the built image against the upstream tag's test tree
scripts/build-overlay.sh    resolve digest, build, check, test (self-hosted; does not push)
scripts/check-overlay.sh    guards: add-only, no junk or non-UTF-8, seams apply, tools on PATH
scripts/run-tests.sh        overlay tests in the image against an upstream checkout of the same tag
scripts/stub-llm-and-governor.py   test double used for the fixture experiment (not a product part)
```

Rules: never edit an upstream file in the image; never push `:stable` or `:latest`; push immutable
tags only (`<upstream tag>-<overlay version>-<git sha12>`); when `check-overlay.sh` goes red after an
upstream bump, fix the seam or the patch, do not weaken the check.

Bumping upstream: `scripts/build-overlay.sh vX.Y.Z <overlay-version> <upstream checkout at vX.Y.Z>`.
If the web patch no longer applies, re-port the failing hunk and add it to a new patch file.

Moving a running box onto this image, and how a moved box follows upstream by itself:
`docs/release/NO-FORK-MIGRATION.md`. `hivra_overlay/FILES.txt` (written by the Dockerfile) lists exactly
which paths are overlay files; the move copies those and nothing else out of the image.
