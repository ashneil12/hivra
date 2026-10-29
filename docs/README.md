# Hivra documentation

**Start with [what Hivra offers today](STATUS.md).** It is the single source of
truth for what launches, where it runs, what is in preview, and the owner
decisions behind each. Every other document here is one of the kinds below, and
none of them overrides that file on availability.

## Run and develop

- [Self-host quickstart](self-host/QUICKSTART.md)
- [Operator keys](self-host/OPERATOR-KEYS.md)
- [Dashboard development](../dashboard/README.md)
- [macOS application](../apps/macos/HivraMac/README.md)
- [Contributing](../CONTRIBUTING.md)
- [Changelog](../CHANGELOG.md)

## Understand the platform

Direction and target contracts. They say where Hivra is going, not what has
shipped.

- [Vision](../VISION.md) and [roadmap](../ROADMAP.md)
- [Product architecture](PRODUCT-ARCHITECTURE.md) and [core experience](CORE-EXPERIENCE.md)
- [Agent-computer design](superpowers/specs/2026-08-24-hivra-agent-computers-design.md)
- [Open-source boundary](OPEN-SOURCE-BOUNDARY.md)
- [Security model](SECURITY-MODEL.md) and [vulnerability reporting](../SECURITY.md)
- [Litepaper](../LITEPAPER.md) and [white paper](../WHITEPAPER.md)
- Design specifications in [`superpowers/specs/`](superpowers/specs/). Each is
  the target contract as of the date in its name.

## Release and operate

Current runbooks.

- [Managed hosting releases](release/MANAGED-HOSTING-RELEASES.md) (binding for Canary and production)
- [Hermes agent releases](release/HERMES-AGENT-RELEASES.md) and [moving agents onto upstream Hermes](release/NO-FORK-MIGRATION.md)
- [Repository and installation boundaries](release/PUBLIC-TRANSITION.md)
- [Repository settings checklist](release/REPO-SETTINGS-CHECKLIST.md)
- [Regression lockdown](regression-lockdown.md)
- [Proxmox storage and recovery](self-host/PROXMOX-STORAGE.md) and [workspace migration](self-host/WORKSPACE-MIGRATION.md)
- [GHCR token rotation](security/GHCR-TOKEN-ROTATION.md) and [key custody inventory](security/KEY-CUSTODY-INVENTORY.md)
- [Host compromise and guest quarantine runbook](security/HOST-COMPROMISE-RUNBOOK.md)
- Token runbooks in [`token/`](token/)
- Dashboard runbooks in [`dashboard/docs/`](../dashboard/docs/)

## Evidence

What has been verified, and how. Evidence is not availability.

- [Verification status](release/VERIFICATION-STATUS.md)
- [Dependency evidence](release/DEPENDENCIES.md)
- [Runtime distribution](release/RUNTIME-DISTRIBUTION.md)
- [Staged desktop changes](release/staged-patches/README.md)

## Dated records

Each describes one moment: a plan, packet, snapshot, review or decision at the
date it names. They are kept for history and are never read as current status.

- [Promote packet, 2026-10-08](release/PROMOTE-PACKET-2026-10-08.md)
- [Production cutover packet](release/PROD-CUTOVER-PACKET.md) and [snapshot](release/PROD-CUTOVER-SNAPSHOT.md)
- [Production chain rehearsal](release/PROD-CHAIN-REHEARSAL.md)
- [Public repository decision](release/PUBLIC-REPOSITORY-DECISION.md)
- [No-fork Hermes plan](release/NO-FORK-PLAN.md) and [Hermes fleet update plan](release/HERMES-FLEET-UPDATE-PLAN.md)
- [Pre-launch security review, 2026-09](security/PRE-LAUNCH-REVIEW-2026-09.md) and [its handoff](security/PRE-LAUNCH-REVIEW-2026-09-HANDOFF.md)
- [Site copy fix pass 2](site-copy-fix2-deviations.md) and [legal copy changes](legal-copy-changes.md) (needs solicitor review before publishing)
- [Logging spec](LOGGING_SPEC.md) (draft)
- Research notes in [`research/`](research/)

## Keeping this consistent

- A change to a launch catalog or a status label updates [STATUS.md](STATUS.md)
  in the same pull request.
- An owner decision is recorded in STATUS.md with its date, and every document
  it contradicts is fixed then, not later.
- A new document goes into one of the sections above. A plan or packet that
  describes one moment goes under Dated records with its date.

Public documentation explains setup, supported behavior, interfaces, architecture,
and release requirements. Internal business plans, personal agent skills, incident
notes, experimental mockups, and private rollout records belong outside this
repository. Technical specifications describe target contracts where explicitly
marked; they are not proof of deployed capability. Historical filenames in old
migration comments do not create a dependency on private planning documents.
