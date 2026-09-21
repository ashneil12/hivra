# Native transport: actual pinned Linux compatibility

PASS for this isolated local compatibility check, based on `36da79f03`.
The exact transport module SHA-256 is
`60cef5e61a6445410915bac17e78cb36f0784584ac4d81d483757b3560142569`.

The new `dashboard/scripts/test-attached-codex-protocol-linux.py` uses the
existing private staging fixture and pinned Codex 0.149.1 x86_64 archive
`e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278`.
It starts the real binary directly as the dedicated unprivileged UID/GID,
using the service-equivalent private HOME/CODEX_HOME and restrictive umask.
The new transport performs two successful WebSocket initialize exchanges.
Linux SO_PEERCRED matches the owned child PID/UID/GID; the socket remains
mode 0600 with unchanged identity; the actual child remains alive across both
connections. No authentication or model request is sent.

Exact execution: `/usr/bin/python3 -I -B -S /tmp/test-attached-codex-protocol-linux.py`
inside the owned offline Linux amd64 Docker fixture. Image:
`sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763`.
Final run exit 0:

```
PASS pinned Codex 0.149.1: exact peer, private socket, initialize and reconnect
PASS owned account processes and runtime directory released
```

Earlier failed checks are retained as context, not counted as passes:

- Docker amd64 emulation returned ENOSYS for pidfd_open. The test now uses
  Popen.poll for its own child, which checks that exact child through waitpid.
  This is not a production process-identity implementation.
- The first direct launch omitted creating CODEX_HOME. The fixture now matches
  the actual service's private mkdir step before starting Codex.
- The first successful protocol run failed cleanup because PID1 was sleep and
  retained an orphan zombie git process. That entire fixture was removed. A
  fresh `--init` container reaps orphans and passed the unchanged empty-account
  process assertion. No failure was bypassed or converted into success.
- Independent review identified a poll/signal exit race. The fixture catches
  ProcessLookupError when signaling its owned group. Final scoped review found
  no blocker.

Resource owner: `00000000-0000-4000-8000-000000001144`. Both containers used
`--rm --network none --user 0 --platform linux/amd64`, no host mounts or
privileged mode, and bounded sleep lifetimes (240/180 seconds). The final
container also used `--init`.

Removed and verified absent:

- First container `4b12541dd9a636358d53a89ba79041ab1176c344e71e6d090bfd7f3bca06eab6`
  and anonymous volume `32d3745e9aafb24ad0fef4fd13ba893f110a12c9c1cc3a8ecdb62f2322486c00`.
- Final container `7353f2deda76ec83eebc731f0e8b12bfa32048c7df24ffd3ee214749dbf56a9a`
  and anonymous volume `436d8fc41774ba651fcf5823c9db26ba278febff95c9fdaa71051839a45dbb59`.

The prior eight parser tests and diff check also pass. No existing computers,
sessions, credentials or user data were touched. No new expenditure; the
conservative cumulative Hetzner reservation remains GBP 6.90 of GBP 10.

This checks real binary compatibility, not systemd supervision, a deployed
guest readiness observer, DB authority, browser attachment or useful model work.
No migration/deployment occurred. Those integration gates remain open. Rollback
is removal of the test-only harness; no live rollback is needed.
