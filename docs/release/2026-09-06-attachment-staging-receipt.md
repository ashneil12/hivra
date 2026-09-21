# Attachment staging receipt boundary — 2026-09-06

Source-only checkpoint on `codex/hivra-core-experience-plan`, baseline
`23c86ec5f`. `attachment-staging-receipt.ts` validates a bounded JSON receipt
against expected operation, installation and architecture. It requires the
reviewed private account/path convention, non-root numeric UID/GID, exact
runtime/version, archive digest and binary digest, and rejects unknown fields.
Only `state: staged` is accepted. It performs no persistence or lease release.

The stager remains pinned to
`77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375`.
The test hashes the actual stager source and checks its archive pins, preventing
an unnoticed source change from retaining this acceptance identity.

The sole executable members of the already verified downloaded archives were
streamed through SHA-256, without executing or modifying them:

- x86_64: `73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba`.
- aarch64: `2447e3fef519401ff6d6e90759ab1bf66082da48966fc6e4fe9a77108f9c20d8`.

These expected values reject a mismatched reported hash; they do not prove that
a remote guest actually has or runs those bytes. Authentic observation and
process-release verification remain the worker's responsibility.

Verification from `dashboard/`:

```sh
npm test -- --runInBand --runTestsByPath src/lib/agent-computers/__tests__/attachment-staging-receipt.test.ts
npx eslint src/lib/agent-computers/attachment-staging-receipt.ts src/lib/agent-computers/__tests__/attachment-staging-receipt.test.ts
npx tsc --noEmit
```

Twenty tests pass, including malformed/unrelated receipts, root IDs, wrong
private paths, architecture/digest mismatch, extra fields and oversized output.
Lint and full TypeScript checking pass. The initial test failed on the absent
parser. These are synthetic protocol fixtures, not a new guest execution test.
Independent reviewer Pauli inspected the final parser, reran all twenty tests
and returned scoped GREEN. The reviewer did not remeasure archive members;
neither review nor parser output establishes remote authenticity or readiness.

No live environment, resource, model or spending changes occurred. The parser
is not yet wired to a worker. Durable installation/binding ID reservation,
authenticated observation, terminal handling, runtime activation and live
attachment acceptance remain unfinished. Source rollback is a reviewed revert;
no live rollback or temporary-resource teardown was needed for this checkpoint.
