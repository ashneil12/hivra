# Attachment native protocol transport

Scope: source-only continuation of the approved attachment plan on
`codex/hivra-core-experience-plan`, based on `6742b0cd4`. This implements a missing
internal transport component, not a reproduced Canary incident or a ready agent.

`dashboard/provisioner/attached-codex-protocol.py` sends only the fixed Codex
`initialize` request on a caller-authenticated connected socket. It checks the
WebSocket upgrade and expected `codexHome`, rejects invalid/duplicate JSON,
wrong request IDs and errors, masks client frames, and bounds header/frame sizes,
control traffic and all I/O against one monotonic deadline. It makes no model
request and returns no server content or readiness state. Unsupported fragmented
responses fail closed rather than being partially accepted.

Verification: the focused Python test initially failed because the new module
did not exist. After implementation, all eight tests passed with partial-read
simulated connections, full initialize success/failure, request inspection,
invalid frame/upgrade cases, control-flood refusal and expired-deadline refusal.
`git diff --check` passed. Independent source review found no blocking defect;
its initial full-exchange coverage suggestion was addressed by the final two tests.

Local component status: PASS, bounded to the transport contract. No guest
observer/bundle/host caller uses this module yet. Peer credentials, private socket
pathname ownership, activation continuity, native binary compatibility for this
exact new implementation, DB persistence and public user-flow acceptance remain
integration gates. Prior native binary tests are not acceptance for this module.

No migration, Canary deployment, service start, VM mutation, credential use,
model invocation or new expenditure occurred. No temporary processes or external
resources were created. Rollback is removal of this unused module and its test;
no live rollback was needed. The overall attachment and platform gates stay open.
