# Changelog

This changelog records verified changes to the public Hivra repository. It is not
an automatically generated history or a list of everything running in managed
hosting. Older mixed-repository development notes were archived privately.

## 2026-09-21

### Public source

- Published the reviewed source under Apache-2.0 in `ashneil12/hivra`, with
  self-host setup, contributor guidance, security reporting, and dependency notices.
- Added explicit managed release controls: main builds staged candidates, Canary
  tests selected revisions, and production requires separate promotion. See
  [PR #4](https://github.com/ashneil12/hivra/pull/4) and the
  [release guide](docs/release/MANAGED-HOSTING-RELEASES.md).
- Removed internal planning material, personal tooling instructions, old rollout
  notes, design experiments, and an unrelated demo from the current public tree.

### Known limitations

- Broader dashboard verification remains tracked in
  [issue #3](https://github.com/ashneil12/hivra/issues/3).
- Provider release identities and activation of the staged desktop/cursor work
  remain tracked in [issue #2](https://github.com/ashneil12/hivra/issues/2).

A source change or changelog entry does not mean it has been promoted to managed
production. Release evidence identifies the exact tested and deployed revisions.
