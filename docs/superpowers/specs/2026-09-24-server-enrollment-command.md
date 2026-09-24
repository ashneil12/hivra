# My server: one-command enrollment, design and threat model

Date: 2026-09-24
Status: Proposed design and threat model, written before implementation. Nothing
in this document is implemented. No route, table, script or UI described below
exists yet. Merging slice 13 needs this document reviewed first.
Revision 2 (2026-09-24) fixes the first review: the gVisor authority rule no
longer depends on a discovery snapshot for existing computers (9.5), the
terminal prompt can't be skipped with `--yes` when a terminal exists (6.1),
the final line is safe to cut at any byte (6.2), host scripts under sudo travel
on stdin behind one constant command (9.2), the server-side marker no longer
claims a connection Hivra never confirmed (6.6), nothing is reported before the
terminal prompt (6.1), and the network and retention rules are named (10, 12).
Scope: redesign proposal C7 / slice 13 (INF-03), plus the privilege change it
depends on (INF-04) and the trust-on-first-use rule it shares with the advanced
SSH wizard (INF-14).
Parents: `2026-08-26-hivra-infrastructure-onboarding-design.md` (Existing Server
Path), `2026-08-27-hetzner-first-boot-design.md` (the enrollment machinery reused
here), `2026-08-24-hivra-agent-computers-design.md` (Computer identity and access).

## 1. Outcome

A person with a Linux server they already run (AWS, GCP, Azure, a VPS, a
dedicated box) connects it to Hivra by pasting one command into a terminal on
that server. They do not copy a private key into a web form or read a host
fingerprint off a console. Then they answer one question in Hivra: **Is this
your server?** After that, the normal inspection, Prepare and Launch steps run
unchanged, over SSH pinned to the server's own host key.

Two parties must agree before Hivra gets administrator access. The server's
administrator runs the command and agrees in the terminal. The Hivra account
owner answers "Is this your server?" in Hivra. Usually they are the same
person. The threats are different: a stolen command attacks the Hivra account,
and a command someone was tricked into running attacks the server. Each check
defends one side, and section 14 says how far each one goes.

## 2. What exists today (verified in code, 2026-09-24)

Paths are under `dashboard/` unless they start with `docs/`.

| Area | Current behaviour | Evidence |
| --- | --- | --- |
| Manual SSH path | Owner pastes a private key that already signs in, and a SHA-256 host fingerprint read off the server. No passphrase field. | `src/components/infrastructure/InfrastructureConnectionWizard.tsx:633-702` |
| Privilege checks | Discovery counts only `id -u` = 0 as privileged. gVisor requires the SSH user to be the literal string `root` in three places. Proxmox preflight also checks `id -u`. | `src/lib/infrastructure/host-discovery.ts:253, 481, 627`; `src/lib/hivra/gvisor-computer-service.ts:137, 232`; `src/lib/infrastructure/gvisor-target.ts:75, 88`; `src/lib/infrastructure/proxmox-preflight.ts:618` |
| gVisor authority by stage | **Runtime** (every operation on an existing gVisor computer, line 137) reads no discovery snapshot. It uses the current connection plus target evidence bound to the connection revision (`normalAuthority`, `isGvisorPendingBoundObservation`). **Preflight** reads the newest snapshot for the connection revision and requires it unexpired and `effectivePrivilege: "root"` (`gvisor-target.ts:77-89`). **Prepare** (line 232) reads no snapshot, but its route runs preflight straight after (`api/infrastructure/connections/[id]/gvisor/prepare/route.ts:40-41`). Snapshots expire after 15 minutes. | `HOST_DISCOVERY_SNAPSHOT_TTL_MS`, `src/lib/infrastructure/host-discovery-contracts.ts:5`; `src/lib/hivra/gvisor-computer-contract.ts:34-54` |
| Discovery contract version | `HostDiscoverySnapshotSchema` pins `contractVersion` to `z.literal(1)`. SQL pins it too: column check `contract_version = 1`, and `complete_infrastructure_host_discovery` refuses any other value. | `host-discovery-contracts.ts:3, 75`; migration `20260826150000_host_discovery_snapshots.sql:25, 45, 248` |
| Privilege copy | "Hivra needs a root login on … Let root sign in with your SSH key". | `src/lib/infrastructure/host-discovery-outcome.ts:143-152`; `src/lib/infrastructure/connection-preflight.ts:105` |
| Hetzner `hivra` user | Cloud-init creates `hivra` with `sudo: ALL=(ALL) NOPASSWD:ALL`, a locked password and Hivra's key, and turns off password and root SSH sign-in. | `src/lib/infrastructure/first-boot-cloud-init.ts:84-94` |
| Hetzner sudo runner | The first-boot SSH client signs in as `hivra` and runs every recipe as `sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/timeout --signal=TERM --kill-after=1s 8s /bin/bash --noprofile --norc -s`, with the recipe on stdin. The remote limit (8 s) stays under the local deadline (10 s). | `src/lib/infrastructure/first-boot-ssh.ts:227-240, 331-334, 359` |
| Host script transport (Proxmox runner) | `runProxmoxHostScript` sends the body on stdin to `bash -s`. `runProxmoxHostScriptWithStdin` puts the whole body (up to 96 KB) into argv as `/bin/bash -c "$(printf '%s' '<base64>' \| /usr/bin/base64 --decode)"` and keeps stdin for data. The gVisor identity guard and every gVisor computer operation use the second form. | `src/lib/services/proxmox-instance-service.ts:1750-1774`; `gvisor-computer-service.ts:175-176` |
| Early finish | Proxmox provisioning resolves as soon as it sees `HIVRA_PROVISION_RESULT`. The provisioner keeps running on the host as a `nohup … &` child of the same session. | `src/app/api/hivra/agents/route.ts:342-343, 1816`; `proxmox-instance-service.ts:1700-1712` |
| Hetzner first boot | A 256-bit `hbe1_` capability, 15-minute TTL, verifier digest bound to owner/connection/order/attempt/recipe, delivered in cloud-init, posted back with the Ed25519 host key in an `Authorization` header, consumed once in SQL, identical replays acknowledged. | `first-boot-enrollment.ts`, `first-boot-receiver.ts`, `api/infrastructure/first-boot/enroll/route.ts`, migration `20260827190000` |
| Machine-route hardening | No query string, browser `Origin`/`Sec-Fetch-Site` refused, strict JSON, no `Content-Encoding`, 2 KB body with 5 s read deadline, constant `{accepted:false}` denials, allowlisted log fields. | `first-boot/enroll/route.ts` |
| Middleware | Exact-path Clerk exclusion for the receiver, listed in both matcher entries and pinned by `proxy-config.test.ts`. | `src/proxy.ts:40-86` |
| Trusted origin | Callback origin comes from `NEXT_PUBLIC_APP_URL`, never request headers; validated as bare `https://host`. | `api/infrastructure/connections/[id]/hetzner-cloud/capacity/route.ts:143-153`; `firstBootCallbackUrl` |
| Reachability probe | Before a guided purchase, Hivra checks the machine endpoint answers the constant 401 JSON (not a login redirect). | `first-boot-callback-readiness.ts` |
| Pinned helper | The guest helper's sha256 is a constant; the file is refused if it differs. | `first-boot-cloud-init.ts:11, 46-56` |
| Key generation | Ed25519 generation with rejection sampling around an `ssh2` leading-zero bug. | `src/lib/infrastructure/hetzner-cloud.ts:265-300` |
| Pinned SSH | User connections refuse to run without a pinned fingerprint; `hostVerifier` compares SHA-256. The first-boot client also restricts `serverHostKey` to `ssh-ed25519`. | `proxmox-instance-service.ts:1510-1517, 1616-1630`; `first-boot-ssh.ts:307` |
| SSRF guard | SSH destinations are resolved once; any reserved answer fails the hostname; loopback, link-local and metadata stay blocked even when self-host private networks are allowed. | `src/lib/infrastructure/connection-runtime.ts:81-147` |
| Client address | `getIP()` prefers `cf-connecting-ip`, then `x-real-ip`, then `x-forwarded-for`. Nothing reads `x-vercel-forwarded-for`. | `src/lib/rate-limit.ts:188-197` |
| Rate limits | In-memory fixed windows per serverless instance, keyed by `getIP()`. | `rate-limit.ts:15, 188-197` |
| Connection limit | No per-plan limit on connected servers exists. Neither `create_host_infrastructure_connection` nor `POST /api/infrastructure/connections` counts connections. | migration `20260826140000_host_connections_v2.sql`; `api/infrastructure/connections/route.ts:105-170` |
| `/etc/hivra` | Prepare creates it 0755 (`provisioner/prepare-proxmox-host.sh:9, 94`). The DeepSeek gateway requires `/etc` and `/etc/hivra` to be root-owned and not group- or other-writable, and it runs as a non-root user that must traverse `/etc/hivra` to read its config. | `provisioner/deepseek-harness/gateway-policy.cjs:19-29` |
| Account deletion | `ACCOUNT_DELETION_TABLES` lists no `infrastructure_*` table. | `src/lib/ops/account-deletion.ts:35` |

What this design reuses from the Hetzner first-boot machinery:

| Reused as-is | Extracted and shared | Pattern copied | Not applicable |
| --- | --- | --- | --- |
| `encryptSecret`/`decryptSecret` with a purpose tag; `readBoundedJson`, `hasStrictJsonContentType`, `isSameOriginMutationRequest`; `resolveValidatedSshDestination`; `reservedAddressReason`; the pinned-SSH runner | `canonicalFirstBootHostKey` becomes a shared `canonicalEd25519HostKey`; the rejection-sampling key generator leaves `hetzner-cloud.ts` for a shared module; `firstBootCallbackUrl`'s origin validation becomes a shared `trustedAppOrigin()` | **The `hivra` user shape** from cloud-init (key only, locked password, `NOPASSWD:ALL`); **the sudo runner command** from `first-boot-ssh.ts:333` (`sudo -n`, `env -i`, fixed `PATH`, `LC_ALL=C`, remote `timeout` below the local deadline, `bash --noprofile --norc`, body on stdin); machine-route hardening; exact-path middleware exclusion; reachability probe; pinned-file sha256 constant; private table with RLS, revoked grants, guard trigger and SECURITY DEFINER transitions; consume-once plus identical-replay acknowledgement | Provider API evidence, metadata server ID, cloud-init, firewall-before-power, creation receipts |

## 3. Scope and non-goals

In scope: the command, the script and its uninstall mode, the enrollment code,
the report callback, "Is this your server?", connection creation with a pinned
host key, and running host scripts through passwordless `sudo` for enrolled and
advanced sudo-user connections.

Not in scope, and not claimed:

- **Home and private-network machines stay unsupported.** Hosted Hivra still
  reaches servers by inbound SSH from its functions. A home or office machine
  behind a router is not reachable, and this slice does not change that. The
  outbound connector draft (`2026-09-24-home-machine-outbound-connector.md`)
  expects to arrive "with the one-command enrollment"; the approved proposal
  puts it in slice 16. That is a scope difference between documents, not
  shipped behaviour. This slice ships no `--outbound` flag, and the script
  refuses unknown flags.
- **IPv6-only servers.** Hosted Hivra reaches servers over IPv4 only (10.4).
  They are refused at report with copy.
- Password-only servers with no sudo user: out of scope. The command needs a
  user who can run `sudo` (or a root shell).
- Non-x86 and non-supported operating systems enroll no user. With consent, the
  script reports what it found so Hivra can say why (6.1, step 6).
- Windows, macOS and containers without sshd.
- Key rotation for an enrolled connection. Running a new command replaces the
  key (6.6).

## 4. User flow and copy

**My server → Connect a server you already have**

> Run this on the server, as a user who can use sudo:
>
> `curl -fsS --proto '=https' -H 'Authorization: Bearer hse1_…' https://hivra.cloud/enroll | sudo bash` **[Copy]**
>
> Single use · expires in 14:52 · **[View the script first]** · **[Get a new command]**
>
> Signed in as root (Proxmox usually is)? Leave out `sudo`.
> Works with Ubuntu 22.04 or 24.04 on x86, or Proxmox VE 8 or 9. The server
> needs a public IPv4 address and must accept SSH from the internet. Home or
> office machine? Hosted Hivra can't reach private networks yet.
>
> *Waiting for your server… no contact yet · 0:41* — check your terminal if nothing happens.
> [Connect with SSH details instead (advanced)]

The waiting line reports only what Hivra saw: "The setup script was downloaded
with your command at 12:03:41" once a fetch is counted, and "Hivra refused a
report for your command: it arrived over IPv6 only" after a refused report
(7). The origin in the command is the deployment's own `NEXT_PUBLIC_APP_URL`
(Canary shows the Canary origin). The code is never put in a link or the page
URL.

**In the terminal**

```
Hivra server setup · script 2026.09.24.1

This will:
  - create a user named hivra that can only sign in with Hivra's key (SHA256:Qm4…)
  - let hivra run administrator commands without a password (sudo)
  - send this server's SSH identity and basic facts to https://hivra.cloud
Nothing else is installed or changed. To undo it later:
  curl -fsS --proto '=https' https://hivra.cloud/enroll/uninstall | sudo bash

This gives the Hivra account sam***@example.com administrator access to this server.
Only continue if that is your account and you copied this command from Hivra yourself.
Continue? [y/N]
```

On success: `Done. Hivra shows the same three words: amber falcon river. Go back
to Hivra and confirm "Is this your server?"`

**Is this your server?** (appears as soon as the report lands, and stays on the
Capacity page until it is answered or expires)

> A server used your setup command 12 seconds ago.
>
> | | |
> |---|---|
> | Connected from (seen by Hivra) | 203.0.113.24 |
> | Reported by the server | ip-172-31-4-9 · Ubuntu 24.04 · x86 · 4 CPU · 16 GB · approved at its terminal |
> | Your terminal shows | **amber falcon river** |
> | Server identity | SHA256:Xb…9Q [Copy] |
>
> Only choose Yes if your terminal shows these three words. If your terminal
> said the command was already used, someone else has your command: choose No.
> If your terminal said Hivra didn't answer, choose No and run a new command.
>
> **[Yes, this is my server]** **[No, cancel]**
> Hivra will connect to 203.0.113.24 on port 22 as hivra. [Use a different address]

When the script ran without a terminal (6.1, step 8), the reported row says
"run without a terminal (--yes)" instead of "approved at its terminal".

After Yes: the Capacity card switches to the normal inspection outcome
("web-1 can run Linux Sandbox after a short setup. [Review setup]"). When a
launch sent the person here, the result offers **Continue your launch**, linking
to `/dashboard/launch?target=<id>`.

After No: "Cancelled. Hivra deleted its key for that server, so it can't sign
in. To remove the hivra user from that server, run: `curl … /enroll/uninstall |
sudo bash`."

## 5. The enrollment code

| Property | Rule |
| --- | --- |
| Format | `hse1_` + 32 characters of lowercase RFC 4648 base32 (`[a-z2-7]`), from 20 bytes of `crypto.randomBytes`: 160 bits. The proposal's `7Q4K-M2XR` was an illustration; 40 bits is too few for an online bearer that can take over a server. |
| Where it travels | Only in the `Authorization` header of the GET, then inside the served script, then in the `Authorization` header of the report. Never in a URL path or query, so browser history, referrers and platform request logs don't see it (canonical design, "Computer identity and access"). |
| At rest | Only `code_sha256 = sha256("hivra/server-enrollment/code/v1" ‖ 0x00 ‖ code)`, unique-indexed. The code itself is never stored, logged, returned again, or placed in events. A 160-bit random secret needs no pepper or slow hash. |
| Shown | Once, in the issue response, held in React memory only (no storage). A reload loses it; the panel offers **Get a new command**, which cancels the previous code unless a server already reported with it. |
| Owner-bound | The row carries the issuing `user_id`. The machine endpoints never take an account from the request. Confirm, cancel and status need that owner's Clerk session. |
| Lifetime | 15 minutes from issue to report (`expires_at`, checked at SQL commit with `clock_timestamp()`). After a report, the owner has 30 minutes to answer (`confirm_by`). |
| Redemption | Fetching the script does not use the code (so `--dry-run` and "view first" keep it valid). The code is spent by exactly one accepted report: `issued → reported` or `issued → unsupported`, in one conditional `UPDATE … WHERE phase = 'issued' AND expires_at > clock_timestamp()`. A byte-identical repeat of the accepted report gets the same acknowledgement and changes nothing (network retries and lost responses, 6.1 step 13). Anything else after that is refused. |
| Active limit | At most 3 unexpired, unanswered codes per user. |
| Account checks | Every account-level condition that could refuse the connection at Yes also runs when the code is issued and again at report, so a server is never changed for a connection Hivra already knew it would refuse. Today that is the account's access to host connections and the active-code limit; no per-plan server limit exists (section 2). If one is added later, unanswered codes count as pending connections and it is checked at issue, report and Yes. |

States: `issued → reported → confirmed | rejected`, `issued → unsupported`,
`issued | reported → cancelled | expired`. A guard trigger refuses every other
transition, and a check constraint requires the sealed private key to be null in
`confirmed`, `rejected`, `unsupported`, `cancelled` and `expired`. Expiry is
treated as a fact at read time, and a sweep also sets `expired` and wipes keys.

Each code is issued with its own Ed25519 key pair for the `hivra` user, made by
the shared rejection-sampling generator. The private key is sealed with
`encryptSecret` under purpose `hivra/server-enrollment/admin-key/v1`. It is never
used for any other enrollment, server or account.

## 6. The script

### 6.1 What it does, and nothing else

In order. Nothing is sent anywhere without a yes at the terminal (step 6 or
step 8, or `--yes` when there is no terminal), and nothing is changed before
step 9. From step 9 it stops at the first failure and undoes anything it
changed:

1. **Preconditions.** Requires bash, and effective UID 0 (from `sudo bash` or a
   root shell) unless `--dry-run`. Sets `PATH=/usr/sbin:/usr/bin:/sbin:/bin`,
   `LC_ALL=C`, `set -Eeuo pipefail`, and `umask 077` for its own temporary
   files. It does not rely on the umask for anything it installs: every path it
   creates is made with an explicit mode and owner (`install -d -m 0755 -o root
   -g root /etc/hivra`; `install -d -m 0700 -o hivra -g hivra ~hivra/.ssh`;
   authorized keys 0600 hivra:hivra; sudoers drop-in 0440 root:root; marker 0644
   root:root). `/etc/hivra` must stay 0755 and root-owned because Prepare and the
   DeepSeek gateway expect a root-owned directory that other users can traverse
   (section 2). If `/etc/hivra` already exists, the script leaves its mode alone
   and refuses to continue if it is not a root-owned directory without group or
   other write. It redirects its own stdin from `/dev/null`, so no command it
   runs can read further piped input.
2. **Arguments.** Checks the exact argument contract in 6.2 before anything
   else. A cut-short download or an unknown flag stops here.
3. **Facts, read-only.** `/etc/os-release` `ID` and `VERSION_ID`, `uname -m`, CPU
   count, `MemTotal`, `hostname`, `systemd-detect-virt`, `pveversion` if present,
   and the effective sshd settings for user `hivra` from `sshd -T -C
   user=hivra,host=hivra-check,addr=192.0.2.1` (port, `authorizedkeysfile`,
   `pubkeyauthentication`, `allowusers`/`allowgroups`/`denyusers`/`denygroups`,
   and the Ed25519 `hostkey` path). The address is a documentation address, not
   loopback, because loopback often has its own permissive `Match Address`
   block. Hivra's real source addresses change, so no single address evaluates
   the rules Hivra will meet. The script therefore also reads the `Match` lines
   of `/etc/ssh/sshd_config` and `/etc/ssh/sshd_config.d/*.conf` and, if any
   names `Address`, `Host` or `LocalAddress`, prints: "This server's SSH
   settings have rules for particular addresses. Hivra connects from changing
   internet addresses, so make sure hivra can sign in from any address." It
   reports only a `sshMatchRules: true|false` flag. Each value must match a
   strict pattern, or it is sent as null. Nothing else is read: no interface
   addresses, MAC addresses, machine-id, user lists or files outside those
   listed.
4. **Host key.** Takes the host key from the Ed25519 private key that sshd
   actually uses (`ssh-keygen -y -f <hostkey path>`), so the key reported is the
   key sshd presents. No Ed25519 host key: stop, and say so.
5. **Terminal.** Tries to open `/dev/tty` for reading and writing. If that
   works, the script has a terminal and **always** asks in step 8, whatever
   flags were passed. `--yes` counts only when `/dev/tty` cannot be opened. With
   no terminal and no `--yes`, it stops before sending anything: "This needs a
   terminal to ask you first. Run it in a terminal, or add `-s -- --yes` if you
   are automating it." `--dry-run` never asks, because it changes and sends
   nothing.
6. **Unsupported servers.** If the server is not Ubuntu 22.04/24.04 x86_64 or
   Proxmox VE 8/9 x86_64, it prints what it found and the rebuild instruction
   (INF-05 copy) locally, then asks on the terminal: "Send these facts to the
   Hivra account sam***@example.com so it shows the same instructions? [y/N]".
   Only a yes (or `--yes` with no terminal) sends an `unsupported` report
   (facts only, no host key, no user), which spends the code. A no sends
   nothing, and the code stays valid until it expires. Hivra re-checks support
   against the same shared rules, and Hivra's answer wins.
7. **Requirements**, without changing anything. Otherwise it stops with one
   plain sentence, sends nothing, and the code stays valid for a re-run:
   - `sudo` installed. Proxmox VE ships without it: "This server doesn't have
     sudo. Install it with `apt install sudo`, then run the command again."
   - sshd would let `hivra` sign in with a key (no `AllowUsers`/`AllowGroups`
     that excludes it, public-key auth on, `authorizedkeysfile` a supported
     `%h`/`%u` pattern).
   - No `hivra` user exists, or the one that exists has Hivra's marker
     (`/etc/hivra/enrollment.json`). A foreign `hivra` user is never taken
     over. A Hetzner server Hivra created has no marker, so it is refused and
     sent back to its Hetzner card.
   - No `/etc/sudoers.d/hivra-enrollment`, or one byte-identical to what Hivra
     writes.
8. **Consent.** Prints the plan (section 4), including the receiving account
   from the final line, and asks `Continue? [y/N]` on `/dev/tty`. Default is No.
   Without a terminal, `--yes` stands in for the answer, and the plan is still
   printed to stderr first.
9. **User.** `useradd --create-home --user-group --shell /bin/bash --comment
   Hivra hivra`, then `usermod -p '*' hivra`. That makes password sign-in
   impossible while keeping key sign-in valid when sshd has `UsePAM no`; a `!`
   lock would block keys there. This is the same shape as the Hetzner cloud-init
   user (`lock_passwd: true` there).
10. **Key.** Writes exactly one line to hivra's authorized keys file (mode 0600,
    owner hivra): `restrict ssh-ed25519 <Hivra's public key> hivra-enrollment`.
    `restrict` turns off port, agent and X11 forwarding and PTYs. The Hivra
    runner uses only non-PTY `exec` today (`proxmox-instance-service.ts:1649`).
    A future feature that needs more must bump the script version.
11. **Sudo.** Writes `/etc/sudoers.d/hivra-enrollment` (`hivra ALL=(ALL:ALL)
    NOPASSWD: ALL`, the cloud-init rule) to a temporary file, checks it with
    `visudo -cf`, then installs it as 0440 root:root with a rename. It never
    edits `/etc/sudoers`. The file name has no dot, because sudo skips such
    files.
12. **Marker.** Writes `/etc/hivra/enrollment.json` (0644, root, no secrets) with
    `status: "pending"`, script version, origin, admin-key fingerprint, host-key
    fingerprint and time.
13. **Report.** Sends one HTTPS report (section 7) over IPv4 (`curl --ipv4`).
    At most 6 attempts in 90 s, retrying only 408, 429, 5xx and network errors,
    with the same body each time. A retry after a lost response gets the same
    acknowledgement, because an identical replay is acknowledged (section 5).
    If no IPv4 attempt can connect at all and the server has a global IPv6
    route, it sends one attempt over IPv6 so Hivra can refuse it with a clear
    reason (`ipv4_required`, 10.4).
14. **Outcome.** On `accepted`: sets the marker to `status: "reported"` with the
    enrollment id and time, disarms the rollback, and prints the words. The
    marker never says "connected": the server is not told whether the owner
    said Yes (6.6). On a definite refusal (400, 401, 422) or when every attempt
    failed: rolls back steps 9-12 of this run and prints the reason. For the
    no-answer case the text is: "Hivra didn't confirm it received this server's
    report, so this server undid every change. If Hivra asks "Is this your
    server?" about this server, choose No, then run a new command."

It installs no packages and changes no firewall, sshd configuration, services,
timers or cron. It leaves nothing running, and contacts only the one origin
named in its last line.

### 6.2 Served form, integrity and "view the script first"

The script is one file in the repo, `dashboard/bootstrap/server-enroll.sh`. It
is the **body**: function definitions only, with no other top-level statement,
so running it alone does nothing. Its sha256 is a constant next to its version
(`SERVER_ENROLL_SCRIPT_VERSION`, date-based like `FIRST_BOOT_RECIPE_VERSION`).
The route refuses to serve if the file on disk hashes differently (as
`loadEnrollmentHelper` does), and a test fails if the version and sha256 are
not bumped together. The file joins `outputFileTracingIncludes` for the
`/enroll` routes.

Every response is the body plus **one final line**. The caller's own arguments
come first, the fixed values after them, and a sentinel last:

```
hivra_enroll_entry "$@" HIVRA_ARGS_V1 'https://hivra.cloud' 'hse1_<32 base32 characters>' 'ssh-ed25519 <68 base64 characters>' 'sam***@example.com' HIVRA_END_V1
```

| Route (GET, no session) | Final line |
| --- | --- |
| `/enroll` with a usable code in `Authorization` | `hivra_enroll_entry …` as above |
| `/enroll` with no code, or an unknown, expired, used or cancelled code | `hivra_refuse 'expired_or_used'` (or `'missing_code'` when no header was sent), which prints one sentence and exits 1. The body and line are byte-identical for every unusable code. A cut-short refusal line can only fail to print. |
| `/enroll/uninstall` | `hivra_uninstall_entry "$@" HIVRA_END_V1` |
| `/enroll/script` | none: the bare body, `text/plain`, to read |
| `/enroll/script.sha256` | the body's sha256 |

**The argument contract.** `hivra_enroll_entry` accepts exactly: zero, one or
two caller flags, each `--dry-run` or `--yes` and neither repeated; then the
literal `HIVRA_ARGS_V1`; then four values, each matching its pattern below; then
the literal `HIVRA_END_V1` as the last argument. The argument count must be the
number of caller flags plus 6. `hivra_uninstall_entry` accepts zero or one
caller flag (`--dry-run` or `--yes`) followed by `HIVRA_END_V1`, and nothing
else. Anything else prints "This setup script arrived incomplete or was run with
options it doesn't know. Nothing was changed. Copy the command from Hivra again."
and exits 2 before reading any fact.

**Why a cut can't run anything.** bash runs each complete top-level command as
it reads it, and runs a final line that has no newline when input ends. `curl`
closes the pipe on a network error, so bash sees whatever prefix arrived. The
body holds only function definitions, so a cut inside it defines some functions
and runs none, or leaves an unclosed definition that bash rejects. For every
byte prefix of the final line, one of three things happens:

- the cut lands inside a quoted value or inside `"$@"`, and bash refuses an
  unterminated quote;
- the cut lands inside the function name, which then names no command (the body
  defines no function whose name is a proper prefix of an entry function, and a
  test pins that);
- the entry function runs with a shorter argument list, whose last argument is
  not `HIVRA_END_V1`, and it refuses.

Because `"$@"` comes before the fixed values, no cut can drop a caller's
`--dry-run` while keeping the fixed values. The earlier draft put `"$@"` last,
so a cut just before it turned `… | sudo bash -s -- --dry-run` into a real run.

Other properties:

- **The same for everyone.** The body does not vary with requester, User-Agent,
  timing or code, so it can be checked against the public repo. Only the final
  line differs, and it holds four values, each checked against a strict pattern
  before rendering: origin (`trustedAppOrigin()`), code (`^hse1_[a-z2-7]{32}$`),
  key (`^ssh-ed25519 [A-Za-z0-9+/]{68}$`) and account label
  (`^[a-z0-9]{1,3}\*\*\*@[a-z0-9.-]{1,253}$`, or the fixed text `your Hivra
  account`). None can contain a quote, so single-quoting is exact. Rendering
  throws instead of escaping. The entry function checks the same patterns again.
- **Verifiable in a few commands.** "View the script first" shows the body, its
  version and sha256 (also in the repo and at `/enroll/script.sha256`), the
  final line for this command, and the sha256 of the whole download for this
  command (computed at issue). Then:

  ```
  d=$(mktemp -d) && cd "$d"
  curl -fsS --proto '=https' -H 'Authorization: Bearer hse1_…' https://hivra.cloud/enroll -o hivra-enroll.sh
  sha256sum hivra-enroll.sh                 # matches "your download" in Hivra
  head -n -1 hivra-enroll.sh | sha256sum    # matches the published script
  less hivra-enroll.sh
  sudo bash hivra-enroll.sh
  cd / && rm -rf "$d"                       # the file holds your one-time code
  ```

  The page says above the recipe: "The downloaded file contains your one-time
  code. Delete it when you're done. The code stops working once it's used, and
  after 15 minutes." Downloading does not spend the code. The saved file is a
  residual risk (section 14, remaining risks).

- **`--dry-run`** (`… | bash -s -- --dry-run`, no sudo needed) prints the plan,
  the exact key line and sudoers line, and the exact report it would send. It
  changes nothing and sends nothing. Without root, it says which checks it
  skipped.

Response headers on every `/enroll*` route: `Content-Type: text/plain;
charset=utf-8`, `Cache-Control: no-store, private`, `Referrer-Policy:
no-referrer`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex`. There
are no redirects. The command uses `--proto '=https'` and no `-L`, so curl never
follows an unexpected redirect.

### 6.3 How the code is handled on the server

With the piped command, the code exists in the user's shell history and, for
about a second, in the argv of the `curl` they ran. After that, it lives only in
bash memory. The report goes through `curl --config <(printf …)` and
`--data-binary @<(…)`, so the code is in no process's argv or environment and
the piped path never writes it to disk. The marker holds no secret. The
residual risk is shell history and the brief `ps` window. Both expire with the
code, which is spent seconds later. The view-first recipe (6.2) does write the
code to a file, and tells the user to delete it.

### 6.4 Checking values without escaping them

The script never uses `eval` and never sources server output. It builds the
report JSON with `printf` only from values that already matched a strict
pattern: hostname `^[A-Za-z0-9.-]{1,253}$`, OS id `^[a-z0-9._-]{1,64}$`,
version `^[0-9][0-9.]{0,15}$`, integers `^[0-9]{1,15}$`, the key pattern above.
It never escapes anything. The acknowledgement is fixed-format text lines
(section 7), checked line by line. It prints only characters those patterns
allow, so a response cannot send terminal escape sequences.

### 6.5 Rollback

After the first change, a `trap` records each change this run made. If the run
does not reach `accepted`, the trap removes the sudoers file it wrote, deletes a
`hivra` user it created (`userdel -r`), or restores the previous authorized-key
contents of a re-enrolled user, and removes a marker it created or restores the
previous one. It removes `/etc/hivra` only if this run created it and it is now
empty. If the rollback itself fails, the script prints the exact commands to
finish it and the uninstall command. A key left on a server is useless once the
row expires, because the sealed private key is wiped.

### 6.6 Running it again, and what the server can know

The server only ever learns whether Hivra **accepted its report**. It is never
told whether the owner said Yes, No, or let the question expire. So the marker
has two states, `pending` (written just before the report) and `reported`
(after `accepted`), and the script's words never go beyond that.

On a server with Hivra's marker, the prompt adds one of:

- `reported`: "Hivra's setup command already ran on this server on 20 Sep 2026
  and reported to https://hivra.cloud. This server can't tell whether that Hivra
  account confirmed it. Continuing replaces the hivra user's key with this
  account's, so any earlier access stops working."
- `pending` (a run that stopped between writing the marker and finishing its
  rollback): "An earlier Hivra setup on this server (20 Sep 2026) didn't finish.
  Continuing replaces what it left."

The script replaces the whole authorized-keys file with the new key and leaves
the sudoers file alone if it is byte-identical. If the previous connection still
exists, it then fails to sign in, and Hivra maps that failure to "Hivra's key
was removed from this server. Run a new setup command to reconnect." In the same
account, confirming a server whose pinned identity matches an existing
connection updates that connection's key (its revision goes up and its evidence
is superseded) instead of making a duplicate.

Two cases where the server and Hivra show different things, named so the copy
stays true:

1. **No, or expiry, after an accepted report.** The server keeps the `hivra`
   user, its sudoers file and a `reported` marker. Hivra has deleted the private
   key, so the key on the server can't be used. Hivra's No and expiry copy
   gives the uninstall command. A later run on that server shows the `reported`
   text above, which says only what the server knows.
2. **A lost acknowledgement.** Hivra accepted the report, but all six responses
   were lost. The server rolled back, and the terminal printed the no-answer
   text from step 14 and no words. Hivra shows "Is this your server?" with words
   the terminal never printed. The card says to choose No in that case. If the
   owner chooses Yes anyway, the first sign-in fails because the key is gone,
   and the card says: "Hivra couldn't sign in as hivra. The server may have
   undone the setup. Run a new setup command."

### 6.7 Uninstall

`curl -fsS --proto '=https' https://hivra.cloud/enroll/uninstall | sudo bash`
serves the same pinned body with the uninstall entry. It needs no code and
contacts no one. It supports `--dry-run` and asks before changing anything
(the same terminal rule as 6.1 step 5). It refuses to act unless the marker is
present. It ends hivra's sessions (`loginctl terminate-user`, then `pkill -u
hivra`), runs `userdel -r hivra`, removes `/etc/sudoers.d/hivra-enrollment` only
if it is byte-identical to what Hivra writes, and removes the marker. It leaves
`/etc/hivra` in place, because Prepare may have put other files there. It then
says plainly what it left: "Software that Prepare installed (Docker, gVisor,
Proxmox settings) is not removed. Remove agents' computers in Hivra first."
Hivra learns of the uninstall only when its next sign-in fails. **Disconnect**
in Hivra deletes the private key whether or not the uninstall ran, and shows the
uninstall command.

## 7. The report callback

`POST /api/infrastructure/server-enrollments/report`: a machine route with the
same hardening as the first-boot receiver.

- The middleware exclusion is an exact path in both matcher entries. The
  `/enroll`, `/enroll/uninstall`, `/enroll/script` and `/enroll/script.sha256`
  exclusions go in the page matcher. `proxy-config.test.ts` pins that siblings
  and child paths stay covered.
- No query string. A request carrying a browser `Origin` or `Sec-Fetch-Site` is
  refused (403). `Authorization: Bearer hse1_…` only, checked against its
  pattern before any database read. Strict `application/json`, no
  `Content-Encoding`, 2 KB body limit, 5 s read deadline.
- Body (`.strict()` schema):

  ```json
  {"version":1,"scriptVersion":"2026.09.24.1","kind":"enrolled",
   "consent":"terminal",
   "hostPublicKey":"ssh-ed25519 …","adminKeyFingerprint":"SHA256:…","sshPort":22,
   "reenrollment":false,
   "facts":{"hostname":"ip-172-31-4-9","osId":"ubuntu","osVersionId":"24.04",
            "architecture":"x86_64","cpuCount":4,"memoryBytes":16729309184,
            "virtualization":"kvm","proxmoxVersion":null,"sshMatchRules":false}}
  ```

  `kind:"unsupported"` sends null `hostPublicKey`, `adminKeyFingerprint` and
  `sshPort`. `consent` is `terminal` or `no_terminal`. It is reported by the
  server, so the card shows it under "Reported by the server".
- Order of checks: code pattern → IP rate limit → look up `code_sha256` →
  per-code limit → schema → `scriptVersion` on the allowlist (current and
  previous release) → `adminKeyFingerprint` equals the row's key → host key
  through `canonicalEd25519HostKey` → observed address (10.1): IPv6 refused with
  `ipv4_required`, reserved ranges refused with `private_address` → support
  re-check → account checks (section 5) → one SQL transition. SQL rechecks
  phase and expiry at commit, stores the report and its digest, chooses three
  words from a fixed 256-word list with `crypto.randomInt`, and appends a
  `reported` event.
- Responses, as `text/plain` lines:

  ```
  HIVRA_ENROLLMENT v1
  status=accepted
  enrollment=<uuid>
  words=amber-falcon-river
  host=SHA256:<43 characters>
  ```

  Other statuses are `status=unsupported` (200), `private_address` (422,
  "Hosted Hivra can't reach servers on private networks. Nothing was kept."),
  `ipv4_required` (422, "Hosted Hivra can only reach servers over IPv4 for now.
  Give this server a public IPv4 address, then run a new command. Nothing was
  kept."), `invalid_report` (400) and `not_usable` (401: unknown, expired, used
  or cancelled codes, and a changed body after a report; the same bytes every
  time). A 429 or 503 means try again. The script rolls back on 400, 401 and
  422. A 422 does not spend the code; it counts as a refused report (section 11)
  and records the refusal class and time on the row, so the panel can say what
  happened. No address is stored for a refused report.
- Log fields are an allowlist only: failure class, script version, a
  public/private/IPv6 address class. The code, headers, body, keys and address
  are never logged.

## 8. "Is this your server?" and trust on first use

The report proves only that someone holding the code, with root on some
machine, answered within the window. It does not prove the machine is the
owner's. So a report makes nothing trusted:

- Before Yes, Hivra opens no SSH connection, creates no connection row, and
  runs nothing.
- The card separates "Connected from (seen by Hivra)", which Hivra observed,
  from "Reported by the server", which a malicious server could forge. It also
  shows the three words and the identity fingerprint. When Hivra did not see a
  usable address (10.1), the first row says "Hivra couldn't see this server's
  address" and the owner must enter one.
- **Unsupported reports get the same framing.** The card says: "A server used
  your setup command from 203.0.113.24 and reported Ubuntu 20.04 on x86. Hivra
  doesn't support that yet: [rebuild instruction]. If you didn't run the
  command, someone else has it. That command no longer works, and nothing was
  connected. [Get a new command]". A leaked code can make an owner see this
  card for a server they don't own; the framing says so rather than presenting
  it as the owner's server.
- **Yes** is an owner-session, same-origin POST. In one SECURITY DEFINER
  transaction it: locks the row; checks the owner, `reported` phase, `confirm_by`
  and expiry; re-runs the account checks (section 5); applies the duplicate-host
  rule (6.6); inserts the `host` connection (`ssh_host` = observed or
  owner-edited address, `ssh_port` = reported port, `ssh_user` = `hivra`,
  `ssh_privilege` = `sudo`, pinned fingerprint = reported host key, host-key
  type `ssh-ed25519`) with its secret bundle, which the app re-seals from the
  enrollment's key under the connection-secret format; moves the enrollment to
  `confirmed` with `connection_id`, nulls its sealed key, and appends events.
  The normal inspection then starts.
- **The first SSH connection must present exactly the reported key.** The
  runner restricts `serverHostKey` to `ssh-ed25519` for connections that
  recorded that key type, as `first-boot-ssh.ts:307` does. On a mismatch, no
  authentication or command is sent, and the card shows both fingerprints side
  by side.
- This is not network trust-on-first-use. The host key reached Hivra over TLS,
  from a process that proved it held the code and root on that machine. The
  owner then approved it. Hivra never accepts a key it only saw on the network
  (`accept-new`), which the first-boot design also forbids.
- "Use a different address" accepts only what the manual wizard accepts (SSRF
  rules in section 10). The pinned key still decides identity. Pointing it at a
  server that did not run the script fails at key check or at sign-in.
- **No** moves the row to `rejected`, wipes the sealed key, logs the event, and
  shows the uninstall command.

**Advanced wizard (INF-14, same rule).** "Connect with SSH details instead" gains
a passphrase field. The key is decrypted once and stored in the existing sealed
bundle; the passphrase is never stored. It also gains a sudo-user option and
trust on first use. Hivra opens a connection to the validated destination only
to capture the presented Ed25519 key: the verifier records it and refuses, so no
authentication or command follows. Hivra shows the fingerprint with Copy and
per-provider "where to find this" links (AWS system log, Hetzner and
DigitalOcean consoles). It pins only after the owner confirms, and on a mismatch
shows both values. This path does have a first-contact interception risk, which
the fingerprint comparison covers and the command path does not have.

## 9. Privilege: passwordless sudo in discovery, gVisor and Proxmox

Today privilege means "the SSH login is UID 0". Target: a connection can also
reach UID 0 through passwordless `sudo`. Existing root connections keep
today's behaviour, byte for byte where noted.

### 9.1 Connection field

`infrastructure_connections.ssh_privilege text not null default 'login' check
(ssh_privilege in ('login','sudo'))`. `login` runs host scripts as the SSH user,
exactly as today. `sudo` runs every host script through the transport in 9.2.
Existing rows keep `login`. The field is one of the revision-bound operational
fields in `update_infrastructure_connection`: changing it raises the revision
and supersedes discovery, preflight and target evidence.

### 9.2 Sudo transport in the runner

`buildUserProxmoxEnvironment` passes `PROXMOX_SSH_PRIVILEGE=sudo` for such
connections. `runProxmoxHostInvocation` uses the sudo transport only when
`HIVRA_USER_INFRA_CONNECTION=true` and that variable is `sudo`. The managed
fleet never sets it, and `login` connections keep today's exact commands.

In sudo mode, both `runProxmoxHostScript` and `runProxmoxHostScriptWithStdin`
send one command, the same for every operation except the whole-second limit
`<N>`:

```
/usr/bin/sudo -n -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C HOME=/root /usr/bin/timeout --signal=TERM --kill-after=1s <N>s /bin/bash --noprofile --norc -c '<LOADER>'
```

`<LOADER>` is a fixed string of about 150 bytes. It sits inside single quotes
in the command above, so it contains no single quote (a test pins that):

```
printf "HIVRA_SUDO_V1\n" >&2; IFS= read -r n && [[ $n =~ ^[1-9][0-9]{0,5}$ ]] && IFS= read -r -d "" -n "$n" s && [ "${#s}" -eq "$n" ] && eval "$s"
```

and stdin carries `<byte length of the script>\n<script><data>`. `data` is the
separate stdin of `runProxmoxHostScriptWithStdin`, and empty for
`runProxmoxHostScript`. bash's `read` takes a pipe one byte at a time, so the
loader consumes exactly the script and leaves the data for the script to read.
With `LC_ALL=C`, `-n` counts bytes, and `-d ""` (stop at NUL) never triggers
because the runner refuses a script with a NUL byte; this form works in every
bash since 3.2. The length prefix allows up to 999,999 bytes. The stdin form
keeps its 96 KB script limit. The plain form has no limit today; gVisor
Prepare, for example, sends about 44 KB (an 8 KB script plus the base64 of a
27 KB adapter). A runner test measures every host script Hivra sends over the
sudo transport against the limit. A local prototype of this framing (a
heredoc, `exit 3`, and 200 KB of data read by the script) behaved as described
while writing this; the runner tests in section 15 are the real check.

How this lines up with the first-boot runner (`first-boot-ssh.ts:333`), and why
it differs:

| First-boot runner | Sudo transport | Why |
| --- | --- | --- |
| `sudo -n`, `env -i`, fixed `PATH`, `LC_ALL=C`, `bash --noprofile --norc` | Same | Same reasons: no password prompt, no inherited environment, no profile |
| No `HOME` | `HOME=/root` | Host scripts run today in root's login environment, where `HOME=/root`. Docker and Proxmox tools read it. Keeping it avoids a behaviour difference between `login` and `sudo`. |
| `timeout … 8s` under a 10 s local deadline | `<N>` = local timeout in whole seconds minus 2, at least 1 | The remote process never outlives Hivra's own deadline, as in first boot. Host scripts run from 60 s to 20 minutes, so the limit follows the call. |
| `bash -s`, recipe on stdin | `bash -c '<LOADER>'`, script and data on stdin | The stdin form needs a data stream after the script. A length prefix keeps both on stdin and keeps every script out of argv. |
| Any failure maps to `command_failed` | Missing `HIVRA_SUDO_V1` on stderr plus a non-zero exit means sudo itself refused | One sudo call per operation still tells "sudo needs a password" apart from a script failure. This replaces the earlier draft's separate `sudo -n true` pre-check, which logged a second line per operation. |

The runner removes the `HIVRA_SUDO_V1` line before callers see stderr. A
refusal maps to the privilege outcome (9.4) with the copy "Hivra signed in as
hivra, but sudo asked for a password." The earlier draft's wrapper had no
`env -i`, no fixed `PATH` and no remote limit; this replaces it.

**Early finish under sudo.** Proxmox provisioning resolves on a marker and
leaves a `nohup … &` child running in the same session (section 2). Under
`timeout`, the child survives as long as the script itself exits before the
limit, because `timeout` signals its process group only when the limit is
reached. Under sudo, the child also lives inside sudo's session: current Ubuntu
and Debian sudoers files set `Defaults use_pty`, so sudo runs the command on its
own pseudo-terminal and closes it when the command exits, and the SSH channel
closes as soon as the runner has its marker. Before Proxmox provisioning is
allowed over sudo, the disposable-runner test (section 15) must show that a
`nohup … &` child started inside this exact command survives the runner closing
the channel after the marker, with `use_pty` on and off. If it does not,
Proxmox preflight refuses `sudo` connections ("Proxmox launches need a root
login for now") until the provisioner detaches its child with `setsid`, which is
a provisioner version change. gVisor and discovery do not use early finish.

### 9.3 Sudo logging and what other users can see

`sudo` records each command line in the server's auth log, and any local user
can read a running process's argv with `ps`. Today
`runProxmoxHostScriptWithStdin` puts the whole script body into argv. Under
sudo that would copy up to 96 KB into auth.log on every gVisor identity guard
and computer operation. The earlier draft's rule ("secrets on stdin, never in a
script body") was also wrong for `runProxmoxHostScript`, whose body already
travels on stdin; Proxmox provisioning puts model and tunnel secrets in that
body (`api/hivra/agents/route.ts:560-570`), and that is safe only because the
body is on stdin.

So in sudo mode, **every script body and every data stream travels on stdin**,
and argv holds only the constant command above. sudo logs one constant line of
about 400 bytes per operation, and Ubuntu's PAM configuration adds a session
opened and a session closed line. Operations are owner-driven: inspection,
Prepare, preflight, launch, opening a computer's status, running a command,
start, stop, resize and delete. Nothing polls in the background today (verified:
`observeGvisorComputer` and `executeGvisorComputerCommand` are called only from
`api/hivra/agents/[id]/gvisor/**`). Hivra does not change the server's logging.
The log is the owner's record of what Hivra did, and the uninstall removes the
rule that lets Hivra act. An administrator who has turned on sudo I/O logging
records Hivra's stdin, including the data it carries; that is their own
server's policy.

### 9.4 Discovery and outcome copy

**Discovery.** Under `sudo`, the unchanged discovery script runs through the
transport, reports EUID 0, and every root-based requirement is computed as
before. Under `login` with a non-root user, the script adds one read-only probe:
`timeout 5 sudo -n -- /usr/bin/id -u`, only when `sudo` exists. This becomes
`environment.passwordlessSudo`. When sudo asks for a password, the probe fails at
once, and the server's auth log records one failed sudo attempt; the outcome
copy says Hivra checked.

The snapshot also records `environment.privilegeVia: "login" | "sudo"` from the
connection. These fields make `HOST_DISCOVERY_CONTRACT_VERSION` 2:

- The TypeScript schema accepts `contractVersion` 1 or 2. A v1 snapshot has no
  `privilegeVia` and is read as `privilegeVia: "login"`. That is exact: v1
  snapshots were all taken over the SSH login, because no sudo path existed.
  v2 requires both new fields.
- The same migration widens the `contract_version` check to `in (1, 2)` and
  changes `complete_infrastructure_host_discovery` to accept `'1'` or `'2'`,
  to require `privilegeVia` in a v2 snapshot, and to refuse a v2 snapshot whose
  `privilegeVia` differs from the connection's `ssh_privilege` at commit. Old
  code never writes v2, and v1 rows expire within 15 minutes of the deploy.
- The Hetzner provider-lane snapshot (connection provider `hetzner-cloud`,
  checked in `20260828030000_provider_computer_preparation.sql:67`) is a
  different contract. It always runs through sudo and is not changed.

**Outcome copy** (privilege stays the first blocker, INF-04):

- with passwordless sudo: "ubuntu can use sudo without a password. **[Use sudo
  for setup]**", an owner action that updates the connection (revision bump)
  and inspects again;
- without: "Signed in as ubuntu without passwordless sudo. Run the setup command
  with sudo, or connect as a user who has it."

The nested-KVM message never appears when privilege is the blocker.

### 9.5 gVisor

There are two rules, because the three `sshUser === "root"` checks guard
different stages.

**Runtime authority** (`gvisor-computer-service.ts:137`, every operation on an
existing gVisor computer). `hasRuntimeHostAuthority(connection)` is true when
the connection is a `host` connection and either `ssh_privilege = 'login'` with
user `root`, or `ssh_privilege = 'sudo'`. The existing revision-bound target
evidence checks (`normalAuthority`, `isGvisorPendingBoundObservation`) stay
exactly as they are. **No discovery snapshot is read here, as today.** An
existing root-host computer therefore keeps working however long ago its host
was last inspected. Because `ssh_privilege` is revision-bound, changing it
raises the revision and the existing `evidence_connection_revision` check stops
normal operations until preflight runs again. The pending-bound status and
delete path keeps working under the new privilege, as it does today after a key
edit.

**Preflight and prepare** (`gvisor-target.ts:75, 88`; `gvisor-computer-service.ts:232`).
`hasHostAdministratorAuthority(connection, snapshot)` is the runtime rule plus a
current snapshot for this connection revision whose `privilegeVia` equals the
connection's `ssh_privilege` (v1 counts as `login`) and whose
`effectivePrivilege` is `root`. Preflight already reads that snapshot today;
only the `privilegeVia` match is new. Prepare does not read one today, but its
route runs preflight straight afterwards, and preflight does. Checking before
Prepare moves an existing failure (install, then "Inspect this Linux host again")
to before anything is installed. No flow that succeeds today fails.

The adapter identity guard, including its `root:root` ownership checks, is
unchanged, because it runs as root through the transport. The copy "A gVisor
target requires a root Linux host connection" becomes "Linux Sandbox needs root
or passwordless sudo on this server."

### 9.6 Proxmox

Preflight's `id -u` check is unchanged (0 through the transport). The
`PROXMOX_PERMISSION_UNAVAILABLE` remediation becomes "connect as root, or as a
user with passwordless sudo", subject to the early-finish gate in 9.2. Enrolling
a PVE node uses a local `hivra` user, not a key for root. On PVE,
`/root/.ssh/authorized_keys` usually links to the cluster-shared
`/etc/pve/priv/authorized_keys`, so a root key would grant every node in the
cluster.

Hivra gets full administrator access either way. A sudoers rule narrower than
`ALL` would be for show, because Hivra's fixed scripts run through `bash`. The
command page, the terminal prompt and the confirmation card all say
"administrator (sudo) access".

## 10. Network boundary: SSRF, the observed address, home machines

### 10.1 The observed address

The address on the card comes from the platform's own client address, never
from the report or from `getIP()`. A new `trustedClientAddress(request)` reads
**one** header, named per deployment:

- **Vercel:** `x-vercel-forwarded-for`, which Vercel's request-header
  documentation says it sets from the connecting client and overwrites on every
  request (confirmed only by the Canary spoof check in 18, not yet here). The value must be exactly one address (no comma
  list), or it is treated as missing. `cf-connecting-ip`, `x-real-ip` and a
  client-supplied `x-forwarded-for` are ignored.
- **Cloudflare in front of Vercel.** If the origin hostname is proxied by
  Cloudflare, Vercel's TCP peer is a Cloudflare edge address, so
  `x-vercel-forwarded-for` names Cloudflare, not the server. The card and the
  SSH target would then be wrong. `cf-connecting-ip` can't be used instead,
  because the Vercel deployment is also reachable without Cloudflare, where a
  client can set that header. So Hivra keeps Cloudflare's published IPv4 and
  IPv6 ranges as a constant (with its source and date in the code) and treats
  an observed address inside them as missing. The card then says "Hivra couldn't
  see this server's address" and the owner must enter one. Whether Canary or
  production is proxied was not checked; the acceptance run checks it (18).
  The ranges constant can go stale, which is listed as a remaining risk.
- **Self-hosted:** the deployment names its trusted header in configuration.
  With none configured, there is no "seen by Hivra" row, and the owner enters
  the address.

### 10.2 Checks

At report and again at Yes: `net.isIP` must be 4 (10.4), and
`reservedAddressReason` must be null. Private and CGNAT ranges are allowed only
with the self-host `HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS=true`. Loopback,
unspecified, link-local and metadata addresses are always refused. Every later
SSH connection goes through `resolveValidatedSshDestination`, as today.

### 10.3 Nothing reported is fetched

The hostname is display-only and is never looked up in DNS. The port is an
integer used only for SSH to the observed or owner-entered address. Hivra makes
no HTTP request to anything the server reported. The script contacts only the
origin in its last line (`https:`, a validated hostname, from
`NEXT_PUBLIC_APP_URL`), with curl's normal certificate checks,
`--proto '=https'`, `--max-redirs 0`, never `-k`.

### 10.4 IPv4 only

Vercel functions have no outbound IPv6 (a review finding, not re-verified
while writing this), so hosted Hivra can't SSH to an IPv6-only server; it would
fail predictably after Yes. The script reports over
IPv4 (6.1 step 13), and a report that arrives over IPv6 is refused with
`ipv4_required` and its copy, in the terminal and on the panel. Nothing is kept.
A dual-stack server whose IPv4 path works is unaffected. Self-hosted
deployments follow the same rule in this slice. Re-check the Vercel constraint
before relaxing it.

### 10.5 Home and private networks

A home machine calls back from its router's address. On hosted Hivra, a private
or CGNAT address is refused at report and the script rolls back. A public
router address passes, but after Yes the SSH connection fails. The card then
says: "Hivra couldn't reach 203.0.113.24 on port 22. Allow SSH from the internet
in your provider's firewall (on AWS, the security group), then check again.
Home or office machines aren't supported yet." Hivra's functions connect from
changing addresses, so the firewall must allow SSH from anywhere. Key-only
sign-in and the `restrict` option make that acceptable, and the page says it
plainly.

`sshd` rules for particular addresses (`Match Address`) can still block Hivra's
sign-in even though the script found none that blocked a documentation address
(6.1 step 3). An authentication failure right after Yes on a server that
reported `sshMatchRules: true` gets: "Hivra reached the server but couldn't sign
in as hivra. This server's SSH settings have rules for particular addresses;
allow hivra from any address, then check again."

### 10.6 Before showing a command

The panel checks that the report endpoint answers the constant 401 JSON. That is
the `isFirstBootCallbackReachable` pattern, so a preview behind deployment
protection shows "Setup commands aren't available on this deployment" instead
of a command that can't work.

## 11. Rate limits

The in-memory limiter is per serverless instance, and its IP key can be spoofed
(section 16). It only sheds load. The real bounds are durable and live in SQL.

| Surface | Best-effort (memory) | Durable (SQL) |
| --- | --- | --- |
| Issue a code | 10/min per user and IP | ≤ 3 active per user, taken under a per-user advisory lock; ≤ 30 issued per user per 24 h |
| `GET /enroll` | 60/min per IP; bad format answered without a database read | ≤ 20 script fetches per code, after which the refusal script is served |
| Report | 30/min per IP (as first boot); 12/min per code after the format check | One accepted report per code; after 10 refused reports (including 422s), the code is cancelled ("Get a new command") |
| Status poll | 120/min per user | — |
| Yes / No / cancel | 20/min per user | Row lock; one outcome |
| Advanced key capture (8) | 10/min per user | — |

429 responses carry `Retry-After`, and the UI turns it into "You can try again
in N minutes" (`retry-after-copy.ts`).

## 12. Audit receipts and retention

`infrastructure_server_enrollment_events` is append-only for its lifetime: no
role can update or delete an event row. Each row belongs to one enrollment
(`enrollment_id … references infrastructure_server_enrollments (id) on delete
cascade`) and is removed only together with that enrollment, by the retention
sweep or account deletion below. Kinds: `issued`, `script_served` (counted, not
one row per fetch), `refused_report` (counted), `reported`, `unsupported`,
`confirmed`, `rejected`, `cancelled`, `expired`, `connection_created`,
`identity_mismatch`. Each row holds the enrollment id, user id, time, actor
(`owner` or `server`), script version, the observed address for `reported`, and
the host fingerprint where relevant. No row holds the code, its hash, a key or
the report body.

The owner sees these on the connection card: "Connected with the setup command
on 24 Sep at 12:04 from 203.0.113.24 · identity SHA256:Xb…9Q · confirmed by you
at 12:05."

**Retention** (the only ways enrollment rows and their events, including
observed addresses, are deleted):

| Row | Kept until |
| --- | --- |
| Ended without a connection (`unsupported`, `rejected`, `cancelled`, `expired`) | 30 days after it ended (`decided_at`, or `expires_at` for expiry) |
| `confirmed`, connection still exists | While the connection exists: it is the connection's identity receipt |
| `confirmed`, connection removed | 90 days after the sweep first sees `connection_id` null (`connection_id … on delete set null`; the sweep sets `connection_removed_at`, so no trigger is added to `infrastructure_connections`) |

The sweep is one SECURITY DEFINER function, `sweep_server_enrollments(p_now)`.
It marks expiry, wipes sealed keys, sets `connection_removed_at`, and deletes
rows past retention (their events go by cascade). It runs daily from a cron
route in the pattern of `src/lib/ops/activity-retention.ts`, and it is on by
default, because it deletes only rows that never became or no longer back a
connection.

**Account deletion** adds `infrastructure_server_enrollments` (by `user_id`) to
`ACCOUNT_DELETION_TABLES`. The service role has `DELETE` on enrollments and none
on events, so events go by cascade, and a test checks that none remain for the
deleted user. Today that list has no `infrastructure_*` table at all (section
16).

## 13. Data model (target; migrations land with the implementation)

- `infrastructure_server_enrollments`: `id`, `user_id`, `code_sha256` (unique),
  `phase`, `issued_at`, `expires_at` (= issued + 15 min, checked),
  `script_version`, `account_label`, `admin_public_key`,
  `admin_key_fingerprint`, `sealed_admin_private_key` (null outside `issued` and
  `reported`), `script_fetches` (≤ 20), `last_fetched_at`, `refused_reports`
  (≤ 10), `last_refusal` (`private_address | ipv4_required | invalid_report`)
  and `last_refused_at`, `reported_at`, `confirm_by` (= reported + 30 min),
  `report_digest`, `observed_address` (null when not seen, 10.1), `ssh_port`,
  `host_public_key`, `host_fingerprint_sha256`, `facts jsonb` (bounded),
  `consent` (`terminal | no_terminal`), `words`, `decided_at`,
  `connection_id` (unique, `on delete set null`), `connection_removed_at`.
- `infrastructure_server_enrollment_events` as in section 12, with
  `enrollment_id` on delete cascade.
- `infrastructure_connections`: `ssh_privilege` (9.1), and `ssh_host_key_type`
  (null or `ssh-ed25519`).
- `infrastructure_host_discovery_snapshots`: `contract_version in (1, 2)` and the
  `complete_infrastructure_host_discovery` change in 9.4.
- Every new table has RLS enabled and is revoked from `public, anon,
  authenticated`, with explicit service-role grants (the default-privilege
  trap noted in `scripts/test-provider-computer-ownership.cjs`): `SELECT` and
  `DELETE` on enrollments, `SELECT` on events; all writes go through the
  functions. A guard trigger enforces transitions. SECURITY DEFINER functions
  `issue_server_enrollment`, `record_server_enrollment_fetch`,
  `report_server_enrollment`, `refuse_server_enrollment_report`,
  `confirm_server_enrollment`, `decline_server_enrollment`,
  `cancel_server_enrollment` and `sweep_server_enrollments` each have
  `set search_path = public, pg_temp` and EXECUTE revoked from `public, anon,
  authenticated`.
- File timestamps come after every existing migration, and the manifest is
  regenerated.

Existing hosts, existing root connections and in-flight Hetzner first-boot
enrollments are untouched. The shared helpers are extracted with their tests
unchanged.

## 14. Threats, mitigations and tests

Test files are named for the implementation; §15 lists them.

| # | Threat | Mitigation | Test |
| --- | --- | --- | --- |
| T1 | Guessing a code online | 160-bit code; pattern check before any read; memory and durable limits; 15-minute life | Generator emits `^hse1_[a-z2-7]{32}$` from 20 random bytes; pattern-invalid codes never reach the store (spy); the 21st fetch and the 11th refused report are refused (PGlite) |
| T2 | Code leaks before use (screen share, chat paste, clipboard manager, shell history) and an attacker reports first | One report spends the code, so the owner's own run then fails with "already used"; nothing is trusted before Yes; the card shows observed address, words and fingerprint, with "No" guidance | Second report with a different body → 401, row unchanged (PGlite and route); no SSH or connection row before confirm (spy on runner and RPC); card copy snapshot |
| T3 | Code leaks after use | Spent; only a byte-identical replay is acknowledged, with no state change | Replay after `reported` → same acknowledgement, one event; replay after `confirmed` → 401 |
| T4 | Database or log read exposes codes or keys | Only `code_sha256` stored; private key sealed with a purpose tag and wiped in terminal phases; allowlisted logging | Store never receives the raw code (spy); check constraint rejects a key in terminal phases (PGlite); route logger calls contain only allowlisted keys |
| T5 | Someone is tricked into running an attacker's command (consent phishing for root) | Terminal prompt names the receiving account (masked email) and says to continue only if it is theirs and they copied it themselves; default is No; **always asked when `/dev/tty` opens, whatever the flags**; `--yes` counts only with no terminal; the plan and uninstall command are printed even then; `consent` reported to the card. This slows the common paste-into-a-terminal case. It is not a full defence (remaining risks) | Harness under a pseudo-terminal: `--yes` still prompts, and `n` → no side effects; the prompt contains the label from the final line; no terminal and no `--yes` → exit, nothing sent, no side effects; no terminal (`setsid`) with `--yes` → proceeds and reports `consent:"no_terminal"` |
| T6 | Tampered script (TLS interception, swapped file, varying content for `curl \| bash`) | HTTPS with normal certificate checks and `--proto '=https'`; body is a pinned file refused if its sha256 differs; identical for every requester; body sha256 published in the repo, the UI and `/enroll/script.sha256`; verify recipe | Route test: body identical across User-Agents, headers and codes; a changed file → 503, nothing served; version and sha256 constants change together |
| T7 | A truncated download runs part of the script, or drops `--dry-run` | Body is only function definitions; caller arguments before the fixed values; `HIVRA_ARGS_V1` and `HIVRA_END_V1` sentinels; exact argument count and patterns checked before any fact is read (6.2) | Harness runs every line prefix of the body and **every byte prefix of each final line** (with and without its newline), for no arguments, `--dry-run` and `--yes`, with side-effect commands stubbed: none called and no plan printed; every non-empty prefix of the final line exits non-zero; only the complete script reaches the plan. Test that no body function name is a proper prefix of an entry function name |
| T8 | Injection through server-rendered values | Four values checked against strict patterns, never escaped, always single-quoted; rendering throws otherwise; the entry function re-checks them | Render refuses quotes, `$(`, backticks, newlines, NUL and Unicode in each field; property test over random strings |
| T9 | Injection through local data (hostname, `os-release`, sshd output) | Check then interpolate; no `eval`; all expansions quoted; `--` before operands; absolute paths; failing values sent as null | Harness with hostile `os-release`, hostname and `sshd -T` fixtures: report JSON is valid, values null, no command executed |
| T10 | A hostile or garbled acknowledgement (terminal escapes, fake instructions) | Fixed-format lines checked by pattern; never executed; the script's actions do not depend on response content beyond accepted/refused | Harness: acknowledgement with escapes, extra lines or oversize → treated as failure, rollback, nothing printed from it |
| T11 | Code visible on the server (argv, environment, disk) | Header only in the user's own `curl`; after that, bash memory and process-substitution pipes; the view-first recipe says to delete its file | Harness records every child argv and environment on the piped path: the code appears in none; no file under the test root contains it; marker has no secret |
| T12 | Passwordless sudo widens what Hivra can do | Stated in three places; per-enrollment key with `restrict`; password sign-in impossible; `visudo`-checked 0440 drop-in; Disconnect deletes the key; uninstall; `sudo` used only for connections that recorded it | Harness: exact sudoers bytes, `visudo -cf` invoked, key-line bytes, `usermod -p '*'`; runner test: managed-fleet environment never uses the sudo transport; `login` connections send today's exact commands |
| T13 | Taking over an existing `hivra` user or clobbering files | Refuse a `hivra` user without the marker; refuse a foreign `hivra-enrollment` sudoers file; refuse an unsafe existing `/etc/hivra`; uninstall removes only byte-identical files | Harness: foreign user → exit, no changes; foreign sudoers → exit; group-writable `/etc/hivra` → exit; uninstall leaves a modified sudoers file |
| T14 | A failed run leaves access behind | Trap rollback until `accepted`; printed manual commands if rollback fails; sealed key wiped at expiry | Harness: 401, 422, all-attempts-failed and malformed acknowledgement each roll back user, sudoers and marker; PGlite: sweep nulls keys of expired rows |
| T15 | SSRF through the enrollment | Observed address from the trusted platform header only; reserved-range refusal; nothing reported is fetched or resolved; owner-entered addresses use `resolveValidatedSshDestination` | Report with loopback, metadata, link-local and private observed addresses → 422 on hosted; DNS lookup spy never called with the reported hostname; confirm with an edited address runs the resolver |
| T16 | Spoofed client-address headers make the card show the victim's server | `trustedClientAddress` reads only `x-vercel-forwarded-for` on Vercel, one address only; ignores `cf-connecting-ip`, `x-real-ip` and client `x-forwarded-for`; the words plus pinned sign-in still stop a forged report | Unit: spoofed `cf-connecting-ip`, `x-real-ip` and `x-forwarded-for` do not change the observed address; a comma list → missing; **Canary check** with spoofed headers (live acceptance) |
| T17 | Interception of Hivra's first SSH connection | The key comes over TLS from the box before any SSH; the first connection must present that exact Ed25519 key; `serverHostKey` restricted | Runner test: a different presented key → refused before authentication, `identity_mismatch` event, both fingerprints in the DTO |
| T18 | A server lies about its facts or its consent | Facts and `consent` labelled "reported"; support and readiness come from pinned-SSH discovery and preparation evidence; a lying server can only affect its owner's own agents | Report facts never feed `requirementsForEngine`; discovery after confirm recomputes |
| T19 | Cross-site issue, confirm or cancel (CSRF) | Clerk session; `isSameOriginMutationRequest`; strict JSON; owner check in SQL | Route tests: missing/foreign `Origin` → 403; another user's enrollment id → 404; PGlite: confirm with the wrong user → no change |
| T20 | Telling unknown codes from expired or used ones | One refusal script and one 401 body for every unusable code | Byte equality across unknown, expired, used and cancelled codes (route tests) |
| T21 | Floods and large or slow bodies | Limits in §11; 2 KB body and 5 s read deadline; format check before the database | 413/408 paths; limit refusals with `Retry-After`; no store call for malformed input |
| T22 | A double Yes or a race creates two connections | Row lock; `connection_id` unique; the phase guard | PGlite: two concurrent confirms → one connection, one `confirmed` event |
| T23 | Expiry races (report or Yes lands just after the deadline) | `expires_at`/`confirm_by` checked at commit with `clock_timestamp()` | PGlite with a mocked clock: commit after the deadline → refused |
| T24 | Denial ("I never connected that") | Events can't be updated or deleted by any role; they go only with their enrollment, under the retention in §12; the receipt lives as long as the connection | PGlite: every transition writes one event; update and delete on events refused for service role and everyone else; deleting an enrollment removes its events |
| T25 | The code reaches platform or app logs | Never in a URL; app logs allowlisted; the GET and report never echo it | Route tests: no response header or log argument contains the code; UI never renders the code in an `href` |
| T26 | A browser or CDN caches the served script | `no-store, private`; text/plain; nosniff; no redirects | Header assertions on every `/enroll*` response |
| T27 | Stale evidence after a privilege change | `ssh_privilege` is revision-bound; v2 snapshots record `privilegeVia`, SQL refuses a mismatch at commit, and preflight and prepare require a match (v1 = `login`) | Update to `sudo` raises the revision and marks targets superseded; SQL refuses a v2 snapshot whose `privilegeVia` differs; preflight refuses a snapshot whose `privilegeVia` differs; a v1 snapshot on a root `login` connection still passes preflight |
| T28 | `sudo` asks for a password and hangs, or is missing | `sudo -n`; missing `HIVRA_SUDO_V1` plus non-zero exit mapped to the privilege outcome; the script checks `sudo` exists before changing anything | Runner test for the sentinel both ways (sudo refused; script failed after the sentinel); outcome test for both copies; harness: missing sudo → exit, no changes |
| T29 | Script bodies or secrets appear in sudo logs or `ps` | In sudo mode argv is one constant command; every script body and data stream travels on stdin (9.2, 9.3) | Runner test: in sudo mode, the command sent over SSH is identical for a gVisor identity guard, a computer operation, Prepare and discovery apart from `<N>`, and contains no script byte or stdin byte; local-mode round trip: the script receives exactly its data on stdin (binary-safe JSON, 1 MB), heredocs and `exit` codes behave as under `bash -s`, a 96 KB script runs |
| T30 | The same server in two accounts, or connected twice | Re-enrollment replaces the key after a prompt that says only what the server knows; same-account duplicates update the existing connection | Harness re-enroll path for `reported` and `pending` markers; PGlite duplicate-fingerprint confirm → existing connection updated, revision bumped |
| T31 | Old script versions with bugs keep being accepted | Report allowlist of current and previous version only; the served body is always current | Report with an unknown `scriptVersion` → 400 and a refused-report count |
| T32 | Owner says Yes without looking | Words and "choose No if your terminal said already used / Hivra didn't answer"; No is as prominent as Yes; a forged report still has to pass pinned sign-in to be useful | Card test: both buttons same weight; words rendered from the row. Remaining risk is stated in the copy |
| T33 | Server rebuilt on the same address | Pinned mismatch shows both fingerprints and "Run a new setup command to reconnect" | Mismatch outcome copy test |
| T34 | Home or private machine expected to work | Refused at report on hosted; unreachable-after-Yes copy; command page says so up front | Report 422 on private addresses; unreachable outcome copy test |
| T35 | The script fetches or runs more code | No downloads, installs, services or extra network calls; one origin | Harness: network stub sees only the report POST; package manager and `systemctl` stubs never called |
| T36 | The privilege change breaks existing gVisor computers | Runtime authority reads no discovery snapshot (9.5) | `gvisor-computer-service.test.ts`: a root `login` connection whose snapshot expired (and one with none) still runs status, exec, start and stop on a bound computer; a `sudo` connection likewise; a non-root `login` connection is refused; prepare with an expired snapshot opens no SSH connection |
| T37 | The card or SSH target names a Cloudflare edge instead of the server | Addresses inside Cloudflare's published ranges are treated as not seen; the owner enters the address | Unit: an `x-vercel-forwarded-for` inside the ranges → observed address null, card copy "couldn't see"; **Canary check** of whether the origin is proxied (18) |
| T38 | An IPv6-only server passes the report and fails every SSH attempt later | IPv4 report; IPv6 arrivals refused with `ipv4_required` and copy; nothing kept | Route: IPv6 observed address → 422 `ipv4_required`, code not spent, refusal counted and shown on the panel; harness: IPv4 connect failure plus IPv6 route → one IPv6 attempt, rollback, copy printed |
| T39 | Host facts leave the server without consent, or a leaked code shows the owner a rebuild card for someone else's server | Nothing is sent before the terminal answer, including the `unsupported` report; the unsupported card says a server used the command and what to do if it wasn't theirs | Harness: unsupported OS with `n` → nothing sent, code still valid; with `y` → one `unsupported` report. Card copy test for the observed-from framing |
| T40 | The server claims a state Hivra never confirmed | Marker states `pending` and `reported` only; re-run copy says only what the server knows; lost-acknowledgement copy on both sides (6.6) | Harness: after `accepted` the marker says `reported`, never `connected`; re-run copy for each marker state; all attempts lost → rollback and the no-answer text; card copy for the lost-acknowledgement Yes path |
| T41 | Observed addresses kept forever | Retention in §12; events cascade with their enrollment; account deletion covers enrollments | PGlite: the sweep deletes ended rows after 30 days and removed-connection receipts after 90, with their events; account deletion leaves no enrollment or event for the user |
| T42 | The script leaves `/etc/hivra` unusable for Prepare or the DeepSeek gateway | Explicit `install -d -m 0755 -o root -g root`; umask never decides a mode | Harness under `umask 077`: `/etc/hivra` is 0755 root:root, marker 0644, sudoers 0440, key file 0600 |
| T43 | Proxmox provisioning under sudo loses its background provisioner when the channel closes | Gate in 9.2: the disposable-runner test must pass before Proxmox preflight accepts `sudo` | Disposable-runner test: a `nohup … &` child started inside the exact sudo command survives an early channel close, with `use_pty` on and off; preflight test: `sudo` refused while the gate constant is off |

Remaining risks, accepted:

- The code sits in the user's shell history and briefly in `ps` until it is
  spent. The view-first recipe writes it to a file until the user deletes it.
- The terminal prompt does not protect a server when the command runs without a
  terminal. Someone who writes the command for a victim can wrap it in `setsid`,
  or have it run where no terminal exists (cloud-init user data, CI, cron, `ssh
  host 'command'` without `-t`), and add `--yes`. The plan, the receiving
  account and the uninstall command are still printed, and the card shows
  "run without a terminal", but nothing on the server stops it.
- The Hivra origin itself is a trust root, as it already is for the dashboard.
- A server administrator who enables sudo I/O logging records Hivra's stdin on
  their own machine.
- Cloudflare's ranges can change after the constant was written. Until it is
  updated, a new edge range would show as an observed address.
- An owner who clicks Yes without reading can confirm a forged report. In that
  case the forged server still needs Hivra's key installed by its own run, which
  means it belongs to the attacker. Hivra would then launch that owner's future
  agents on the attacker's machine. That is why the words and the "already
  used" guidance are on the card.

## 15. Tests

New (jest unless noted):

- `src/lib/infrastructure/__tests__/server-enrollment-code.test.ts`: format,
  entropy source, hash-at-rest purpose prefix, one-time display.
- `src/lib/infrastructure/__tests__/server-enrollment-script.test.ts`: pinned
  sha256 and version, final-line rendering and refusals (T6, T8), identical
  body, argument order (`"$@"` first, sentinels present).
- `src/app/enroll/__tests__/route.test.ts`, plus `uninstall` and `script`
  variants: headers, refusal equality, fetch counting, no redirects (T20, T25,
  T26).
- `src/app/api/infrastructure/server-enrollments/report/__tests__/route.test.ts`
  and `src/lib/infrastructure/__tests__/server-enrollment-receiver.test.ts`:
  hardening, check order, statuses including `ipv4_required`, replay,
  allowlisted logging (T2-T4, T15, T21, T31, T38).
- `src/app/api/infrastructure/server-enrollments/__tests__/*.test.ts`: issue
  (account checks), status, confirm, decline, cancel (T19, T22).
- `src/lib/__tests__/trusted-client-address.test.ts` (T16, T37).
- `scripts/test-server-enrollment.cjs` (PGlite, following
  `test-provider-computer-ownership.cjs`): transitions, consume-once, replay,
  expiry at commit, concurrent confirm, grants, RLS, EXECUTE revocation,
  events immutable and cascading, retention sweep, account deletion, key wiping,
  discovery v2 commit checks (T1, T3, T4, T22-T24, T27, T30, T41).
- `dashboard/bootstrap/test_server_enroll.py` (Python `unittest`, like
  `test_hetzner_enroll.py`): sources the body under bash with side-effect
  commands as PATH stubs that record calls (`useradd`, `usermod`, `install`,
  `visudo`, `curl`, `userdel`, `loginctl`, `pkill`, `mv`, `rm`), and uses
  Python's `pty` for terminal cases. Covers T5, T7 (line and byte prefixes),
  T9-T14, T28, T30, T35, T38-T40, T42, dry-run, re-enrollment and uninstall.
- `dashboard/scripts/test-server-enroll-host.py`: runs under `sudo` on the
  disposable CI runner (`HIVRA_DISPOSABLE_CI`, like the DeepSeek install tests in
  `public-release-safety.yml`). Real `useradd`, `visudo`, `sshd -T` and an
  actual key sign-in plus the exact sudo transport command against a local sshd
  where the runner has one, against a local fake report endpoint. The T43
  early-close check with `use_pty` on and off. Then uninstall, and a check that
  nothing remains.
- Runner (`src/lib/services/__tests__/proxmox-host-script-runner.test.ts`,
  `proxmox-host-script-stdin.test.ts`): sudo transport command and framing,
  sentinel, managed fleet and `login` unchanged, local-mode round trip (T12,
  T28, T29).
- Discovery (`host-discovery.test.ts`, `host-discovery-contracts.test.ts`,
  `host-discovery-outcome.test.ts`): sudo probe parsing, contract v2, v1 read as
  `login`, outcome copy (T27).
- gVisor (`src/lib/hivra/__tests__/gvisor-computer-service.test.ts`, and a new
  `src/lib/infrastructure/__tests__/gvisor-target.test.ts`): runtime authority
  without a snapshot, preflight and prepare with the snapshot rule (T27, T36).
- `src/__tests__/proxy-config.test.ts`: the new exact exclusions exist in both
  matcher entries where required, resolve to real routes, and leave siblings
  protected.
- Next config: `/enroll` routes include `bootstrap/server-enroll.sh`.
- UI: the panel never puts the code in an `href` or storage; countdown from
  `expiresAt`; fetch and refusal lines; card fields, consent row and buttons;
  unsupported framing; the No path shows uninstall (T25, T32, T39, T40).

Existing tests that assert retired root-only behaviour, to update in slice 13
and name in its commit: `src/lib/infrastructure/__tests__/host-discovery-outcome.test.ts`
and `src/components/infrastructure/__tests__/InfrastructureHostDiscoveryResult.test.tsx`
("Hivra needs a root login", `connect-as-root`);
`src/components/infrastructure/__tests__/InfrastructureConnectionsPage.test.tsx`
("discovery needs a root login", line 958);
`src/lib/infrastructure/__tests__/connection-preflight.test.ts`
(`PROXMOX_PERMISSION_UNAVAILABLE` remediation). No existing test asserts the
gVisor "requires a root Linux host connection" copy (checked), so the gVisor
tests above are new coverage, not updates.

## 16. Discrepancies found while writing this

- **`getIP()` trusts `cf-connecting-ip` first** (`rate-limit.ts:188-197`). Where
  Cloudflare does not front the deployment and strip that header, a client can
  choose its own rate-limit key. Whether Canary or production is fronted by
  Cloudflare was not checked. That makes this a possible code defect for
  in-memory rate limiting. It is also why the enrollment's observed address
  must not use `getIP()`. Fix it separately with its own test; this design does
  not depend on the fix.
- **Account deletion covers no infrastructure table.** `ACCOUNT_DELETION_TABLES`
  (`src/lib/ops/account-deletion.ts:35`) lists no `infrastructure_*` table, so
  connections, their sealed secrets, discovery snapshots and first-boot rows
  appear to survive the account-deletion script. This is a possible code defect
  in the operator tooling, outside this slice. This slice adds its own table
  (section 12) either way.
- **The earlier draft's "plan's connection limit"** named a check that does not
  exist in code (section 2). This revision removes it and states the rule for
  when one is added (section 5).
- **The outbound connector draft vs this slice.** The draft says the "At home"
  enrollment lands with slice 13; the approved proposal and this design keep
  home machines unsupported until slice 16. That is documentation drift; the
  draft should be updated when slice 13 lands.
- **Onboarding spec, Existing Server Path** ("Port 22 and user root may be
  hidden behind Advanced"). With this design the default user is `hivra` with
  sudo. That spec gets updated with the implementation (target behaviour, not
  yet implemented).
- **Proxmox VE has no sudo by default.** The approved command reads `… | sudo
  bash`. Root shells on PVE leave `sudo` out, and the script then asks for sudo
  to be installed for the `hivra` user. This needs live confirmation on PVE 8
  and 9.

## 17. Decisions that differ from the approved proposal (for owner review)

1. **The code goes in a header, not the path.**
   `curl … -H 'Authorization: Bearer hse1_…' https://<origin>/enroll | sudo
   bash` replaces `…/enroll/<code>`. This keeps the code out of URLs and platform
   request logs, as the canonical design requires. It costs nothing with a Copy
   button.
2. **160-bit code** instead of the 8-character illustration.
3. **A terminal prompt** naming the receiving account before anything is sent or
   changed (T5). It is always asked when a terminal exists; `--yes` counts only
   without one, for automation. It adds one keypress. It slows the common
   paste-into-a-terminal attack; it cannot stop a command built to run without a
   terminal (section 14, remaining risks).
4. **Three words shown in both places**, so "Is this your server?" can be
   answered by matching the terminal instead of recognising an IP address.
5. **An unsupported server can spend the code**, after a yes in the terminal,
   and gets the specific rebuild message in Hivra at once, framed as "a server
   used your command". Answering no sends nothing.
6. **No SSH connection before Yes**, including a reachability check.
   Unreachable servers are explained after confirmation, with **Check again**.
7. **IPv4 only on hosted Hivra**, refused at report with copy.

## 18. Acceptance

The slice is done only when all of these pass on Canary's Git-built deployment
at the merge SHA:

- A real AWS Ubuntu 24.04 instance, signed in as `ubuntu`: run the command →
  terminal prompt → words match → Yes → "Ready for Linux Sandbox" → launch an
  agent → chat. (This is the proposal's slice-13 acceptance. Creating paid
  capacity needs the owner's approval for that exact target.)
- Same instance: `… | sudo bash -s -- --yes` in the terminal still asks.
- Same instance, after more than 15 minutes without an inspection: the agent's
  computer still opens and runs a command (T36).
- Same instance: the server's auth log shows one constant Hivra command line per
  operation and no script body.
- Same instance: uninstall, then Hivra reports it can no longer sign in, and
  Disconnect removes the connection.
- Leaked-code drill on Canary with two accounts: the second machine reports
  first, the owner's run says "already used", the card shows words the owner's
  terminal does not, and No leaves nothing trusted.
- Spoofed `cf-connecting-ip`, `x-real-ip` and `x-forwarded-for` on the report do
  not change "Connected from", and "Connected from" equals the instance's public
  IPv4. Record whether the Canary origin is proxied by Cloudflare; if it is,
  "Connected from" must read "Hivra couldn't see this server's address".
- `curl` to `/enroll` on Canary gets the script, not a Clerk or protection
  redirect.
- An IPv6-only server gets the `ipv4_required` text in the terminal and on the
  panel, and nothing is kept.
- Proxmox VE 8 via sudo: preflight, and a Proxmox launch through the transport
  only if the T43 gate passed.
- Script behaviour in at least one provider web console (paste support,
  `/dev/tty`).

Until then the capability is unimplemented. Nothing in this document claims a
working enrollment command.

## 19. Implementation order

1. Shared extractions (host-key canonicalisation, key generator, trusted
   origin, `trustedClientAddress`) with no behaviour change.
2. Migration: tables, connection columns, discovery v2 checks, functions,
   grants, retention sweep; the PGlite suite.
3. Script body and uninstall mode, with the Python harness and disposable-runner
   test; pinned version and sha256.
4. Machine routes (`/enroll*`, report) with middleware exclusions and tests.
5. Owner routes (issue, status, confirm, decline, cancel).
6. Runner sudo transport, discovery contract v2, gVisor runtime and preflight
   rules, Proxmox copy and the T43 gate, privilege outcome copy, and the
   retired-behaviour test updates.
7. UI: My server panel, "View the script first", "Is this your server?",
   connection-card receipts, uninstall on Disconnect; advanced wizard
   passphrase, sudo option and trust-on-first-use.
8. Account deletion list and retention cron.
9. Canary acceptance (section 18).
