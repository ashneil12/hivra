# Self-host command argument guard — 2026-09-06

## Cause and scope

The self-host CLI parsed every `--name value` into an options object and silently
ignored names the selected command did not consume. Duplicate options used the
last value. Consequently a typo such as `--state_dir` could leave a lifecycle
command using its default installation instead of the operator's intended one.
The regression reproduced parser acceptance, not a destructive operation against
an actual installation.

The entry parser now validates the command-specific option set and rejects
duplicates before prerequisite or lifecycle dispatch. Errors list supported
names without echoing unknown arguments or supplied values. The native client's
uniform `doctor --state-dir` invocation remains compatible. There is no change
to backup encryption, migration execution, state identity, confirmation tokens,
provider resources, or defaults when no state directory is explicitly supplied.

## Evidence and decision

PASS for the scoped CLI guard:

- Three new baseline tests failed: unknown/inappropriate options were accepted,
  duplicate destinations overwrote each other, and error text echoed supplied
  positional text. Supported-argument baseline passed.
- Final self-host/backup/recovery/bootstrap regression selection: 45 passing.
  The CLI subprocess test executes the actual entrypoint with a misspelled
  doctor option, empty PATH and a three-second bound; it exits 1 with no
  prerequisite output and no supplied-value echo.
- Independent reviewer passed all 33 self-host tests, checked every current
  option consumer and the Mac caller, and found no actionable P1/P2.
- Fresh actual `self-host:doctor` passed Node 22.23.1, installed dependencies,
  Docker daemon 29.1.3, pinned Supabase CLI 2.116.0, configuration and seed.
- Mac `swift test`: 24 passing, including local command construction and
  installation-state binding. Source syntax and diff whitespace passed.

No new full bootstrap/restore rehearsal was run or claimed. Existing acceptance
records distinguish those broader workflows; argument rejection does not prove
them again. The selected change is local CLI source, so a Vercel deployment or
guest rollout is neither necessary nor claimed. No desktop binary was released.

Tests use synthetic arguments and owned temporary files with their existing
cleanup. No installation lifecycle command, new provider resource, credential
rotation, account mutation or additional spend occurred. Ordinary source revert
is the rollback; it was not exercised. Commit this receipt with the exact guard
and tests so the gate remains revision-bound.
