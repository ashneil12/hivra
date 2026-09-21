# Owner relationship read API — 2026-09-06

Source-only milestone on `codex/hivra-core-experience-plan`, baseline `cc078f88a`.
Endpoint: `GET /api/hivra/computers/[id]/relationships`.

The route uses the existing Hivra server gate and server authentication. It
passes only the authenticated owner and validated canonical UUID to the committed
reader. Request owner fields and legacy aliases do not change that scope. An
authenticated rate limit precedes storage, and every response is `no-store`.
Unknown/foreign computers are 404; storage and authentication exceptions produce
a generic 503 with a safe failure category, without raw diagnostic disclosure.
There is no mutation handler, guest dispatch, inventory switch or UI consumer.

Verification from `dashboard/`:

```sh
npm test -- --runInBand --runTestsByPath src/lib/agent-computers/__tests__/relationship-route.test.ts src/lib/agent-computers/__tests__/relationship-reader.test.ts
npx eslint 'src/app/api/hivra/computers/[id]/relationships/route.ts' src/lib/agent-computers/__tests__/relationship-route.test.ts
npx tsc --noEmit
```

Two suites / ten tests pass; lint, TypeScript and diff checks pass. Before
implementation the route suite failed because the route did not exist. Route
tests execute the handler with mocked authentication, reader and rate limiter;
the separate reader suite executes actual migration SQL in isolated PGlite.
These checks do not prove deployed authentication or browser acceptance.
Independent reviewer Pauli inspected the route and reran both suites (ten
passing tests), returning scoped GREEN with no actionable finding. The existing
rate limiter is per-process user/IP protection, not a distributed quota.

No deployment or live migration was performed: canonical cutover and shared
guest lifecycle commands remain incomplete. No retained resources, model
credentials, provider capacity or spend were changed. Fixtures close after
testing. A reviewed source revert is the rollback path; no live rollback was
needed or exercised. The full core goal and attachment acceptance remain open.
