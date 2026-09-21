# Streaming mode session binding

Status: source-complete control-plane prerequisite; not a native stream launch or live acceptance.

Remote-desktop session issue now binds the user's exact `hq` or `performance`
choice in the same serialized database transaction that owns the controller
lease. Existing session rows remain HQ-first through a constrained database
default. The API rejects any third mode, and the server withholds the one-time
handoff secret unless the database receipt confirms the requested mode.

The session endpoint also preserves the UUID of an already prepared native
profile, but only for an exact daily-driver Sunshine/Moonlight controller
request. Browser, viewer, recovery, and non-Moonlight requests cannot propose
their own identifier and continue to receive a server-generated UUID. This
lets the isolated Mac profile and the later guest guardian grant refer to the
same session without widening browser authority.

The browser sends its persisted HQ-first choice when it opens a session while
retaining live, no-reconnect profile switching for the existing Selkies lane.
This stored field is the future activation authority for native Sunshine and
Windows transports; it does not enable either transport by itself.

Verification:

- focused API, broker, browser, and migration suites: 70 passed
- real PGlite session contract: 89 checks passed, including HQ default,
  Performance persistence, and invalid-mode rejection
- dashboard TypeScript typecheck: passed
- focused native UUID broker and endpoint assertions: 46 passed

Remaining gates:

- the Mac/browser native handoff does not yet issue and activate the stored
  session against the dormant Omarchy guardian
- no Windows native daily-driver adapter consumes this contract yet
- direct UDP, input, audio, reconnect, revocation, and latency acceptance remain
  blocked until the approved network path is available
- this source revision has not been deployed or accepted on Canary
