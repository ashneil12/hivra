# Provider Ubuntu workspace access repair

Status: corrected .05.10 immutable release and workspace integration deployed
to Canary source6c233db13683d202407db731e637771b9156fd12. Fresh owned computer
00000000-0000-4000-8000-000000001178 passed desktop input, Files read/save and
actual non-root Box Terminal commands. Files expiry preserved its unsaved draft;
reconnect/save and desktop readback passed. The fixture and all five original
provider resources were removed at22:51:47.789754UTC. Remaining checks and
visual limits are recorded below; this is not full platform completion.
Earlier entries are chronological, not current deployment status.

## Observed failure

On Canary source24713d052, the disposable .05.8 provider Ubuntu computer passed
desktop input, reconnect, restart and stop/start persistence. Files returned
unauthorized; Box Terminal refused secure access before attempting bootstrap.
The guest's public metadata was healthy and advertised post-cookie-v1. The
provider desktop contract deliberately requires api_token:null, whereas those
two legacy clients require that management bearer. This is a missing integration,
not evidence that the desktop or provider server was unavailable.

Fixturebfaef5d5-8003-4a4e-a7b3-c7ba7b7084de and its original server164704237
were cleaned up at19:40UTC September5. Do not reuse their stale credentials,
IDs or IP as a new test target. See the weekend continuation receipt.

## Required outcome and constraints

The owner opens Files and Box Terminal from the existing computer detail page.
Files reads and saves the same guarded Hivra workspace used by the contained
desktop. Box Terminal opens its real non-root ttyd shell. The database and browser
must not receive the guest management bearer as a workaround.

Retain the existing owner, provider enrollment, pinned guest identity, lifecycle
and access ledger contracts. Do not make a desktop session implicitly authorize
another surface, add a provider-specific lifecycle, or route arbitrary browser
URLs through an authenticated server proxy. A selected files or box-terminal
grant must not authorize model settings, secrets, other runtime terminals or
desktop control.

## Implementation sequence

1. Narrow request policy (implemented locally, not connected to authentication):
   files allows guarded list/read/write routes; shell allows only the installed
   ttyd document, token response and WebSocket paths. Canonical route comparison
   rejects normalized aliases; query parameters cannot change the scope.
2. Extend the canonical access-grant/session design for an explicit workspace
   surface with owner, computer, audience, expiry and revocation. Reuse the
   established PKCE/one-use exchange mechanics rather than returning a reusable
   guest token. Verify stable running provider identity before issuing it;
   lifecycle changes, retired targets and stale enrollment must fail closed.
   Review the concrete ledger and guest integration before deployment.
3. Connect that grant to the existing guest file handlers and ttyd proxy. Enforce
   canonical Host, same-origin mutations/WebSockets, bounded bodies, strict
   request/response headers, and reauthorization/closure of active sockets.
   A request-policy allow decision alone must never authenticate a request.
4. Adapt the existing Files and Box Terminal views to the scoped handoff for
   provider Ubuntu; preserve working managed and legacy runtime clients.
5. Publish a new immutable guest bundle and additive schema changes only after
   focused tests and independent review. Do not rewrite .05.8 artifacts.
6. On a newly owned, budgeted Canary fixture, read and edit a desktop-created
   shared file through Files; read it through Box Terminal; check reload, expiry,
   revocation, stop/start and cleanup. Confirm management/other-computer denial.

## Milestone evidence and limits (chronological)

workspace-access-policy.cjs is not imported, installed or exposed by a route.
Its tests establish request scope only, not owner authentication, confinement,
revocation, socket lifecycle, launch compatibility or live acceptance.

workspace-sessions.cjs now provides a local guest adapter for an already
exchanged grant. It validates the selected computer/audience/surface/expiry,
calls an injected canonical-authority verifier before minting and on requests,
uses per-session opaque cookies, bounds verification to five seconds, expires
sessions after at most four minutes and closes tracked sockets on expiry or
failed periodic authorization. The adapter owns its maintenance/expiry timers
and has explicit shutdown. This does not implement the canonical grant issuer,
its ledger, exchange endpoint, router or dashboard handoff.

The router must pass the session ID from the immutable handoff URL separately
from the stripped upstream request path. It must not infer session selection
from ambient cookies. Review found and corrected an origin-wide cookie design
that would have allowed revoked document A to adopt newer session B. Regression
tests cover this exact same-cookie-jar transition and independent Files/shell
sessions. Browser document/path rewriting still needs actual ttyd acceptance.

The adapter currently emits SameSite=Strict cookies; this supports same-site
handoff only. A cross-site self-host/custom-origin embedding protocol requires
explicit review before enabling it. Do not silently broaden cookies or bypass
Host/Origin checks to make a test pass. The verifier must honor its AbortSignal,
validate the complete canonical grant and current owner/lifecycle state, and
must not return management credentials to the browser. These integration
requirements remain open despite local callback-based tests passing.

Migration20260906070000 now implements the workspace ledger's owner issue,
one-use PKCE exchange, bearer-hash authorization and owner revocation functions.
Its session snapshot rechecks the existing running allocation, original provider
server, enrollment, connection revision, target and immutable install/access
identity. Computer lifecycle and connection authority changes permanently revoke
old grants; a later return to running/ready cannot restore them. Agent deletion
cascades only that computer's grants. Service role can read the table but cannot
directly insert/update/delete it; mutation is through the narrow functions.

The actual prior PostgreSQL ownership/lifecycle migration chain passes the
targeted workspace fixture, including normal stop/start RPCs, connection
error-to-ready, wrong-owner/surface/audience/identity, replay, expiry and ACL
cases. Attempted disabled connection is correctly rejected by the existing
parent guard. This migration remains unapplied to Canary. The issuer route must
still prove the new installed workspace protocol before calling issuance;
healthy desktop capability is not that proof. HTTP adapters and guest/dashboard
integration remain the next implementation work.

The server exchange and authorization adapters are now implemented at
/api/workspace/sessions/exchange and /api/workspace/sessions/authorize. Both
are guest-broker-only POSTs: browser Origin/Sec-Fetch-Site/Cookie and URL
capabilities are rejected. Strict, bounded JSON carries the immutable binding;
authorization receives only the short-lived session bearer in its header.
Exchange derives the PKCE challenge, passes only secret hashes to SQL, and
returns an unrelated hws1 bearer solely to the guest broker. Every response
binding and expiry is checked before use. Responses are private/no-store and
failures do not reflect storage errors or credentials.

The endpoint milestone passed 29 focused broker/HTTP regressions, ESLint and
TypeScript checking. Independent review caught and closed malformed-date
acceptance and a maintenance rate-budget mismatch: parsed expiry must be finite,
and the authorization ceiling now accommodates 64 sessions checking every five
seconds with interactive headroom. Review found no remaining P1/P2 in this
endpoint scope; it does not cover the forthcoming guest/UI integration.

workspace-control.cjs now composes the guest session adapter with those real
exchange/authorization contracts. Installed configuration owns the control and
public origins and computer ID; handoff input cannot override them. Exchange
returns only the opaque cookie receipt. The short-lived ledger bearer stays
inside the guest session and is not persisted. Every request has one five-second
deadline covering headers and body, a 4KiB response cap, no redirects or ambient
cookies, exact owner/binding/expiry checks, and shutdown cancellation.

The combined 107 focused tests include the actual Next routes and broker adapters
with only transport/database substituted, terminal socket closure after durable
denial, malformed responses, and deadline/teardown behavior. Syntax, ESLint and
TypeScript checks passed; independent review found no P1/P2 in this client scope.
This is contract integration evidence, not public-network or browser acceptance.
The module remains uninstalled and has no HTTP handoff/router yet. Next wiring
must bind requests to the immutable session URL and connect only the existing
guarded file handlers and ttyd, without management-token injection or accepting
ambient cookies as session selection.

workspace-router.cjs now supplies that guest HTTP/upgrade dispatch. The gateway
opts in only when the installed computer service supplies hivra-workspace-v1 and
its three identity/origin settings. No installer enables it yet, and metadata
does not advertise the unfinished protocol. Historical/managed routes remain
unchanged. The router selects authority only from the immutable session path,
dispatches to the existing guarded file handlers, and proxies only the fixed
loopback ttyd port and permitted paths. Cookies, authorization and forwarded
browser authority are not sent upstream; unsafe upstream response headers are
not returned to the browser. Shutdown closes owned terminal streams.

File uploads are bounded before a second authorization immediately preceding
the unchanged guarded writer. Delayed-body expiry and revocation both deny with
zero writer calls. Fifteen router tests exercise actual local HTTP and upgraded
socket transport against an owned stand-in, not ttyd or a live shell. Together
with existing gateway-auth and desktop-profile regressions, 37 tests passed;
Node syntax, ESLint, full TypeScript and diff checks also passed. The first raw
socket fixture retained a half-open peer; modeling terminal EOF closure corrected
that fixture teardown without weakening router cleanup.
Independent review confirmed the delayed-write correction and found no remaining
P1/P2 in this router/gateway scope. Browser handoff, owner issuance, immutable
release sealing and live acceptance remain outstanding.

The pinned [ttyd browser client](https://raw.githubusercontent.com/tsl0922/ttyd/1.7.7/html/src/components/app.tsx)
derives token/socket endpoints from the document's full pathname. Its
[terminal client](https://raw.githubusercontent.com/tsl0922/ttyd/1.7.7/html/src/components/terminal/xterm/index.ts)
uses the tty subprotocol. Thus the immutable session prefix can remain in the
browser URL while the router strips it only after authorization. Real ttyd
rendering/input still requires live acceptance; the transport stand-in does not
prove this browser interaction.

workspace-handoff.cjs is now served at the opt-in gateway's exact
/workspace/handoff route. It accepts a one-use initialization only from the
configured parent origin/window and current document nonce. The exchange stays
in a same-origin POST body; no capability enters a URL. Files messages map only
to fixed list/read/write operations on the original session path. Terminal keeps
its nested browsing context on that same immutable path. Expiry and page exit
abort outstanding requests and remove the terminal document. Terminal reports
document mounting, not successful shell execution.

Files now verifies an authenticated root listing before reporting connected;
exchange JSON is not proof that the browser accepted its HttpOnly cookie.
Workspace authority denials carry a distinct code and end the handoff, while a
guarded private-file denial remains an ordinary file error. SameSite=Strict is
unchanged. The future issuer must gate unsupported cross-site direct-HTTPS
embedding (including sslip.io under the hosted dashboard), or implement a
separately reviewed handoff architecture; do not enable it by loosening cookies.

The combined seven-suite workspace checks passed 133 tests, including executable
handoff-script tests and local HTTP routing. These are not rendered-browser or
real-ttyd acceptance. ESLint and full TypeScript passed. The owner issue/revoke
routes, dashboard adapter and installed protocol verification are still missing;
no installer flag or live deployment has been enabled for this work.
Independent review confirmed the cookie-proof correction and found no P1/P2 in
the handoff scope. The terminal emits a resize after its initially hidden iframe
is shown, so ttyd can fit the visible dimensions immediately; the focused
26-test handoff/router set also passes with that mounting assertion.

The installation dependency is now sealed as release2026.09.05.9 (48 files),
manifest SHA256a1e5bf1856a9d9039b20352b5b7f323cbcffc2bbe2bdbe4f87c00fa5873ccbdb
and bundle SHA25689b5e64591d3cff0f2a4f28460ee9075221946ed37694ec5eb566c5a40af4127.
This supersedes the earlier source-only/installer-disabled milestone: the new
private provider-desktop preparation installs the exact five workspace modules,
root-owns the gateway code and parent directory, and enables the protocol using
the original broker identity/origin EnvironmentFile. It does not make that file
readable by the gateway user or return its private credentials. Managed/default
installation paths are unchanged. Existing .05.8 computers retain their original
release/worker identity and twenty-minute cold-start fence; .05.6/.05.7 recovery
also remains pinned. Fresh provider desktops require the current sealed bundle.

Migration20260906080000 admits only the new exact bundle through three existing
functions, using checked single-occurrence anchors and preserving predecessors.
It and the earlier workspace-session migration remain unapplied to Canary.
The generated repository manifest is287; this is not the live migration ledger.
No existing guest, Canary deployment or paid provider resource changed.

Source gates: 27 preparation/profile tests, 41 Python service-plan tests, 88
release/runtime tests, 82 native/placement/portable-contract tests, full TypeScript
and focused ESLint passed. The targeted real PostgreSQL desktop/workspace chain
passed. Private installed-protocol observation, owner issue/revoke endpoints and
dashboard integration remain required before authenticated UI acceptance.
The full real PostgreSQL ownership chain also passed, including installation,
recovery, native/desktop lifecycle, power, teardown and workspace authorization.
Independent sealed-release review found no P1/P2: all 48 asset hashes/sizes,
retained predecessor identities, cleanup closures and the three additive SQL
anchors were checked. This closes the source release gate only, not live
workspace acceptance.

No owner issuance endpoint or dashboard handoff is connected yet. The migration
is still not live, and no new guest protocol is installed. These endpoints do
not make Files or Box Terminal available by themselves. Remaining integration:
verified installed-protocol admission, owner issue/revoke routes, guest exchange
router/proxy and dashboard clients, followed by immutable release and actual UI
acceptance on a newly owned fixture.

The installed ttyd command uses base path /box-terminal and version1.7.7.
The exact document/token and socket endpoints were checked against
[ttyd1.7.7 HTTP source](https://github.com/tsl0922/ttyd/blob/1.7.7/src/http.c)
and [endpoint definitions](https://github.com/tsl0922/ttyd/blob/1.7.7/src/server.c).
Custom future ttyd assets require an explicit policy review, not a catch-all
prefix allowance.

No paid resource is retained for this repair. Conservative cumulative reserved
Hetzner budget remains GBP2.90 of10; this is not the provider invoice.

## Owner issuance integration (source only)

The owner POST/DELETE workspace routes now use Clerk, the exact configured
control origin, same-origin metadata, strict bounded JSON and no-store replies.
Issuance reuses original provider ownership/enrollment and pinned administrator
SSH, then rechecks the current row before the existing workspace SQL grant.
Only the one-use code hash and PKCE challenge enter storage. Failed or uncertain
issuance attempts an owner-scoped revoke; it never retries a launch or changes
the computer. Cross-site direct-HTTPS embedding remains explicitly unavailable.

The private observation requires .05.9 installed gateway hashes, protected root
ownership and a running non-root gateway with the original identity/origins,
workspace flag, cgroup, Node executable/argv and stable process start ticks.
Both observations reject Node and native-loader injection environment values;
no environment or credential content enters a receipt. An independent reviewer
identified the native-loader gap; it was corrected and reviewed again with no
remaining P1/P2 in this bounded scope.

Six focused suites passed217 tests, including30 executable generated workspace
probe fault cases, original desktop/power probes, pinned SSH, owner issuance and
both owner/guest API routes. Full TypeScript and focused ESLint passed. An early
test was placed in the wrong fixture scope and corrected; one original probe
process timed out during the concurrent check run, then passed the bounded
rerun unchanged. No test deadline or production guard was weakened.

This is not live acceptance: no database migration, guest change, deployment or
purchase occurred. Dashboard integration, actual Linux installed observation,
browser Files read/save and real ttyd input remain next.

## Dashboard connection (source only)

Provider Ubuntu Files and Box Terminal now select the owner-grant path by
substrate/profile, never by whether a management token happens to be present.
Other computers retain their existing access path. Each surface has a separate
lazy retained panel, fresh keyed handoff frame on reconnect, exact frame/origin/
nonce/session message binding and one-use memory-only code/verifier transfer.
Expiry, document reload and pagehide revoke/reset access, reject pending work
and never automatically reconnect or retry a write. A mounted terminal is not
reported as a successful shell command.

Files uses a stable adapter across session renewal. React checks confirmed that
an unsaved edit survives expiry, failed save, tab hiding and manual reconnect;
the successful later save still uses the same draft. Shared-folder labeling now
matches the provider desktop scope. Independent review found a token-presence
legacy fallback, which was removed and covered with an unexpected-token page
case; the corrected review reported no remaining P1/P2 in this bounded scope.

The three browser-bridge/React/page suites passed89 tests; the existing guest
handoff/router suites passed26. Full TypeScript, focused ESLint and diff checks
passed. These are executable protocol/component checks, not real-browser or
ttyd acceptance. No live change or additional Hetzner spend in this milestone.

## Canary release acceptance in progress

On2026-09-05 the exact workspace migrations070000/080000 were applied
transactionally to linked Canary srrwbdvxlqvqjuexitaf, after checking their SHA256,
the291/latest06060000 ledger and zero non-deleted provider computers. Existing
11 provider rows were deletion tombstones and were preserved. The resulting
ledger is293/latest20260906080000; workspace RLS is enabled, authenticated users
cannot read the table or execute owner issuance directly, and session count is0.
No managed computer row was changed.

Source57b256a8dd19ede2475ac278f1f62580e6634edc was built in the verified Vercel
hermesos-canary project as dpl_E8Zfo82Djx2GrHL1wJ2D5Zcm2z3u. Build is READY;
promotion and real launch/workspace acceptance are being checked separately.

The next owned fixture is a fresh cpx22, Helsinki, Ubuntu22.04 (2CPU/4GB), named
CANARY_PROVIDER_WORKSPACE_V9_0905 when admitted. Reviewed gross provider price:
USD0.04536/hour including primary IPv4, monthly capUSD28.308,20TiB included
traffic. Reserve GBP1.00 conservatively for this bounded test (not an FX quote
or invoice), bringing cumulative reservations toGBP3.90/10. Maximum retention
is two hours; teardown must use only the newly returned IDs and verify server,
IPs, SSH key and firewall absence. No paid fixture existed before this attempt.

The new owned order is 00000000-0000-4000-8000-000000001179, provider server
164715496, created2026-09-05T21:30:18.066738Z on the original Canary Hetzner
connection878eee3f-2eff-425b-b68e-435d610bff1e. Cleanup deadline is23:30UTC on
September5. Initial UI evidence was creating/initializing, not ready; the same
request is being observed rather than resubmitted. The canonical Canary alias
was verified to resolve to dpl_E8Zfo82Djx2GrHL1wJ2D5Zcm2z3u before creation.

At21:44UTC, the normal cleanup UI verified all five original resources absent:
server164715496, IPv4 148232838, IPv6 148232839, SSH key118400971 and
firewall11579961. The encrypted bootstrap key was erased and capacity released.
Cleanup initially observed the provider's deletion transition; one later resume
verified absence. No user computer was removed. Fixture data is unrecoverable.

This fixture was undersized: Ubuntu admission correctly requires6GiB available
host RAM for the fixed4GiB desktop plus host services, versus3.32GiB observed.
No agent was admitted and no workspace grant was exercised. Keep that guard;
the next fixture is cpx32/8GB, within the same GBP1 reservation and23:30UTC
cleanup deadline. Provider-agent2/4-to4/8 resize needs a separate suitable test.

Replacement order60cf6e3b-408e-4180-91d5-85a4fafb4687 was submitted through
the Canary UI at21:45UTC: server164716723, namehivra-60cf6e3b408e418091d5,
cpx32/4CPU/8GB, Helsinki, Ubuntu22.04. Reviewed gross rateUSD0.08196/hour
including IPv4, monthly capUSD51.108,20TiB included traffic. Guided setup was
selected. First response observed initializing, action653496460435402; this is
not launch success. The same original23:30UTC cleanup deadline andGBP3.90
cumulative conservative reservation apply. No second creation request is used.

Replacement guided preparation completed with target2d18d0e3-38db-4d42-b45e-
d2d9084622b3 and enrollmentf183d49d-cfd7-4d07-9227-22d7d787eb66. Original
resource IDs: IPv4 148234344 (10.252.45.62), IPv6 148234345, SSH key118401382.
The provider reused the old IP, not its identity; old fixture pins must not be
reused. Ubuntu launch was accepted around21:50UTC as computer515e7629-a345-
41cb-bfd9-a25cde359b7f, CANARY_PROVIDER_WORKSPACE_V9_0905. Browser status shows
the original installer is being observed; no replacement launch is submitted.

## Live .05.9 result and Node archive ownership defect

The original installer succeeded at21:59:20.156529UTC and running was recorded
at21:59:24.062UTC, about9m10 after launch. The normal browser Desktop connected
through agents-canary-box-redacted.hermesos.cloud. Ubuntu's application menu
and Konsole responded to real input. A command created the owned marker
/home/ubuntu/Hivra/canary-workspace-v9.txt with HIVRA_V9_DESKTOP_20260905.
The host image is Ubuntu22.04; the contained desktop identifies Ubuntu26.04.1.

Opening Files failed: the owner POST /api/workspace/sessions returned409 on
dpl_E8Zfo82Djx2GrHL1wJ2D5Zcm2z3u, and no workspace session row was created.
The computer remained running with api_token NULL. Original enrollment-bound,
pinned read-only SSH observation isolated the rejection to Node's executable
parent ownership: /opt/hivra/node-v22.23.2-linux-x64, its bin directory and node
binary were UID1001/mode0755; /opt/hivra and its parents were root-owned0755.
The workspace guard is correct; the root extractor preserved the vendor's
numeric archive owner. No browser grant, weaker probe or management token was
used to conceal the failure.

Candidate extraction now uses --no-same-owner after the existing archive SHA256
check. An initial additional --no-same-permissions flag was rejected in review:
the private worker umask0077 would make Node paths0700 and inaccessible to bux.
Only ownership is now overridden; checksum-pinned archive modes are retained.
The candidate passed28 focused base/profile tests, including exact extraction
arguments under umask077. A bounded real GNU tar test on this exact Linux
fixture executed the candidate extraction against a synthetic UID1001/mode0755
archive: old extraction UID1001, corrected UID0/mode0755, unchanged outer0077,
owned temporary directory verified absent. This did not modify running Node.

The .05.9 manifest and installed guest code are unchanged. These checks do not
establish repaired Files read/save, terminal input, session expiry or a corrected
fresh launch. Those require the next immutable release and browser acceptance.

Independent read-only review of the corrected two-file source diff is green;
the real GNU tar fixture above closes its requested extraction execution check.
No in-place Node ownership repair was performed. Normal computer teardown was
requested for this exact disposable fixture; absence verification is pending.

Teardown completed at22:11:11.827650UTC through the normal Manage/Destroy flow.
Order60cf6e3b-408e-4180-91d5-85a4fafb4687 is deleted; its original server,
IPv4, IPv6, firewall and generated SSH key are all verified absent, last error
NULL, and encrypted bootstrap material erased. The marker is irrecoverably
deleted with the fixture. The browser returned to the four pre-existing running
Ubuntu computers; no user computer or data was modified. No paid test server
remains. Conservative cumulative budget reservation remainsGBP3.90/10, not an
invoice. Source repairbc2b41386 is committed/pushed; next is immutable release
sealing and fresh launch/Files/Terminal acceptance, not a production rollout.

## Corrected immutable release .05.10 (local gate)

Sealed48 assets with manifest SHA256e9ddbe7c270e36fc78c25d76378d86ff70fcbf9fb4c4c582482c8195021a7934
and canonical bundle SHA256c48b6f0df47743e4fd4978b3a886e1fb68ee5cc163d51781cd8c7a4a539b7860.
Worker SHA256b0838bdc61079929144590cc8f606f2ad22db35d4fa9062920548884d92f032c,
45187bytes. Only VERSION, worker version constants and the reviewed Node tar
ownership correction differ from .05.9. Native and desktop retained cleanup
files are unchanged. All .05.9 manifests, recipes, identity/digest pairs and
twenty-minute desktop recovery deadline remain retained; no existing guest is
upgraded by these changes. Fresh provider Ubuntu admission requires .05.10.

The additive090000 migration inserts the new exact version/digest pair through
three once-only function anchors. Its SHA256 is
95f947afaab8aa260020e7c98a114f2b25886ccfdb09919b0669b2aebb15d0b1.
Actual PostgreSQL ownership/workspace/lifecycle chain passed, including the new
release admission. Seven focused suites passed181 tests before extra retained
.05.9 cases; the corrected two worker/runtime suites passed79 and portable
compatibility passed26. Full TypeScript and focused lint passed. A wrapper
subprocess reached its10-second test deadline during concurrent PostgreSQL
work; its isolated rerun passed unchanged. No operational timeout was weakened.

Independent review caught missing explicit .05.9 predecessor entries after the
current-version bump. All four compatibility lists now retain it; a regression
covers model settings, Proxmox, provider agents, Linux Desktop and the separate
current-only fresh provider desktop gate. Final review is green for source and
seal scope. Live migration, deployment and fresh Files/Terminal acceptance are
separate remaining gates; no new capacity was purchased in this milestone.

The exact090000 migration was applied transactionally to linked Canary
srrwbdvxlqvqjuexitaf, guarded by ledger293/latest080000 and zero active provider
computers. Result:294/latest20260906090000. The retained August28 ambiguous
order14cb5822-686c-4295-9283-00388d835da7 predates this test and was not changed.
The zero-paid-fixture statements above refer to this weekend's owned resources,
not a provider-wide billing audit of that historical record.

Clean source6c233db13683d202407db731e637771b9156fd12 was submitted to verified
Vercel projecthermesos-canary as dpl_FatGMZxH9tfQ79uWFRJYU9FR1aC7 at22:21UTC.
Build/promotion and fresh browser acceptance remain pending at this checkpoint.

The build reached READY and was promoted successfully. Vercel inspection of
canary.hermesos.cloud confirmed dpl_FatGMZxH9tfQ79uWFRJYU9FR1aC7; the browser
was reloaded before the next fixture. Reserve GBP1 for one fresh cpx32/8GB
acceptance test, taking conservative cumulative reservations toGBP4.90/10.
Maximum retention is two hours from creation, with exact original-resource
cleanup; live quote and fixture IDs will be recorded on acceptance.

Fresh order959d6ec4-2d14-4834-bfba-1a5cc7bc89b0 created server164719331,
namehivra-959d6ec42d144834bfba, cpx32/4CPU/8GB/160GB, Helsinki, Ubuntu22.04.
Reviewed gross quoteUSD0.08196/hour including IPv4, monthly capUSD51.108,
20TiB included. First response at22:25:40UTC reports initializing, original
action653505050410331. Cleanup deadline00:25UTC September6, within the GBP1
reservation above. No completion or replacement submission is inferred from
this intermediate response.

Guided setup reached Environment prepared before22:31:49UTC. Target is
00000000-0000-4000-8000-000000001180; the launch screen measured4CPU and7.12GB
available. Normal Computer / Ubuntu Desktop / My infrastructure launch admitted
CANARY_PROVIDER_WORKSPACE_V10_0905 as47dca9e0-3cd1-429d-8e64-0330181c4cf4
at approximately22:32UTC. The detail page reports the original installer is
being checked, not a replacement launch. Original IPv4 ID148238423 and IPv6
ID148238424, generated SSH key118402564. Cleanup deadline remains00:25UTC.

## Fresh .05.10 browser acceptance

Enrollment attempt8bd425be-9276-4c75-9fbf-4066649830b0 completed22:28:38.709104UTC.
The original installer succeeded22:42:07.809985UTC and the database confirms
2026.09.05.10/running. Public desktop connected in10.4seconds. Actual KDE
application-launcher/Konsole input created canary-workspace-v10.txt in
/home/ubuntu/Hivra and printed the owned marker. Files connected, listed and
read that exact marker, then edited/saved HIVRA_V10_FILES_SAVED_20260905.
Box Terminal opened a real shell as UID/GID1001(bux), cwd/home/bux/Hivra, and
cat returned the Files-saved value. No private/manual guest repair was used.

Files grant issued22:43:40.937903UTC, exchanged22:43:41.617693UTC and expired
22:47:40.937903UTC, with durable revocation22:47:41.295818UTC. The visible
disconnected state retained an unsaved draft. Explicit Reconnect issued a new
grant22:48:02.031813UTC without resetting that draft; saving succeeded and
desktop cat returned HIVRA_V10_DRAFT_SURVIVES_EXPIRY_20260905. Terminal's
separate grant expired and its normal tab offered Reconnect Terminal.

Temporary1200x800 browser viewport caused the real desktop/Konsole to resize;
the next command printed HIVRA_V10_RESIZED_INPUT_OK. Viewport override was
reset. This is browser-size adaptation, not physical monitor-unplug acceptance.
Ctrl-C remains unverified: native key chords produced no evidenced interrupt,
and the focused Playwright attempt reported a browser clipboard/input-target
error. Bounded sleeps finished naturally and subsequent input worked. No
application shortcut defect or successful interrupt is inferred from that tool
limitation. Terminal reconnect/exit, page reload and final cleanup follow.

Terminal reconnect issued a separate new grant22:49:03.921926UTC and its shell
read the saved draft. stty size changed from42x96 to42x157 at1200x800; however
that viewport showed visibly undersized terminal text. Restoring the default
viewport restored normal rendering (42x100 immediately observed). Record this
as a remaining resize-rendering investigation, not clean visual acceptance.
Normal exit printed logout and ttyd's reconnect prompt. Both renewed workspace
grants were durably revoked by page reload at22:50:12.310xxxUTC. The existing
desktop reconnected after reload in4.6seconds; no new computer was created.

Files reconnected after page reload, listed the41-byte test file and rendered
HIVRA_V10_DRAFT_SURVIVES_EXPIRY_20260905. Normal Manage/Destroy then removed
the exact disposable computer and original order. At22:51:47.789754UTC the
order is deleted, original server/IPv4/IPv6/firewall/generated SSH key absence
are all true, cleanup error is NULL, and encrypted bootstrap material is erased.
The browser returned to the four pre-existing running Ubuntu computers. The
owned test file is irrecoverably removed with the fixture; no user machine or
data was modified. No paid fixture from this test remains. Conservative
cumulative reservations stay GBP4.90/10 (not an invoice or provider-wide audit).

This milestone establishes fresh .05.10 launch, desktop input, Files read/save,
non-root terminal input/readback/exit, expiry/reconnect, reload revocation and
owned cleanup through Canary's public UI. It does not establish Ctrl-C, clean
terminal resize rendering, physical monitor unplug, .05.10 stop/start workspace
continuity, cross-surface negative browser tests, interrupted-install teardown,
provider agent inference/resize, whole-computer recovery, Omarchy or Windows
acceptance. Those remain separate work; no all-platform completion is claimed.

## Local terminal resize isolation

Unmodified upstream ttyd1.7.7 reproduced the small-text resize outside Hivra,
without any provider purchase. Official arm64 container digest
sha256:4c2fdb3153d91cacf6fe6877e31b8ef9e71e6fe5ed175e7d399790b0a068fbe9
ran read-only as UID65534, no host mounts/capabilities,128MiB/0.5CPU/24PIDs,
with only127.0.0.1:17682 published. Actual browser shell input and stty resize
worked. Setting the in-app browser viewport to1200x800 reproduced the tiny
text. Read-only DOM evidence showed devicePixelRatio1 and a1169x780 CSS canvas
retaining a2338x1560 backing store. Resetting the override restored rendering.
The supported canvas renderer also reproduced the symptom, so switching from
WebGL to canvas is not an evidenced fix. This isolates the observation to ttyd
rendering/pixel-density handling, not Hivra authorization, provider capacity,
or workspace framing. It does not distinguish a real display-density event
from the automation viewport override; physical monitor-unplug remains untested.

No guest bytes or production settings were changed. The local shell exited,
temporary tab closed, viewport reset, and exact test container43ffabd8f8f2 was
stopped/auto-removed with absence confirmed. The downloaded pinned image remains
as a reusable local test cache. Source reference for supported renderers/resize:
https://github.com/tsl0922/ttyd/blob/1.7.7/html/src/components/terminal/xterm/index.ts

## Next provider-agent campaign reservation

Reserve GBP1 for one fresh provider-agent launch, disk-preserving resize and
cleanup campaign, taking cumulative conservative reservations toGBP5.90/10.
At22:58UTC the connected project UI reports zero servers and the six original
managed computers remain listed. No new server has been purchased at this
checkpoint. Review the live quote before purchase; retain at most two hours
from creation with exact-ID cleanup. Native model sign-in/inference remains
separate from provisioning/lifecycle acceptance; do not copy user-machine
credentials to the fixture or claim a model reply from a shell/version check.

Reviewed cpx22/2CPU/4GB/80GB, Helsinki hel1, Ubuntu22.04, gross
USD0.04536/hour including IPv4/VAT20%, USD28.308 monthly cap,20TiB included,
USD1.44/TB additional outgoing traffic; backups off, no volumes. Normal UI
submitted one guided-setup request. At22:59:35UTC original order
00000000-0000-4000-8000-000000001181 returned server164721218 initializing,
namehivra-e10e57698ba54cdb9180, action653505050446276. Cleanup deadline is
00:59UTC September6, within the existing GBP1 reservation. No agent is launched
at this checkpoint; follow the original operation only.

Same-request observation confirmed created_off at23:01:29UTC. Guided setup
completed with target8b19141d-c28a-470c-9444-1ebf8a056fb2 and enrollment
00000000-0000-4000-8000-000000001182 enrolled23:02:51.233913UTC. Original
generated SSH key118403480. Normal Agent/Codex/My infrastructure launch used
measured2cores/3.31GB available and admitted CANARY_PROVIDER_CODEX_RESIZE_0906
as4abbe3f6-0245-4b00-97da-24a056e46766 around23:04UTC. UI is checking the
original installer; native rendering, inference, resize and cleanup are pending.

Original .05.10 installer succeeded23:05:46.527955UTC. Native Codex terminal
rendered its actual ChatGPT/device-code/API-key sign-in screen; no model reply
is claimed. Box Terminal ran codex --version (codex-cli0.149.1), nproc2,
free reporting3810MiB total, and lsblk reporting sda81923145728bytes. Created
/home/bux/Hivra/canary-resize-0906.txt with SHA256
d2a52ec62c346c244513cba4f321700af49e53dc965345c2bc0f061004b87ef4.
The owned shell exited. Normal Stop reached Stopped, and Manage offered cpx32
4CPU/8GB while retaining the existing80GB disk. Fresh resize quote requested;
no resize success or preservation after mutation is claimed yet.

Resize quote cpx22→cpx32 accepted at gross server-plan USD0.08076/hour,
USD50.388 monthly cap, excluding existing IPv4. Operation
00000000-0000-4000-8000-000000001183 dispatched original provider action
653513640386891. Hetzner powered the changed server on; Hivra detected this,
completed the saved shutdown and only marked success once off was verified.
At23:09:56.627618UTC the operation succeeded with4cores/8GB/80GB/off, same
server164721218. Normal Start returned Running. Browser Box Terminal verified
nproc4,7741MiB RAM, exact same sda81923145728bytes, unchanged marker SHA256,
and codex-cli0.149.1. Native Codex rendered again after boot. No pinned runtime
upgrade was accepted. Native device-code sign-in is being checked separately;
this is live upgrade/start/data-preservation evidence, not model inference.

Native device-code authorization reached the normal OpenAI device URL, but the
browser had no signed-in OpenAI session and showed the login page. No account
credentials, cookies, metered model configuration or device code were submitted.
Closed that temporary auth tab and cancelled the native sign-in. Inference
remains unverified; no credential file was copied from an existing machine.

Normal Stop followed by fresh cpx32→cpx22 quote accepted gross server-plan
USD0.04416/hour, USD27.588 monthly cap, existing IPv4 separate and80GB disk
retained. Downgrade operation6f6d56e5-2d5d-49bc-9df8-b5126166005b uses original
provider action653513640389690. UI completed the saved shutdown and returned
2CPU/4GB/80GB/Stopped, then normal Start was pressed. Post-downgrade readback
and cleanup remain pending at this checkpoint.

Downgrade succeeded23:15:46.375326UTC with2CPU/4GB/80GB/off. Normal Start
returned Running and actual browser shell confirmed nproc2,3810MiB RAM,
sda81923145728bytes, codex-cli0.149.1, and the original marker SHA256 unchanged.
The shell exited. Normal Files navigated into Hivra and read the33-byte marker
HIVRA_PROVIDER_CODEX_RESIZE_0906. This proves the complete up/down resize
round trip and retained runtime/file on this one provider computer. It does
not establish an automatic failure rollback, other runtime profiles or native
model inference. Normal Manage destruction of this exact fixture is requested;
final original-resource absence verification remains pending.

Cleanup completed23:19:18.964642UTC via normal Manage/Destroy. Original
order 00000000-0000-4000-8000-000000001181 is deleted, original server164721218,
IPv4,IPv6,firewall and generated SSH key all verified absent; cleanup errorNULL,
encrypted bootstrap erased. The test file and unauthenticated local runtime
state are irrecoverably removed with the fixture. Home lists the original four
running Ubuntu computers and two running agents, unchanged. No paid test server
from this campaign remains. Conservative reservations remain GBP5.90/10, not
an invoice or provider-wide legacy resource audit. No production target, model
API key, metered gateway or existing user login was changed.

Provider Codex launch/native rendering, public shell/Files, up/down resize,
stop/start, capacity reconciliation and owned cleanup pass for deployed Canary
source6c233db13683d202407db731e637771b9156fd12 and fresh bundle2026.09.05.10.
Native account inference, failure rollback, other agents, interrupted installer
cleanup, full recovery and non-Ubuntu OS acceptance remain separate gates.

### September 6 — active pre-ownership installation cancellation accepted

On deployed Canary source `ed1c41bd7`, bundle `2026.09.06.1`, normal guided
purchase/setup and Ubuntu launch produced one original active installer before
desktop ownership existed. Normal Manage/Destroy stopped that worker with the
retained `cancelled` outcome before provider teardown. All five original
resources were removed, with fresh original-server absence recorded separately
and no fabricated guest-cleanup receipt. Independent review confirmed provider
absence and terminal SQL ordering. Full evidence and exact IDs are in
`docs/release/2026-09-06-provider-interrupted-install.md`.

The fixture is deleted; six original managed computers/agents retain their
identities, allocations and running states. Conservative cumulative reservations
are **£6.90/£10**, not an invoice. No active paid fixture remains from this test.
Post-ownership cancellation, failure rollback, full recovery and other OS gates
remain open. A misleading pending-resize warning during provision was observed
and remains a separate UI defect; no resize was requested in this campaign.
