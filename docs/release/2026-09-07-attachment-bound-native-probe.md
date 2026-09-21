# Bound native protocol probe

Local component PASS, based on `6f9ca10d2`. Source-only continuation of the
approved attach-agent plan; no new product route or availability publication.

The pinned activation observer now offers an internal callback while its
original journal, shared lock and unit identities are retained. It rechecks
preflight, unit, systemd properties, process and journal after that callback.
The default CLI still emits only activation/process observations.

`probe-attached-codex-native.py` pins that observer and the reviewed fixed
initialize transport. Its callback validates the private runtime directory and
mode-0600 socket, retains directory and process descriptors, checks Linux peer
PID/UID/GID against the activation's process/account, and initializes the exact
private Codex home. The socket connection uses the retained directory descriptor.
It compares process inode/starttime and namespace/socket metadata before and
after protocol work. Native descriptors survive the enclosing observer's final
checks and are revalidated before `native_protocol_available` is returned.
There is no model call, restart, repair, binding publication or lease release.

Independent review found a stale-socket window in the first implementation:
native handles originally closed before the observer's final validation. The
context-manager lifetime and a late-endpoint-change regression fix that finding.
The final independent source review found no blocking defect.

Final artifact identities:

- Native probe: `0b10410217bac283be6313fbc7b9cb5c90f6fa6f70f895ffaf4fc53f817c1be0`.
- Observer: `7ec5e67ee169d97033e2eb3cdc43e51e1153d74ff3c863ca92984811432fd0f3`.
- Linux fixture: `b4ff34e9fa8788d805950afc79d371b8918914ff3597cde3b3935f18c6203812`.

Checks:

- Five Python probe-envelope/lifetime tests and eight protocol tests pass.
- Twelve Linux observer tests pass in 21.959 seconds, using real pinned staging
  and preflight with simulated systemd. New negatives cover journal changes
  during the protocol callback and inactive-service refusal to invoke it.
- The exact new native helper passes against actual pinned Codex 0.149.1 in the
  existing offline Linux fixture: initialize/reconnect, exact peer, wrong peer
  refusal, unsafe mode refusal, directory changes during initialize and endpoint
  mode changes during the retained context. Account process and runtime-directory
  cleanup pass. This exercises the helper, not the complete observer packet with
  real systemd; those integration boundaries remain explicit.
- Activation bundle/host Jest suites: 11 tests, 2 suites, 3.236 seconds. These
  verify the updated observer pin and unchanged default action contracts.
- TypeScript no-emit check, touched-file ESLint and diff check pass.

Owned offline fixture owner `00000000-0000-4000-8000-000000001144`:
container `a8a8aeb47caebb59c171834f87351fd3b82af54f6508e1bb9be0a5f82bd1c39d`,
anonymous volume `a77fd0475925c0c59ade19d971dc66a8abfcea1c546477aabeaf9c8955ae0ada`.
It used the prior pinned Linux image, --init, --rm, no network/host mounts and
a 240-second lifetime. Container and volume were removed and verified absent.
The second protocol run reused only this exact already-staged owned fixture;
it did not rerun/reset an installer or activation journal.

No live target, migration, service-role privilege or deployment changed. No new
spending; conservative cumulative Hetzner reservation stays GBP 6.90/10. Existing
computers and user data were not touched. Rollback restores the default observer
and its matching bundle pin together and removes the unused probe. No live
rollback was required. Host payload/result transport, durable native observation,
binding lifecycle, full systemd/UI acceptance and useful work remain open.
