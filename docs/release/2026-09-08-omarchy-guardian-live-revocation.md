# Omarchy guardian live revocation

Status: source stop path complete; live guest acceptance pending.

The running Omarchy guardian retains the preparation mutation lock for the
whole Sunshine process lifetime. The prior revoke command attempted to acquire
that same lock, so a valid stop request could fail with
`ownership_operation_busy` while the desktop was active.

Revocation no longer takes the lifecycle lock. It proves the exact preparation,
lease, computer, session, consumed grant, active systemd invocation and guest
boot before writing. The one-time marker is created relative to an already
opened session-directory file descriptor, then all path and record identities
are proved unchanged after the durable write. A replacement or changed marker
is held rather than adopted.

The focused regression deliberately holds the same mutation lock used by the
active lifecycle while issuing two identical revoke requests. The first writes
the exact marker and the second proves idempotency.

The owner-facing stop coordinator now reloads the immutable grant saved before
activation, requests revocation, polls only the read-only stop observer, releases
the exact guest claim, and then revokes the database session. The Mac UI stops
only its recorded Moonlight PID. A lost final response re-proves the retained
released records rather than rebuilding or replaying authority.

Remaining gate: prove the full path against the prepared Omarchy guest, including
the actual Moonlight process, Sunshine process, systemd cgroup, listeners and
input authority.
