# Immutable portable provisioner manifests

These files are **outside** the uploaded guest/host bundle. Each manifest pins
every allowlisted deployment asset for its exact version, including README and
provenance documents. Do not change an existing release manifest to accommodate
an edit. Publish a new version, compatibility/worker recipe and manifest for an
intentional deployment change. Put staged development notes outside the bundle.

`2026.08.31.1.json` records the exact bundle published in
`5eb86931feba2bc7e82e1c17841957775ac88e89`, not the later staged-package notes.
The release safety suite recomputes the complete manifest and tests that a
documentation-only byte change still fails. This prevents accidentally changing
the hash expected by already prepared computers without changing the version.

This is source/bundle integrity evidence, not guest readiness, a signature or
permission to redistribute downloaded dependencies. Future manifests must be
reviewed with their associated runtime change and acceptance.
