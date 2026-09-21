# Hivra Security Model

**Status:** Target security contract and public-release gate

**Important:** This document defines required behavior. It does not claim that every control is implemented in the current repository.

## Security objective

Hivra runs capable, long-lived agents with code execution, files, browsers, networks, and meaningful credentials. The goal is to limit what any compromised user session, agent runtime, computer, provider credential, or operator account can affect; retain evidence sufficient to understand failures; and support rapid revocation and recovery.

Hivra cannot guarantee that capable agents are harmless or that compromise is impossible. Security claims must be narrow, testable, and tied to implemented controls.

## Trust boundaries

Treat these as separate zones:

1. user's browser or local client;
2. Hivra control plane;
3. credential store and key hierarchy;
4. infrastructure provider control surface;
5. each individual agent computer;
6. agent runtime and installed tools;
7. external model, source-control, browser, and integration providers;
8. backup and archive storage; and
9. Hivra or self-hosted operator access.

Compromise of one agent computer must not grant control-plane, provider, backup-key, neighboring-computer, or unrelated credential access.

## Identity and command channel

Target requirements:

- each computer enrolls with a unique cryptographic identity;
- control-plane commands are authenticated, authorized, scoped, replay-resistant, and ordered;
- computer identity can be revoked without rebuilding unrelated computers;
- command and run ownership use leases and idempotency keys;
- stale or duplicated delivery cannot create a second execution; and
- incompatible runtime or protocol versions fail visibly before mutation.

## User-facing access

Terminal, browser, native view, and future desktop access use short-lived grants bound to:

- user;
- selected computer;
- surface;
- audience;
- purpose; and
- expiry.

Initial acceptance targets:

- interactive grants expire within five minutes by default;
- new connections stop authorizing within 60 seconds of revocation;
- a grant for one surface or computer cannot open another; and
- reusable passwords or bearer secrets never appear in URLs, browser history, referrers, analytics, application logs, or proxy logs.

Browser automation and live human takeover have separate, visible control ownership.

## Credentials

- Store encrypted values behind typed credential references and policy.
- Release a value only to the authorized runtime boundary that needs it.
- Scope bindings by user, optional project, agent identity, computer, runtime, environment, and purpose.
- Keep infrastructure provider credentials off guest computers.
- Redact logs, events, artifacts, crash reports, analytics, and support exports.
- Rotate credentials at both the control-plane and runtime boundaries.
- Make export, retention, and deletion behavior explicit.
- Provide self-hosted master-key bootstrap, backup, recovery, and rotation without a Hivra-held key.

## Computer and network isolation

- Each agent computer has an independent provider identity and least-privilege network policy.
- Inbound access is brokered rather than exposed by default.
- Administrative host access is distinct from customer access and audited.
- Provider APIs and host commands validate exact target identity before destructive mutation.
- Missing resources and orphans become visible drift incidents; they are not silently adopted or deleted.
- Image origin, digest, update channel, rollback, and vulnerability response are documented.

## Lifecycle and execution safety

- Desired lifecycle state, observed provider state, Hivra health, and operation state remain separate facts.
- Operations carry stable ids, idempotency keys, actors, leases, provider references, and terminal results.
- Terminal run state is immutable.
- An indeterminate cancellation remains quarantined and cannot be retried while side effects may continue.
- Blind retry is prohibited for non-idempotent work.
- Delete is not complete until provider absence and access, credential, DNS, inventory, snapshot, backup, and retention outcomes are reconciled.

## Backup, snapshot, and restore

- Backup objects are encrypted with keys separated from backup storage.
- Restore requires authorization and produces an audit event.
- Snapshot policy states whether credentials are excluded, re-bound, or protected by a restorable key hierarchy.
- Restored computers re-enroll or revalidate identity before accepting work.
- Credential bindings after restore follow an explicit policy and do not silently reactivate revoked material.
- Deletion and retention schedules cover active storage, snapshots, backups, cold archives, and derived artifacts.
- Self-hosted documentation includes recovery rehearsal, not only backup creation.

## Audit and privacy

Audit records should answer who requested an operation, what resource and capability were targeted, which component acknowledged it, what provider mutation occurred, and how it ended.

Audit data must not become a second secret or customer-data leak. Events use tenant-safe summaries and references rather than raw credentials, unrestricted command output, or cross-tenant metadata.

Retention is purpose-limited and documented. Customer export and deletion behavior must include audit, artifact, backup, and support-system boundaries where legally and technically applicable.

## Self-hosted responsibility

Self-hosting transfers operational responsibility; it does not remove security requirements. Documentation must distinguish:

- controls implemented by Hivra software;
- controls requiring provider or network configuration;
- controls requiring operator key management and monitoring; and
- features not yet hardened for hostile multi-tenant use.

Default configurations should fail closed when identity, encryption, or authorization prerequisites are absent.

## Current known architectural risks

The current repository must address these before the reference release:

- separate Hermes and Hivra lifecycle and access paths;
- presentation-only agent unification;
- mutable host-side Hivra provisioner and chat assets outside this repository;
- legacy and current status vocabularies that can drift;
- access paths that predate the target short-lived, surface-bound grant contract;
- secret and sensitive-data exposure risk in a long private Git history; and
- incomplete artifact-specific notices, source obligations, and distribution
  decisions despite the committed Apache-2.0 license for Hivra-owned source.

This list is architectural, not a claim that a specific exploitable vulnerability exists in every area.

## Required verification

Before the first reference release:

- cross-user and cross-computer authorization matrix;
- grant expiry, audience, surface binding, revocation, replay, and URL/log leakage tests;
- provider target-identity and destructive-operation tests;
- secret redaction and credential-rotation tests;
- encrypted backup, unauthorized restore, audited restore, and credential-after-restore tests;
- master-key bootstrap, recovery, and rotation rehearsal;
- missing-resource, orphan, expired-lease, and partial-operation reconciliation tests;
- run duplicate-delivery, reconnect, cancellation-indeterminate, and terminal-immutability tests; and
- independent public-release history and dependency review.

High-risk changes to auth, credentials, provisioning, lifecycle, access brokerage, backup, deletion, or migrations require focused hot-path tests and a live canary check when applicable.

## Reporting

The current private disclosure instructions and monitored email are documented
in [`../SECURITY.md`](../SECURITY.md). Public-repository publication remains
gated on enabling and testing GitHub private vulnerability reporting; do not
claim that channel exists until the repository setting is verified.
