# Core experience direction

This is product direction, not a claim that every path is implemented or released.
The [roadmap](../ROADMAP.md) and revision-bound verification identify remaining work.

Hivra should let a user choose an agent or a computer, choose where it runs, and
start using it without learning the underlying infrastructure first.

- Agent and Computer are sibling choices. A Computer can exist without an agent;
  attaching an agent later is explicit.
- Launch is one resumable journey, with compatible defaults and a review step.
  Provider connection, purchases, host preparation, admission, and launch keep
  their own authorization and verification boundaries.
- Managed cloud is a convenient default when available. Customer-owned provider
  accounts and servers remain part of the same product.
- Self-hosting requires no Hivra Cloud account. It uses a local operator identity;
  optional cloud linking must not merge data or secrets silently.
- Advanced controls are available without overwhelming the default experience.
  Existing runtime-native interfaces remain available.
- Ubuntu, Omarchy, Windows, and macOS paths have separate operating-system,
  licensing, hardware, isolation, performance, and recovery requirements.
- Web/Canary verification precedes wider delivery. Native clients use the same
  control plane and have their own distribution and transport acceptance gates.
- Multi-agent orchestration builds on working single-resource execution,
  permission, recovery, and stop controls.

Experience simplification must preserve distinct identities, visible costs, tenant
isolation, and meaningful consent. Documentation never grants permission to change
managed infrastructure or promote a production deployment. Follow the
[release process](release/MANAGED-HOSTING-RELEASES.md).
