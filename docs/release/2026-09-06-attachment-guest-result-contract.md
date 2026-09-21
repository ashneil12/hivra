# Attachment guest result contract — 2026-09-06

Scope: source-only server-side decoder for the durable guest staging envelope,
based on `7e6dd77f9`. No live deployment, database mutation, guest operation,
spending or retained-computer change.

`dashboard/src/lib/agent-computers/attachment-guest-result.ts` accepts exactly
the reviewed worker's `staged` envelope. It validates the full outer identity
(operation, dispatch, installation, binding, computer, source and architecture)
against independently supplied expected values and requires the independently
observed boot ID. The nested receipt is validated through the existing strict
installation parser, including private paths, account IDs and artifact pins.
Unknown fields, old/future phases, mismatches, oversized UTF-8 and concatenated
outputs are rejected. The worker digest is pinned with a source-drift regression.

Expected identity must come from an authorized durable dispatch; expected boot
must come from a fresh bound guest observation, not from the returned envelope.
The decoder itself cannot authenticate transport, prove current processes have
stopped, activate an agent, or authorize releasing the shared database lease.
No application caller is enabled by this milestone.

Verification: focused guest-result and nested staging parser suites pass,
**2 suites / 41 tests, 0.328s**. ESLint passes for both new TypeScript files.
These are synthetic contract cases, not live guest or UI acceptance. The prior
Linux worker execution is recorded separately in
`2026-09-06-attachment-guest-staging-fence.md`.

Source SHA-256: `b94e3940381c4fdacad4eb47922da50bcdf96b2884dc0ea0c06a6e0aa2c5accc`.
Test SHA-256: `e76e1a40cb0dd91dcde470835f9ffa45a8ee6697bdd511f210a8c29e0e98af2d`.

Remaining integration: durable pre-dispatch boot observation, bound host
execution and terminal recording, runtime/access activation, recovery/detach,
then normal UI acceptance. Full attachment remains open. Rollback is reverting
these unconnected source files; no live rollback or fixture cleanup is required.

Decision: **PASS for the source-only contract**. Full dashboard TypeScript check
(`npx tsc --noEmit --incremental false`) and diff check pass. Independent reviewer
Pauli found no malformed-input fail-open or cross-identity acceptance and
independently ran the combined 41 tests successfully. Live acceptance remains
unproven and is not claimed by this decision.
