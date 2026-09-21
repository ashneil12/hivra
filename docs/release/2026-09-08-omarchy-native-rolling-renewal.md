# Omarchy native rolling renewal

Status: source-complete control-plane lifecycle; live guest and stream acceptance pending.

The Omarchy native handoff now renews the same running Sunshine guardian instead
of replacing its process when the initial short lease approaches expiry. Each
renewal is owner-, session-, activation-, capability-, guest-boot-, and sequence-
bound. The database records authority before dispatch, the guest applies only the
next exact renewal, and the control plane reports success only after a read-only
observation proves that the running guardian consumed it.

The guardian remains fail-closed. Its systemd unit uses `Type=notify` with a
short `RuntimeMaxSec` backstop and repeatedly reports the exact remaining
monotonic deadline. A renewal cannot extend beyond five minutes at once or beyond
the original twelve-hour continuous-session ceiling. Explicitly stopping the
desktop still revokes the exact controller and kills the Sunshine cgroup.

The browser keeps one renewal ID across uncertain retries, so a lost response
cannot create a second lease or launch another Sunshine process. A successful
renewal updates the next deadline; an unproven renewal leaves the previous guest
deadline authoritative and tells the user that Moonlight will close safely.
Before any renewal, the app also proves that the exact local Moonlight PID is
still running. The browser checks that local state every five seconds and
automatically releases the server controller when the user quits Moonlight,
preventing a dead client from keeping Sunshine alive through rolling renewals.
The HQ or Performance selector is locked while that native process is active,
so the displayed mode cannot drift from the settings bound into Moonlight.

Verification:

- focused guardian, broker, API, handoff, and component suites: 92 passed
- real PGlite remote-desktop session contract: 118 checks passed
- portable Python guardian suites: 32 tests run, 7 Linux-only checks skipped
- dashboard TypeScript typecheck and focused ESLint: passed

Remaining gates:

- run the Linux-root systemd lifecycle checks on a prepared Omarchy guest
- prove at least two renewals preserve the same Sunshine PID and Moonlight stream
- verify input, audio, reconnect, stop, latency, and direct or authenticated-relay transport
- deploy the database and application revision to Canary before calling this shipped
