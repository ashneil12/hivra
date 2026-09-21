# Read-only guest activation preflight — 2026-09-06

Source-only continuation after `5a90657e4`. The guest checks now verify actual
installation state before a future service-start worker may proceed. This is
unimplemented target behavior, not a reproduced production incident. There is
no service start, database permission change, live migration or deployment.

`preflight-attached-codex-activation.py` accepts a bounded request with the
exact pinned staging verifier/observer bytes. It validates the activation
identity, generation, service policy and current boot, checks the saved guest
staging journal read-only under its existing lock, then checks passwd/group
identity, nologin shell, absence of supplementary group grants, private home,
installation directory, root-owned receipt and full pinned binary digest.
Directory traversal uses no-follow descriptors. File reads reject links,
unexpected ownership/modes, oversize and metadata changes. The installation
namespace, home, account/group, original file metadata and exact journal are
rechecked after hashing. A fixed read-only Python child checks kernel access to
the home and executable under the exact service UID/GID with no supplementary
groups. Refusal never repairs the supplied state.

The guest independently renders the fixed service policy, rather than trusting
caller unit text or a supplied digest. A cross-contract test proves its complete
definition matches the existing TypeScript builder and actual SQL fixture digest.
Success reports `preflight_verified`, not ready, running or authorized. It neither
creates directories nor starts Codex/services; its only child is the fixed
five-second kernel-access probe. A future bound worker
must retain its fence and recheck ownership through service installation/start;
this observation is not an execution grant or permission to release a lease.

## Verification

An initial owned root Linux amd64 Docker fixture, network disabled, used locally
cached pinned Codex 0.149.1 bytes and the actual stager. Six preliminary tests
passed in **4.069s**:
read-only success on real installed bytes; invalid request/boot/policy rejection;
account and supplementary-group drift; unsafe modes and symlinks preserved;
actual binary-byte corruption refused without repair; and a busy staging journal
remaining held. Tests explicitly prohibit write/create/truncate os.open flags,
mkdir and subprocess execution during that initial version of preflight.

That first test run emitted a ResourceWarning for an unclosed one-byte read in
the test harness. That test-only read now uses a context manager; the worker
already used managed descriptors. Python syntax checks passed. Two focused Jest
suites passed nine tests in **2.123s**, including actual SQL request data and
byte-for-byte Python/TypeScript service rendering. Changed-file lint, full
TypeScript and diff checks passed.

Independent review then found two defects in the uncommitted preflight: checked
home/account/receipt/journal state could change during binary hashing; and root
directory access did not prove the service user could traverse its ancestors.
The mutable-home-after-hash regression failed against the original worker with
`ValueError not raised`. The worker now retains original descriptors/metadata
and checks them plus account and journal again before success. The fixed child
checks home RWX and executable RX through the kernel under the service IDs;
it performs no filesystem write and never executes the agent binary.

Final Linux run: **nine tests passed in 4.121s**, including changed home,
receipt/journal after hashing and root-owned 0700 ancestors inaccessible to the
service account. The initial descriptor guard rejected Python subprocess's
`/dev/null` output sink; it now permits only that exact path with O_RDWR. All
other write/create/truncate flags remain rejected, and the test checks the
single fixed probe's interpreter and user/group arguments. The owned staged
fixture was reused only for assertions; its installer/journal was not reset or
redispatched. Final independent review confirmed both original defects were
resolved and requested `-S` on the fixed child to disable system site hooks.
That flag and its exact-argument assertion were added; the nine-test Linux run
above preceded this flag-only tightening. The fixed child requires only os/sys.
The `-I -B -S` standard-library import and Python syntax smoke passed locally.
Final worker SHA-256:
`779c3041fffcae1802559ddf48b5f2a55759805773812121991f1033e2d67781`.
Final independent review is scoped GREEN: both P2s and the site-hook issue
resolved, source hash/import smoke/diff verified, and nine renderer/parser tests
independently passed. The reviewer did not rerun the Linux/live campaign.

Fixture owner: `00000000-0000-4000-8000-000000001071`. Container
`96ad753668202362c6e5827e14bf3da442d8b3ddc348fe5c99e931b5a6ac882e` used pinned
image `sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763`,
with a 240-second automatic lifetime. It was explicitly stopped; subsequent
owner-filter and exact volume-name checks were empty. Its anonymous volume
`93c9b7b48ee0666d2e249aa04d88066a4a1fb4587b65a772ebc327890827f288` was removed
by Docker's owned-container cleanup. Guest test data was discarded; the local
pinned archive is retained. No live VM or retained computer was touched, no
model work was requested, and no Hetzner or other spend was added.

The regression fixture used owner `00000000-0000-4000-8000-000000001072`, same
pinned image/network policy and 240-second lifetime, container
`6156e0fe0b6788682ccb48382dfeff071e34f262f600b4e680f0493fc78416f3`, anonymous
volume `e9acca2ca74913545e8d99a14e27c1fb0d014ea24fad9dd30c019eef2d8fe515`.
It was explicitly stopped after the final passing run. Subsequent owner-filter
and exact volume-name checks were empty; no owned fixture remains active.

## Limits

No systemd worker, service collision check, socket/protocol readiness, durable
activation journal, timeout cleanup, detach, reboot/recovery or browser attach
path is implemented by this preflight. Its access() probe is not an actual file
write, systemd-sandbox execution or containment proof against a root
administrator. The earlier real
Ubuntu systemd campaign remains separate evidence; it did not run this new
preflight. The full attachment and core-experience goals remain open.
