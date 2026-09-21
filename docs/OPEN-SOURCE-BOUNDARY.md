# Hivra Open-Source and Hosted Boundary

**Status:** Current public-source boundary. The initial reviewed source export is published; runtime images, desktop installers, and managed deployments have separate acceptance gates.

## Decision

Hivra publishes its functional platform source under Apache-2.0. The complete
agent-computer platform remains the target; publication does not establish
acceptance of every capability described below.

The intended model is not “open core.” An independent operator should be able to provision, operate, observe, repair, update, back up, restore, and offer the same functional agent-computer platform without private Hivra infrastructure or code.

Hivra Cloud is the managed operating mode of the public platform. Customers pay Hivra to take responsibility for infrastructure credentials, provisioning, updates, monitoring, security response, backup, recovery, and support.

## Public platform scope

- web application and control-plane services;
- domain and database schemas;
- versioned computer runtime;
- runtime adapters and capability contracts;
- provider adapters and infrastructure orchestration;
- images, provisioning, lifecycle, networking, and storage automation;
- durable run, event, approval, and artifact contracts;
- credential-binding and access-grant implementation;
- terminal, browser, native-view, and future desktop brokers;
- observability, audit, diagnostics, reconciliation, and repair tools;
- backup, restore, upgrade, migration, and uninstall logic;
- contract, security, integration, and live-canary tests;
- local development and self-hosting tooling; and
- operator and recovery runbooks.

Provisioning and incident-repair machinery is not withheld merely because it is operationally valuable.

## Environment-specific private material

- actual production keys, tokens, passwords, private keys, and signing material;
- customer accounts, conversations, files, artifacts, backups, billing records, and personal data;
- live host inventory, network addressing, access endpoints, and administrative credentials;
- private support communications;
- incident records containing customer or infrastructure-sensitive detail; and
- Hivra-specific accounting, payroll, sales, or hosted-customer administration not needed to operate the platform.

Generic incident tooling, sanitized runbooks, repair logic, and reusable monitoring remain public even when individual incident records are private.

## Hosted-only code test

Hosted-specific code is acceptable only when it serves Hivra's own business or customer-operation context and is unnecessary for functional parity.

Ask:

> Could another operator use the public repository to provide the same agent-computer capabilities on infrastructure they control?

If the answer is no because a functional component is private, the boundary is wrong.

## Third-party runtimes

Hivra's adapter can be open source even when the connected runtime has different terms. Every runtime requires an explicit distribution decision:

- **Bundle:** permitted artifacts ship with Hivra.
- **Download:** the installer retrieves the runtime from its official source under its terms.
- **Connect:** the user installs or supplies the runtime and Hivra only integrates it.

Codex, Hermes, Buzz, and future runtimes must be assessed individually. Hivra documentation must not imply ownership of, or an open-source license for, third-party software.

Buzz is adapter-first until its exact project identity, license, architecture, authentication, deployment model, UI embeddability, and maintenance health are verified. Reusing a Buzz subsystem is acceptable only behind Hivra-owned computer, provider, identity, security, lifecycle, and execution contracts.

## License and release gate

Hivra-owned source is licensed under Apache-2.0. The root `LICENSE`, repository
`NOTICE`, contribution terms, trademark policy, security policy, reproducible npm
inventory, and current per-runtime decisions are committed release inputs.
Apache-2.0 permits forks and competing hosted operators and includes an explicit
patent grant. The separate trademark policy prevents source confusion without
restricting those code rights.

The initial source publication is recorded in [the public transition](release/PUBLIC-TRANSITION.md).
That source-only milestone does not approve every runtime, image, installer, or
future revision. For each new release:

- review the exact source or built artifact and its release evidence before
  presenting it as an accepted release;
- do not assume the root license grants redistribution rights for third-party
  runtimes, images, dependencies, assets, names, or services;
- do not publish history that has not passed sensitive-data review and confirmed
  credential rotation; and
- do not omit exact artifact notices or source-offer obligations from a release.

The remaining runtime and artifact work is tracked in
[`release/RUNTIME-DISTRIBUTION.md`](release/RUNTIME-DISTRIBUTION.md) and
[`release/DEPENDENCIES.md`](release/DEPENDENCIES.md). The final candidate should
receive appropriate legal review; repository analysis is not legal advice.

## Contribution principles

- Public issues and pull requests can improve core operation, not only extensions.
- Capability claims require tests or reproducible evidence.
- Provider and runtime integrations use public versioned contracts.
- Security reports use a private disclosure path until remediation is safe to publish.
- No contributor is required to transfer customer data, production access, or private credentials.
- Managed Hivra changes that improve the functional platform are mirrored into the public code unless they fall within the narrow environment-specific boundary above.

## Public-release decision

The original private `main` history through audit target `8308da55c1a2` (3,243
commits) was scanned and the initial release used a
[fresh public repository from an exact reviewed current-tree export](release/PUBLIC-REPOSITORY-DECISION.md).
The original private history was not included in the public export and remains
private. This is a security decision, not a product boundary: it must not be used to hide functional
code. Every discovered credential is remediated whether history is preserved or
restarted.

## Commercial website and content

The repository includes the hosted website and blog alongside the application.
Their inclusion does not make them a prerequisite for self-hosting. Local-auth
builds redirect the homepage and commercial blog, feature, comparison, token,
and founder pages to the dashboard, emit noindex headers, disallow crawling,
and return an empty sitemap. Authentication and functional application routes
remain available. These crawler directives are not access controls.

The existing Apache-2.0 scope in `NOTICE` remains unchanged, including existing
Hivra-owned article content without a separate license. Hivra branding remains
subject to `TRADEMARKS.md`. A future separately licensed editorial collection
must state its terms explicitly; moving existing files does not revoke previously
granted permissions.
