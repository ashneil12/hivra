# Hivra Agent Computers — Phase 0 Implementation Plan

**Date:** 2026-08-24

**Status:** Active

**Design authority:** [`../specs/2026-08-24-hivra-agent-computers-design.md`](../specs/2026-08-24-hivra-agent-computers-design.md)

## Goal

Create one code-verified source of product truth and make a safe, evidence-backed decision about publishing the repository. Phase 0 does not rewrite Git history, expose infrastructure, or claim that target architecture is already implemented.

## Operating constraints

- Preserve production behavior and unrelated worktree changes.
- Do not publish the repository before the secret, sensitive-data, dependency, and license gates pass.
- Treat every discovered secret as compromised and rotate it; deleting it from Git is not remediation by itself.
- Keep current capabilities and target capabilities clearly labeled.
- Do not implement another UI or provisioning lane during Phase 0.
- Commit and push each verified milestone to canary using a normal fast-forward push.

## Workstream A — Canonical product truth

### Task A1: Establish documentation precedence

Update `AGENTS.md` so contributors and future agents use this order:

1. `VISION.md` and `docs/PRODUCT-ARCHITECTURE.md`;
2. the approved subsystem design specification;
3. the active roadmap and implementation plan;
4. verified current code and tests;
5. historical plans only as background.

Verification:

- the precedence is explicit;
- historical documents cannot silently override the approved design;
- target claims must be labeled until implemented.

### Task A2: Publish the canonical vision and architecture

Create:

- `README.md` — repository entry point and honest current-state summary;
- `VISION.md` — durable product intent and non-negotiable product principles;
- `docs/PRODUCT-ARCHITECTURE.md` — current-system map, target boundaries, domain vocabulary, and migration direction;
- `docs/OPEN-SOURCE-BOUNDARY.md` — functional public boundary, hosted operating mode, license gate, and third-party runtime treatment;
- `docs/SECURITY-MODEL.md` — trust boundaries, target controls, honest limitations, and release gates.

Verification:

- every current-state claim points to a real file, table, route, or test family;
- target-state sections are visibly marked;
- no document calls the repository open source before an OSI-approved license is committed.

### Task A3: Replace stale execution direction

- Replace `ROADMAP.md` with the approved phase sequence.
- Rewrite `.agents/product-marketing-context.md` around agent computers, developers and AI power users, self-managed and Hivra-managed operating modes, and claims discipline.
- Mark superseded implementation plans historical and superseded without deleting their evidence from Git history.
- Update `dashboard/README.md` so it describes the current Hivra control plane and links to canonical documentation.

Verification:

- no active roadmap calls the product HermesOS;
- the active roadmap does not prioritize unrelated marketing backlog over the agent-computer migration;
- pricing, token mechanics, and legacy architecture are not treated as current product authority;
- useful current dashboard setup instructions remain intact.

## Workstream B — Public-release safety audit

### Task B1: Inventory repository and reachable history

Record:

- repository and remote identities;
- shallow/full history state and reachable commit count;
- tracked files, large objects, submodules, LFS objects, generated artifacts, and ignored environment files;
- active and historical branches included in the intended public release.

The audit must account for the repository currently being shallow. A history verdict cannot claim completeness until the intended history is available locally or scanned by an equivalent remote-capable process.

### Task B2: Scan secrets and sensitive data

Run at least two complementary checks:

- pattern and entropy-based secret scanning across the current tree and intended history;
- targeted inventory for environment files, private keys, tokens, host details, customer exports, database dumps, backups, logs, patches, and generated caches.

Classify findings as:

- confirmed secret;
- likely secret requiring owner verification;
- sensitive operational detail;
- customer or personal data;
- false positive; or
- public-safe configuration.

Output a redacted report. Never place discovered secret values in the report, commit, chat, or command output.

### Task B3: Dependency, asset, and license review

- Generate dependency and software-bill-of-materials inventories for shipped components.
- Identify required notices, source offers, attribution, or redistribution constraints.
- Identify the exact Buzz project before evaluating integration.
- For Codex, Hermes, Buzz, and every other third-party runtime, decide whether Hivra bundles, downloads, or connects to a user-installed copy.
- Compare appropriate OSI-approved licenses against the user's stated acceptance of forks and competing hosted operators.
- Produce a license recommendation, trademark boundary, and unresolved legal questions.

No license recommendation is represented as legal advice.

## Workstream C — Release decision and remediation

### Task C1: Decide history strategy

Choose one:

- **Preserve history:** all confirmed secrets and sensitive objects can be removed, rotated, and independently re-scanned with acceptable residual risk.
- **Fresh public repository:** the cleaned current tree is publishable, but preserving existing history creates unacceptable residual risk.

The decision report includes evidence, residual uncertainty, exact included refs, rotation status, and rollback.

### Task C2: Commit the release boundary

Before public release, commit:

- selected OSI-approved root license;
- third-party notices;
- dependency/SBOM report or reproducible generation command;
- trademark policy;
- security reporting policy;
- sanitized example environment configuration;
- self-hosting status and limitations; and
- per-runtime distribution decisions.

### Task C3: Independent release review

A reviewer who did not perform remediation receives the raw scan configuration, redacted findings, included refs, proposed public tree, and license artifacts. Public release remains blocked until the reviewer returns a green verdict or the user explicitly accepts documented residual risk.

## Phase 0 acceptance criteria

- Canonical documentation is committed, internally linked, and distinguishes current from target behavior.
- Historical plans are visibly superseded.
- `main` and `origin/main` are synchronized before each implementation milestone.
- The intended public Git history has been scanned rather than assumed safe.
- Confirmed credentials are rotated and removed from the proposed public history/tree.
- Customer data and live infrastructure access details are absent from the proposed public release.
- An OSI-approved license and required notices are committed.
- Third-party runtime distribution decisions are explicit.
- The history-preserve or fresh-repository decision is evidence-backed and independently reviewed.
- Only after these gates pass may product copy describe the repository as open source.

## Next phase

Phase 1 defines the canonical agent-computer, provider-adapter, runtime-adapter, lifecycle, capability, event, identity, and migration contracts. It also brings load-bearing provisioning and computer-runtime assets into version control before the Ubuntu + Codex vertical slice begins.
