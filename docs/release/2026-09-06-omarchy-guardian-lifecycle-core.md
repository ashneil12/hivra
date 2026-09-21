# Omarchy guardian lifecycle core

Status: PASS for the internal lifecycle component: final 14-test run and
independent corrected review passed. This is not native desktop or live systemd
guardian acceptance.

## Implemented boundary

The existing `omarchy-native-supervisor.py` now contains an internal
`supervise_lease()` lifecycle, not a new activation command. CLI remains
`prepare|observe`; no unit installer, broker route, release observer, capability
publication or Mac launch wiring is added.

The grant is bound to computer/VM/Unix owner and original preparation, account
owner, capability generation/revision, session/lease/client IDs, the exact
validated non-CA client certificate, guest boot ID, absolute CLOCK_BOOTTIME
deadline and expected source/runtime/preparation/unit hashes. The deadline is
bounded to 240 seconds. This is structural and runtime binding, not a replacement
for the future native broker's authorization or fresh capability admission.

Before spawn, the core verifies preparation and expected source hashes, checks
its context, records an exclusive active claim and durable consumed grant,
creates separate session state, rechecks the original resources, and refuses
revoked, expired, rebooted or changed input. It executes the original checked
Sunshine file descriptor as the unprivileged service user, in a separate process
group but the same systemd cgroup. The descriptor avoids executing a replacement
path after the original binary identity check.

Pairing authority is root-owned and read-only to Sunshine; writable home/logs
are separate. The initial record contains only the granted public client
certificate. The loop checks both the file and the actual in-memory named-client
list over the administrator API, with the prepared server certificate's exact
DER pin. No password is placed in URLs, arguments or receipts.

Expiry, revocation, observation failure or pairing drift stops the owned child.
The active claim is retained and output always says `releasePending: true` and
`desktopReady: false`. This method never releases controller ownership, adopts
old state or deletes an unexplained pairing. A later lease is held until the
separate release observer proves the original invocation/cgroup/listeners ended.

## Systemd context versus systemd acceptance

The default context checker verifies the root-owned unit hash, original
invocation, guardian PID, cgroup, active service properties, no drop-ins/reload,
`Restart=no`, cgroup killing, hard kill signal, `NoNewPrivileges=yes`, no
notification-based timeout extension and no randomized runtime extension.
It bounds RuntimeMax against `ActiveEnterTimestampMonotonic`, matching
[systemd v257's service timer calculation](https://github.com/systemd/systemd/blob/v257/src/core/service.c).
Minute/composite duration output is supported and unbounded/unknown values refuse.

Read-only node-b inspection confirmed the property names and serialization
(`RuntimeRandomizedExtraUSec=0`, numeric active-enter timestamp, etc.) on an
existing service. No host unit was installed, reloaded or started. This is not
an Omarchy guardian or effective owned-unit acceptance check.

The actual-engine tests **explicitly substitute the systemd context checker**
inside a network-none disposable container. The source-property checks use
fixtures. Neither establishes real systemd termination on guardian hang/death,
VM suspend/reboot, deadline backstop enforcement or cgroup release. These remain
required before adding an activation entrypoint or enabling native launch.

## Regression and runtime observations

The pinned official Sunshine binary and test image are those in
[the administrator runtime receipt](2026-09-06-omarchy-administration-runtime.md).
Actual engine tests authenticate the granted client against `/applist`, not
just an HTTP health endpoint. They exercise:

- Absolute deadline expiry, including an observation timing out at the deadline.
- Revocation, retained claims, replay refusal and next-lease hold.
- Unexpected file pairing changes without deleting the foreign record.
- Actual in-memory client disable through Sunshine's API while its read-only
  pairing file remains unchanged; the guardian detects it and stops the process.
- Service UID can read but cannot overwrite or replace pairing authority.
- Pre-spawn revocation, pairing drift and source change: no child dispatch.
- Expired/rebooted grants: no claim or child.
- Default context without an installed unit: refusal before consumption.
- Systemd property/time-format fixtures, including active-enter timing,
  randomized extension and notify-based extension refusals.

Review reproduced two startup gaps in the initial implementation: a revocation
published during the last context check still allowed a brief spawn, and the
initial pairing file was service-UID writable. Those are corrected and covered
by no-spawn/UID tests. Review also found the wrong systemd timer base; the
corrected check uses active-enter time and rejects extensions.

The final review also reproduced a changed state-directory mode allowing
replacement of an otherwise root-owned read-only pairing file. The guardian now
captures and rechecks that directory's original owner/mode/identity before spawn
and during supervision. A regression changes it to service-writable mode during
the final context check and verifies no child is dispatched; the changed resource
and held claim are preserved, not silently repaired.

A deterministic deadline regression failed with
`guardian_pairing_observation_failed` when a bounded observation exhausted the
lease. The corrected handler classifies that case as expiry and stops the child;
it does not retry or extend the deadline. Earlier observation failures still hold.

## Repeatable command

```sh
docker run --rm --name hivra-guardian-lifecycle-check \
  --platform linux/amd64 --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev -e PYTHONDONTWRITEBYTECODE=1 \
  --mount type=bind,source=/Users/example/Projects/Hermesdeploy-canary,target=/work,readonly \
  sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763 \
  /work/dashboard/runtime-adapters/omarchy-native/guardian-lifecycle.test.py
```

Final lifecycle suite: 14 passed in 36.577 seconds (exec session 64394), using the
actual pinned Sunshine process with the systemd context explicitly substituted.
Linux preparation/certificate regressions: 18 passed. macOS: 11 passed, seven
explicitly skipped. `git diff --check` passed. Docker inventory after the final
run contains no guardian/Sunshine test containers; unrelated containers were
untouched. Independent reviewer `core_gap_map` reran the final state-directory
regression: mode drift refused, no child dispatched, active claim retained.
The reviewer reported no remaining actionable P1/P2 in this component scope,
passed its diff check and removed its test container. Its earlier independent
13-test suite also passed before the final directory-identity correction.

No VM, provider resource, firewall, route, customer data or Canary deployment
changed. No additional spend; conservative Hetzner reservation remains £6.90/£10.
Only test-owned temporary namespaces/processes are used. Source rollback is a
branch/PR revert; no live rollback is needed.

Next work is the exact unit recipe and native admission/dispatch/release
integration, followed by real guest/backstop and native Mac acceptance. Do not
interpret these component checks as full Omarchy launch, streaming/input/audio,
controller release, or completion of the wider core-experience goal.
