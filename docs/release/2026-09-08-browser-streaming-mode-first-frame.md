# Browser streaming mode first-frame binding

Status: source-complete; Canary guest refresh and live media acceptance pending.

The Ubuntu/Selkies browser lane now carries the exact HQ or Performance choice
in the one-use parent-to-broker handoff before the Selkies document is opened.
The broker applies the selected frame rate and bitrate as soon as that document
loads, instead of always beginning in HQ and changing Performance only after the
stream reports connected. HQ remains the default at 1080p-first, 60 fps and 25
Mbps; Performance remains 720p-first, 60 fps and 12 Mbps.

The handoff protocol is now `hivra.remote-desktop.handoff.v2`. It accepts only
the exact five-field message from the expected control origin and parent window,
including `streamingMode: hq | performance`. Legacy, unknown-mode and
extra-field messages are ignored. The dashboard also requires the session issue
receipt to return the same mode it requested. A valid session identity with a
mismatched receipt is explicitly revoked before the UI fails closed, so the
invalid handoff cannot leave a controller lease behind.

Verification:

- generated broker contract: 18/18 tests passed
- dashboard component and public-readiness contract: 44/44 tests passed
- real Chromium nested-frame handoff and teardown harness: passed both scenarios
- full dashboard TypeScript check: passed
- focused ESLint and JavaScript syntax checks: passed

No Canary deployment, guest update, provider mutation, firewall change or live
stream occurred in this source milestone. Existing guests publishing the v1
broker contract will intentionally fail the current readiness check until their
owned desktop runtime is refreshed. Live acceptance still needs the updated
broker on a Canary Ubuntu guest and direct checks of first-frame mode, image
clarity, input latency, audio, reconnect and teardown.
