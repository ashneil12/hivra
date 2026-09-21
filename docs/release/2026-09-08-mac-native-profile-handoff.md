# Mac native profile handoff

Status: source-complete native launch path; not live network or streaming acceptance.

The Mac Alpha now registers one fixed WebKit reply handler. It accepts only an exact profile request from the main frame of the configured Hivra origin. The request may choose only HQ or Performance; HQ remains the default. The webpage cannot choose a command, executable, host, path, certificate identity or private key. The app generates the client identity itself and returns only the public certificate, its fingerprint, the client ID and exact mode.

The dashboard has a caller for that bridge. It binds the app's
returned HQ or Performance mode and profile UUID to one native Sunshine session
and carries an explicitly selected direct or relay UDP path. The Omarchy desktop
UI now passes its visible HQ or Performance choice into that exact profile and
offers one native-open action only inside the Mac app. Invalid replies,
failed issue responses, and uncertain issue transport trigger both owner-session
revocation and an exact app profile discard. Either uncertain cleanup remains
visibly release-pending.

The issue request now carries that profile's public certificate, client UUID,
and DER SHA-256. The server parses the certificate, rejects CA, private-key,
mismatched, unsigned, not-yet-valid, or expired material, then the v3 database
authority binds the verified public identity atomically with the exact Sunshine
session. The private key remains in the Mac-owned isolated profile and is never
sent to the dashboard or database.

The dashboard handoff can consume its one-time PKCE exchange and call the
owner-only Omarchy activation coordinator. It validates the exchanged computer,
transport, controller role, token shape, activation identity, and the unchanged
HQ or Performance mode. If exchange or dispatch acknowledgement is uncertain,
it retains both the session and Mac profile instead of deleting the only client
key that may belong to a running guest. The Omarchy desktop UI calls this flow
only when it detects the app-owned native bridge.

After readiness is proven, the app binds that isolated client identity once to
the exact server certificate and private IPv4. It validates the certificate
fingerprint locally, then launches only the fixed signed Moonlight executable
from `/Applications/Moonlight.app`. The webpage cannot supply executable paths,
arguments, environment variables, application names, or arbitrary hosts. The
app selects fixed 1080p/60 HQ or 720p/60 Performance arguments and uses the
isolated profile directory as Moonlight's portable working directory.

The activation coordinator now waits on a bounded read-only guest observer after
the one-use activation. A successful response carries the exact pinned public
Sunshine server certificate, server/computer ID, guest boot ID and private IPv4
only after the paired lease and active guardian process are re-proven. The
browser caller rejects changed identity, public/non-private routing, malformed
certificate material, or a response that still says the desktop is not ready.

The same main-frame origin may send one exact discard request. The app removes
only the profile whose original directory identity still matches; replacement
state is held rather than deleted.

The UI also exposes an exact Stop action after a successful native launch. The
app accepts only the recorded session and Moonlight process identifier, asks
that process to terminate, and removes its isolated profile. Independently, the
owner-only server coordinator reloads the immutable pre-dispatch guardian grant,
requests guest revocation, observes the original process boundary and listeners
stopped, releases the guest controller claim, and only then revokes the database
session. Lost final responses can re-prove an already released lease without
creating a new authority.

Outstanding unlaunched profiles are capped at four. The bridge retains them for the owning browser lifetime and cleanup verifies the original directory device/inode before deletion; a replaced directory is preserved and reported as a hold.

Verification:

- 33 Mac tests passed, including exact request/origin parsing, HQ-first mode order, both fixed launch plans, one-time server binding and replacement-safe cleanup
- focused dashboard UI, caller, stop-coordinator and route tests passed, including explicit mode binding, public-certificate validation, strict reply parsing, no native Windows offer, and confirmed/uncertain cleanup
- the PostgreSQL/WASM session contract passed 110 checks, including immutable guardian-grant persistence and browser-role denial
- the Mac debug build passed as part of the test run

Remaining gates:

- the installed Moonlight bundle identity and Developer ID were inspected, but the app process was not launched against a live guest
- no direct UDP, input, audio, reconnect, live revocation or latency acceptance
- relay is deliberately refused before session creation until an authenticated relay path exists
- Windows remains on its browser recovery console; this native source path is Omarchy-only
