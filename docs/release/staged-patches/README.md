# Staged desktop broker changes

`desktop-stream-cursor.patch` preserves the modern stream-profile and captured-cursor changes consolidated during the source release. It is not applied to the portable installer bundle. The candidate source remains in `dashboard/runtime-adapters/remote-desktop/broker.staged.cjs`, with its behavioral tests in `broker.test.cjs`. The separately retained `sealed-broker.test.cjs` tests the actual installer broker.

The initial consolidation changed `remote-desktop/broker.cjs` while retaining the sealed `2026.09.15.2` release manifest. That breaks exact-byte installation verification and changes the desktop capability digest. The source release restores the manifest-matching broker; the patch retains the newer work without silently rewriting an existing release.

Before activating this patch for fresh installations:

1. Create a new provisioner version and immutable manifest.
2. Bind the new desktop capability digest and retain the exact prior identities and manifests.
3. Add and test the provider SQL admission for the new identity, then verify fresh installation and recovery on a disposable target.

Do not apply this patch directly to an existing host or guest. A dashboard deployment does not modify installed desktop brokers. Previously installed custom cursor changes remain in place, but are not evidence that a fresh installation uses this staged patch.

Provider runtime admission also needs reconciliation: TypeScript currently selects 15.2 while the retained Python native/desktop worker and SQL admission use earlier sealed identities. Fresh provider desktop installation is not certified by this source release. Existing installed computers must retain their observed identity; do not relabel them as a new release.
