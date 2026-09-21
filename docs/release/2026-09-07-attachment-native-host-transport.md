# Native probe host transport

Source-only continuation based on `1977c5ae4`; no deployment or DB grants.

The pure native bundle builder wraps the existing validated activation-observer
packet with the exact pinned native probe and fixed protocol module. It caps
asset bytes and the complete packet, rejecting changed or oversized assets.
The result parser accepts only `native_protocol_available`, then reuses the
strict activation identity contract with required PID, exact operation,
activation, installation, boot and service definition. Generic process state,
ready claims and unrelated evidence are refused.

The existing host adapter adds one fixed `native` observation action using its
same source/owner validation, enforced binding tag, VMID/IP checks, shared host
allocation lock and QGA-only execution. Guest/host budgets are 90 seconds and
170 seconds, with a 32 KiB output cap; the protocol exchange itself has its
existing five-second budget. No arbitrary RPC, IP-based SSH fallback, start
authorization, lease release or readiness publication is introduced. Pending
deletion can be diagnosed but this grants no new work or binding.

Verification:

- The new test failed first with the missing module. After implementation,
  24 tests in 3 suites passed in 4.458 seconds: native bundle/result, activation
  host and existing activation coordinator.
- Actual PostgreSQL fixture records feed the bundle and parser tests; Python
  loads and verifies the nested exact guest dependencies. No SQL is migrated.
- Bash syntax and generated VMID/tag/QGA/lock checks pass. Host execution is
  mocked: this is not an actual QGA invocation or live deployment check.
- TypeScript no-emit, touched-file ESLint and diff checks pass.
- Independent source review found no blocking defect and separately passed
  both affected Jest suites (13 tests). Local component status: PASS within
  the source/mocked-transport scope above, not a deployed workflow verdict.

Artifact SHA-256:

- Bundle/parser `cee3ce273f1ae60adfcc1bdb75c80f61498c3accc897bf4bbf53f719937e45e9`.
- Host adapter `74c93af1e1672c5f4219bc75711cb0d96ffdd6ed7cbca4d80d28b381d652963b`.

No temporary resources, live changes or spending in this slice. Prior local
Linux fixtures are removed; conservative cumulative Hetzner reservation remains
GBP 6.90 of GBP 10. Existing computers and user data were untouched. Rollback
removes the unused native action/builder/parser together; no live rollback is
needed. Durable native-result persistence, caller registration, binding and
detach/recovery semantics, real-systemd/QGA and normal UI acceptance remain open.
