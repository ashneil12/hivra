# Canonical relationship reader — 2026-09-06

Status: PASS for the staged SQL/TypeScript read layer only. Attachment and the
full core experience remain incomplete. No Canary migration or deployment.

## Target and authority

Repository: Hermesdeploy-canary, branch `codex/hivra-core-experience-plan`,
baseline `30c22d233`; this receipt belongs to the commit containing the reader.
High-risk data-contract work, limited to source and isolated fixtures under
the user's continuing Canary implementation authority. No retained computer,
provider resource, credential, model request or spending was involved.

Migration: `20260906180000_hivra_canonical_relationship_reader.sql`.
SHA-256: `f4bf8e8b402f09bf91bf9e49c43311994cf38d9ce1aab9ca455b9395a4f2537c`.

## Implemented behavior

- A service-role-only SQL read function returns a single owner/computer-scoped
  snapshot with explicit projected fields and decimal-string bigint values.
- Installations and binding history are independent of original launch mapping
  IDs. Identities are restricted to the owner's scoped bindings, with deduplication.
- The strict TypeScript schema validates ownership, references, uniqueness,
  authority shape and timestamps without inventing readiness or runtime work.
- Storage/transport failures and malformed envelopes produce a sanitized error;
  only an explicit successful null result means the computer was not found.
- No API route, UI control, write grant or global read-mode switch is enabled.

## Bounded verification

From `dashboard/`:

```sh
npm test -- --runInBand --runTestsByPath src/lib/agent-computers/__tests__/relationship-reader.test.ts
npx eslint src/lib/agent-computers/relationship-reader.ts src/lib/agent-computers/relationship-snapshot.ts src/lib/agent-computers/__tests__/relationship-reader.test.ts
npx tsc --noEmit
```

Five tests pass. The suite executes `test-hivra-canonical-relationship-reader.cjs`
against actual migrations in PGlite and parses the resulting JSON with the
application schema. SQL checks cover original empty relationships, independently
persisted installation and detached binding history, preserved launch provenance,
legacy source-event advancement, owner isolation and execution ACLs. These rows
are explicit database fixtures, not evidence of a guest installer or runtime.

A malformed-envelope regression was observed red before the correction: missing
or false-like error fields could be classified as not-found. The corrected guard
requires own data/error fields, literal null error and a non-array object. Missing,
undefined, false, zero, empty-string, array and inherited-field cases now fail
closed. Independent reviewer Pauli identified this issue and reviewed the scoped
SQL/contract implementation, then independently reran all five tests and returned
scoped GREEN after the correction. Lint and full TypeScript checking pass.

## Preservation, rollback and remaining work

PGlite fixtures close on completion; no cloud or retained resources were changed.
The migration remains unapplied. Rollback of this source-only milestone is a
normal reviewed revert; no live rollback was required or exercised.

Authenticated routing, canonical commands sharing the existing guest lifecycle
lease, a non-destructive pinned installer, UI and owned live attachment acceptance
remain outstanding. Installation state and audit history are storage observations,
not proof of a running agent, model authentication, safe detach or recovery.
