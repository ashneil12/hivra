# Staged desktop broker changes

The candidate source in `dashboard/runtime-adapters/remote-desktop/broker.staged.cjs`
preserves the modern stream-profile work consolidated during the source release.
Its behavioral tests are in `broker.test.cjs`; the separately retained
`sealed-broker.test.cjs` tests the actual installer broker.

The earlier `desktop-stream-cursor.patch` was removed after live feedback
identified its captured-video cursor as a latency regression. The candidate now
pins Selkies 2.0 RC1's host-Wayland cursor callback, keeps cursor pixels out of
the video, and preserves guest cursor images and hotspots as a local browser
cursor, including hand, text, resize and hidden states. The prior pinned image
emitted only a fixed arrow on this external Hyprland capture path.

The initial consolidation changed `remote-desktop/broker.cjs` while retaining the sealed `2026.09.15.2` release manifest. That breaks exact-byte installation verification and changes the desktop capability digest. The source release restores the manifest-matching broker; the staged candidate retains the newer work without silently rewriting an existing release.

Release `2026.09.21.1` activates only the local-cursor part of this work in
the sealed installer broker (`dashboard/provisioner/remote-desktop/broker.cjs`)
and the Omarchy installer, with its own immutable manifest. The stream-profile
changes in `broker.staged.cjs` remain staged. That release was verified by an
explicit re-preparation of one existing canary Omarchy computer and a real
short-lived desktop handoff; fresh installation and provider SQL admission for
the new identity were not certified.

Before activating this candidate for fresh installations:

1. Create a new provisioner version and immutable manifest.
2. Bind the new desktop capability digest and retain the exact prior identities and manifests.
3. Add and test the provider SQL admission for the new identity, then verify fresh installation and recovery on a disposable target.

Do not copy this candidate directly onto an existing host or guest. A dashboard
deployment does not modify installed desktop brokers. Previously installed
custom cursor changes remain in place, but are not evidence that a fresh
installation uses this candidate.

Provider runtime admission also needs reconciliation: TypeScript currently selects 15.2 while the retained Python native/desktop worker and SQL admission use earlier sealed identities. Fresh provider desktop installation is not certified by this source release. Existing installed computers must retain their observed identity; do not relabel them as a new release.
