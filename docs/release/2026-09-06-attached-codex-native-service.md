# Attached Codex native service groundwork — 2026-09-06

Source continuation from `c5c7d2685`. No service installed/enabled, migration
applied, Canary deployment, retained-computer change or additional spending.

The service-definition builder accepts only a matching pinned staged receipt.
It derives one installation-specific unit, account, home, executable and short
private `/run` Unix socket path. The definition creates an absent `.codex`
directory as the unprivileged account under umask 0077 and rejects an existing
symlink; it does not overwrite configuration. ExecStart uses an empty environment
with only fixed HOME/CODEX_HOME/PATH, disables analytics, and invokes the pinned
binary. It specifies no capabilities, no new privileges, protected system/home
paths, an explicit writable agent home plus private runtime/tmp locations,
whole-control-group stop and no automatic restart. It writes no unit or files.

An activation worker must still revalidate current account IDs, file identity,
ownership and digest, and win durable activation authority before installing or
starting this definition. Unit generation is not service readiness or release.

## Executed native check and findings

The actual Codex 0.149.1 x86_64 binary was staged in a network-disabled Linux
container and started directly with runuser as UID/GID 999, not through systemd.
Its Unix socket lived under the private agent home, not the proposed `/run`
directory. Two separate WebSocket connections initialized against the same
server; socket owner was UID 999 and mode 0600. Both replies contained
codexHome/platformFamily/platformOs/userAgent. After terminating the owned
process group, the `/proc` inventory contained no processes for that account.
No prompt, model call, paid inference or account authentication was performed.

Earlier failed probes are not runtime acceptance: newline JSON was rejected or
timed out because this transport requires a WebSocket HTTP upgrade and frames.
The native proxy also forwards that framing; it is not a JSONL converter. This
was confirmed against the [official app-server protocol documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
and then the pinned runtime. A prior suggestion that rejection proved a UID
restriction was incorrect; the test did not establish that restriction.
A stopped process left its socket path behind. A 116-byte test path was also
discarded (that attempt's startup error was not captured). Short unique fixture
paths preserve stale entries until disposable-container teardown.

The fresh fixture exposed a concrete startup requirement: explicitly setting
CODEX_HOME to a nonexistent directory makes Codex refuse startup. Captured stderr
reported that exact condition. Creating it as the private account, as now
specified by ExecStartPre, allowed initialization and reconnect. This was a
source/setup correction, not a claim that an existing live service was broken.

Three focused definition/receipt suites: **44 tests PASS, 0.340s**. Scoped lint
and full TypeScript pass (the final subsequent edit changed only the ExecStart
string and its assertion; focused tests/lint were repeated). The fixture uses a
minimal bounded test-only WebSocket client, not a production access gateway.
Systemd syntax/runtime, sandbox behavior, restart, cgroup-descendant cleanup,
UI authentication, useful model work and live detach remain unverified.

## Exact fixtures and cleanup

Both used the existing image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
Linux amd64 emulation, network none, no host mounts/ports, 512 MiB, one CPU,
64 PID limit. The staged fixture operation was
`00000000-0000-4000-8000-000000001060`, installation
`00000000-0000-4000-8000-000000001004`; IDs repeated only in separate disposable
containers and were never sent to a control plane.

- Initial container `70c3e2e29821dc53a163b38f212293f4642576a744c43abeffce45f1a7d1c075`, owner `00000000-0000-4000-8000-000000001060`, 240-second deadline; volume `12ccc1b290fb536493f2533c357cb6552015349be614569f66b4f5a749d25b08`.
- Corrected fixture `b70dd33906a8613ed9998e39e05277fa69aeaa300cc082e62090f9bfc8b35202`, owner `00000000-0000-4000-8000-000000001061`, 180-second deadline; volume `d9b79d6480539db1a96269888351bf4ee76ff8869986ce58e21a5526ae2252d6`.

Labels/mounts were inspected. Both containers expired and auto-removed before
explicit stop; subsequent owner-filtered container and exact-volume inventories
were empty. No owned runtime or test resource remains. Rollback is a source
revert before deployment; no live rollback was needed.

Independent scoped review: GREEN, no concrete P1/P2 findings, including final
env -i invocation. Reviewer passed 44 definition/result/receipt tests, repeated
the final definition checks, and checked Python AST syntax and diff. No container
was independently repeated. Scoped source/protocol milestone: PASS; no systemd
or live acceptance implied. An active/Type=exec unit alone is not readiness;
the eventual worker must inspect the effective unit and native protocol too.

Source SHA-256: service definition
`66f89162530b682aa66d8a59250f385530726a162def8902ffb7bc953eee9428`;
native test `1220a9bb0eb55f4965ce0a67ce562ec672ef40f8d98b6f745eb103891718a831`.
