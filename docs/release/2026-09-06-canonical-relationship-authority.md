# Staged canonical relationship authority

Local/source milestone on 2026-09-06. No Canary migration or guest mutation.
Migration `20260906170000_hivra_canonical_relationship_authority.sql` SHA-256:
`eac854d9b517b8691457faabc9d32b92901a78119be7d092345c8a52bacd53aa`.

## Implemented scope

Per-entity authority epochs and a relationship controller separate agent
relationships from legacy computer lifecycle. The database-owner-only transfer
RPC admits an exact owner/source/generation, records an atomic command and audit
outbox event, and supports exact replay. It does not dispatch a worker. Browser
and service-role execution remain revoked. Legacy projection updates computer
state without reclaiming canonical identity, installation, or binding fields.
The old shadow reader is blocked for these epochs, including when it was
selected before a transfer was requested. Control metadata reports mixed
authority; computer lifecycle itself remains constrained to legacy ownership.

## Executed checks

From `dashboard/`, the standard Jest run over
`hivra-canonical-authority-postgres`, `hivra-canonical-provenance-postgres`,
`canonical-shadow`, and `hivra-canonical-resource-shadow-migration` passed
4 suites / 21 tests in 2.115 seconds. The actual SQL fixtures cover pre-existing
and newly projected resources, owner/computer/generation FKs, stale source and
epoch, active lifecycle rejection, exact replay without duplicate audit events,
outbox-insertion failure rolling back transfer, legacy update/delete preservation,
reader rejection, and prior provenance/coverage regressions. Wrapper lint and
diff checks passed. The initial missing-RPC regression failed before implementation.

`node scripts/test-hivra-canonical-authority-concurrency.cjs` then passed with
separate sessions against an already-present PostgreSQL 17 image, pinned by ID:
`sha256:ff80089083d7365046af7f03d949a2defa14e0b09e14bd5b8f08a242291be8b2`.
It observed real `pg_stat_activity` lock waiters and verified:

- Read-mode switch wins: the waiting transfer returns no mutation.
- Transfer wins: exact concurrent replay returns the original receipt and only
  one outbox event; the waiting old-reader switch rejects unsupported authority.
- Legacy update wins: a waiting transfer rejects its stale expected source event
  without a partial command or authority change.

The fixture uses minimal typed legacy tables and the actual canonical migration
files. It is not a full-schema/self-host migration test or a guest lease test.
Its first run reached initdb's temporary server and disconnected on that server's
shutdown; cleanup completed. Readiness was corrected to require the final PID 1
PostgreSQL process. The final run above passed against the exact migration hash.

Review identified a test-container cleanup gap after an unacknowledged Docker
creation. Cleanup now reconciles the exact name and owner label and stops only
the observed full container ID, even when `docker run` throws. If the owned container
was created but never started, cleanup explicitly removes that same ID without
force rather than relying on auto-removal. An injected CLI
driver exercises the real `main` failure/finally path; absence, ownership
conflict, multiple IDs, unstarted containers and observation failure are separately tested. These are
simulated cleanup regressions, not extra live-container acceptance runs.

Independent source review found and verified the read-mode conflict correction;
the final SQL and cleanup changes received scoped GREEN with no remaining
actionable finding. The reviewer independently reran the isolated SQL and
injected cleanup fixtures, not the final live Docker contention run.

## Preservation and remaining gates

The actual test container used `--network none`, no host ports or bind mounts,
a 256 MB tmpfs database and `--rm`. The exact owned container was confirmed
absent after stopping; its disposable database was erased. No existing Docker
container, Canary computer, provider allocation, model allowance, or billing
setting was changed. Additional Hetzner/model spend: zero.

This is metadata groundwork, not completed attachment, a rollout-ready reader,
or a full authority cutover. The compatible reader, real canonical commands and
guest execution fence, non-destructive installer/detach, reverse-migration
boundary, full self-host migration, and real useful-work acceptance remain open.
Keep the RPC ungranted and do not apply this migration to Canary before those
gates are satisfied. No live rollback was required or exercised.
