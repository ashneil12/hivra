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
Revision 3 (2026-09-24) fixes the second review: a report that matches a server
already connected changes nothing by itself, and replacing that server's access
is its own owner action that Hivra verifies by signing in first (8.1); the
terminal names the account by an account code that can't be collided instead of
a masked email (5, 6.1); the final line is one brace group, so no cut can run
anything (6.2); event rows are never updated and the counts live on the
enrollment row (12); the advanced wizard keeps the pasted fingerprint as its
default (8.2); the background-work claim is scoped per lane (9.3); the words are
chosen in the app (7); a download-limit refusal has its own copy (6.2); and the
sudo transport's failure and `use_pty` cases are named and tested (9.2).
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
- Key rotation for an enrolled connection, beyond what a new command does.
  Running a new command on a connected server offers to replace that server's
  access, which the owner chooses and Hivra verifies (8.1).

## 4. User flow and copy

**My server → Connect a server you already have**

> Run this on the server, as a user who can use sudo:
>
> `curl -fsS --proto '=https' -H 'Authorization: Bearer hse1_…' https://hivra.cloud/enroll | sudo bash` **[Copy]**
>
> Single use · expires in 14:52 · **[View the script first]** · **[Get a new command]**
>
> Your terminal will ask you to check your account code: **K7QM-2XRA**
>
> Signed in as root (Proxmox usually is)? Leave out `sudo`.
> Works with Ubuntu 22.04 or 24.04 on x86, or Proxmox VE 8 or 9. The server
> needs a public IPv4 address and must accept SSH from the internet. Home or
> office machine? Hosted Hivra can't reach private networks yet.
>
> *Waiting for your server… no contact yet · 0:41* — check your terminal if nothing happens.
> [Connect with SSH details instead (advanced)]

The waiting line reports only what Hivra saw: "The setup script was downloaded
with your command at 12:03:41" once a fetch is counted, "Hivra refused a
report for your command: it arrived over IPv6 only" after a refused report
(7), and "Your command reached its download limit. Get a new command." after the
20th download (6.2). The origin in the command is the deployment's own `NEXT_PUBLIC_APP_URL`
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

This gives the Hivra account with code K7QM-2XRA administrator access to this server.
Continue only if K7QM-2XRA is your account code (Hivra shows it next to the
command and in your account menu) and you copied this command from Hivra yourself.
Continue? [y/N]
```

The account code is explained in section 5. The terminal never shows an email
address: a masked one such as `sam***@gmail.com` is the same for
`sam@gmail.com` and `samuel.x@gmail.com`, so it would reassure the wrong
person.

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

**A server Hivra already knows.** When the reported identity matches a server
already connected in this account, the card changes, and Yes is not offered
(8.1):

> A server used your setup command 12 seconds ago. It reports the same SSH
> identity as **web-1**, which is already connected.
>
> *(the same table, with the three words)*
>
> Only continue if your terminal shows these three words and you ran the command
> on web-1. Hivra first signs in to web-1 at 198.51.100.7 with the new key. It
> changes web-1 only if that works; otherwise Hivra leaves web-1 as it is.
>
> **[Replace web-1's access]** **[No, cancel]**

While Hivra checks: "Signing in to web-1 with the new key…". If the sign-in
fails: "web-1 didn't accept the new key, so Hivra changed nothing: web-1 keeps
the access it had before. If you ran the command on web-1, check that it
finished, then try again. If you didn't, choose No." The cases where Replace is
not offered at all, and their copy, are in 8.1.

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
| Owner-bound | The row carries the issuing `user_id`. The machine endpoints never take an account from the request. Confirm, replace, cancel and status need that owner's Clerk session. |
| Account code | What the terminal names the receiving account by. `accountCode(userId)` is the first 40 bits of `sha256("hivra/account-code/v1" ‖ 0x00 ‖ userId)` in Crockford base32 (no I, L, O or U), shown as `XXXX-XXXX`. It is derived, not stored, and it is the same wherever it appears: next to the command, in the account menu and on the settings page, and in the final line of the script. It is not a secret and grants nothing. Nobody chooses it, because Clerk assigns user ids: an attacker who wants a victim's code must create about 2^40 (a trillion) accounts, and even matching the first four characters takes about 2^20 (a million). A code holder learns this pseudonymous value, not the owner's email. |
| Lifetime | 15 minutes from issue to report (`expires_at`, checked at SQL commit with `clock_timestamp()`). After a report, the owner has 30 minutes to answer (`confirm_by`). |
| Redemption | Fetching the script does not use the code (so `--dry-run` and "view first" keep it valid). The code is spent by exactly one accepted report: `issued → reported` or `issued → unsupported`, in one conditional `UPDATE … WHERE phase = 'issued' AND expires_at > clock_timestamp()`. A byte-identical repeat of the accepted report gets the same acknowledgement and changes nothing (network retries and lost responses, 6.1 step 13). Anything else after that is refused. |
| Active limit | At most 3 unexpired, unanswered codes per user. |
| Account checks | Every account-level condition that could refuse the connection at Yes also runs when the code is issued and again at report, so a server is never changed for a connection Hivra already knew it would refuse. Today that is the account's access to host connections and the active-code limit; no per-plan server limit exists (section 2). If one is added later, unanswered codes count as pending connections and it is checked at issue, report and Yes. |

States: `issued → reported → confirmed | rejected`, `issued → unsupported`,
`issued | reported → cancelled | expired`. `confirmed` records its `outcome`:
`connected` (Yes made a new connection) or `replaced_access` (8.1). A guard
trigger refuses every other transition, and a check constraint requires the sealed private key to be null in
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
   else. An unknown flag stops here. A cut-short download never gets this far,
   because bash refuses the unclosed final line (6.2).
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
   Hivra account with code K7QM-2XRA so it shows the same instructions? [y/N]".
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
8. **Consent.** Prints the plan (section 4), including the receiving account's
   code from the final line, and asks `Continue? [y/N]` on `/dev/tty`. Default is No.
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

Every response is the body plus **one final line**, which is a single brace
group. Inside it the caller's own arguments come first, the fixed values after
them, and a sentinel last:

```
{ hivra_enroll_entry "$@" HIVRA_ARGS_V1 'https://hivra.cloud' 'hse1_<32 base32 characters>' 'ssh-ed25519 <68 base64 characters>' 'K7QM-2XRA' HIVRA_END_V1; }
```

| Route (GET, no session) | Final line |
| --- | --- |
| `/enroll` with a usable code in `Authorization` and fewer than 20 fetches | `{ hivra_enroll_entry …; }` as above |
| `/enroll` with no code, or an unknown, expired, used or cancelled code | `{ hivra_refuse 'expired_or_used'; }` (or `'missing_code'` when no header was sent), which prints one sentence and exits 1. The body and line are byte-identical for every unusable code. |
| `/enroll` with a usable code that has already been fetched 20 times | `{ hivra_refuse 'fetch_limit'; }`: "This command was downloaded 20 times, which is Hivra's limit. Get a new command in Hivra." The code stays valid for a report from a run already under way. This tells nothing to anyone who has not already fetched the script with that code, because each of the first 20 fetches served the real script. |
| `/enroll/uninstall` | `{ hivra_uninstall_entry "$@" HIVRA_END_V1; }` |
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
body holds only function definitions and ends with a newline, so a cut inside
it defines some functions and runs none, or leaves an unclosed definition that
bash rejects.

The final line is one brace group, and bash runs a compound command only after
it has read the closing `}`. Every proper prefix of the final line, with or
without a newline after it, is therefore an unclosed compound command. bash
reports "unexpected end of file" and runs nothing: not the entry function, not
any other command on the server's `PATH` whose name happens to be a prefix of
it. Only the complete line runs. A harness checked this while writing this
(bash 3.2, a stub body, every byte prefix of an enroll line and a refusal line,
with and without a newline, under `bash -s -- --dry-run`): no cut ran anything,
and the complete line ran. The same harness without the braces ran a stub
command named `hivra_enr` placed on `PATH`, and ran the entry function with a
short argument list; that is the weakness the braces remove.

Two further layers remain in case the line is ever changed:

- the entry function refuses an argument list whose last argument is not
  `HIVRA_END_V1`, or whose count or patterns are wrong;
- the body defines no function whose name is a proper prefix of an entry
  function.

Because `"$@"` comes before the fixed values, no cut can drop a caller's
`--dry-run` while keeping the fixed values. The earlier draft put `"$@"` last,
so a cut just before it turned `… | sudo bash -s -- --dry-run` into a real run.

Other properties:

- **The same for everyone.** The body does not vary with requester, User-Agent,
  timing or code, so it can be checked against the public repo. Only the final
  line differs, and it holds four values, each checked against a strict pattern
  before rendering: origin (`trustedAppOrigin()`), code (`^hse1_[a-z2-7]{32}$`),
  key (`^ssh-ed25519 [A-Za-z0-9+/]{68}$`) and account code
  (`^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`, section 5). None can contain
  a quote, so single-quoting is exact. Rendering
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
was removed from this server. Run a new setup command to reconnect." Hivra never
updates that connection because of a report. When the reported identity matches
a server already connected in the same account, the owner is asked "Replace
web-1's access?", and Hivra changes web-1 only after signing in to it with the
new key (8.1).

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
  re-check → account checks (section 5) → one SQL transition. Before calling
  it, the app chooses three words from a fixed 256-word list with Node's
  `crypto.randomInt` and passes them in; SQL has no suitable random source and
  never chooses them. The SQL function `report_server_enrollment` rechecks phase
  and expiry at commit, checks the words against the list, stores the report,
  its digest and the words, and appends a `reported` event. A byte-identical
  replay returns the stored words; the words the app chose for the replay are
  discarded.
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

- Before the owner chooses Yes or Replace, Hivra opens no SSH connection,
  creates or changes no connection row, and runs nothing.
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
  and expiry; re-runs the account checks (section 5); refuses if any connection
  in this account already pins the reported host key (that case goes through
  Replace, 8.1, and the check at commit also catches a connection created while
  the card was open); inserts the `host` connection (`ssh_host` = observed or
  owner-edited address, `ssh_port` = reported port, `ssh_user` = `hivra`,
  `ssh_privilege` = `sudo`, pinned fingerprint = reported host key, host-key
  type `ssh-ed25519`) with its secret bundle, which the app re-seals from the
  enrollment's key under the connection-secret format; moves the enrollment to
  `confirmed` with outcome `connected` and `connection_id`, nulls its sealed
  key, and appends events. The normal inspection then starts.
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

### 8.1 A server Hivra already knows: Replace access

Host keys are public: anyone can read one with `ssh-keyscan`. A report that
claims web-1's identity therefore proves nothing about web-1. If a report could
update web-1, a forged report plus a careless Yes would swap web-1's working key
for one web-1 has never seen. Sign-in would break, bound gVisor computers would
drop to status and delete, and the forger would gain nothing but the damage.
So a match changes nothing by itself, and Yes is never offered for it.

**Match.** The reported host key's SHA-256 fingerprint equals the pinned
fingerprint of a connection owned by the same user, whatever its provider.
Connections in other accounts are never matched or revealed.

What the card offers depends on the connection it matched:

| Matched connection | Offer |
| --- | --- |
| Exactly one `host` connection with user `hivra` and privilege `sudo` (an earlier enrollment) | **Replace web-1's access.** A key-only change, the same kind as today's credential recovery (`recover_infrastructure_connection_credentials`, migration `20260826130000`): address, port, user, privilege and pinned identity stay the same. Allowed while agents use web-1. |
| Exactly one `host` connection with privilege `login` (root or another user, from the advanced wizard), used by no agent | **Switch web-1 to the hivra user.** User becomes `hivra`, privilege `sudo`, and the key changes. This is an operational change, which today's `update_infrastructure_connection` refuses while any agent uses the connection, so it is offered only when none does. While the T43 gate is off (9.2), it is not offered when web-1's latest inspection found Proxmox VE, because Proxmox preflight would then refuse web-1. |
| A `login` connection that agents use | No Replace: "web-1 is already connected as root, and its agents use that connection. Hivra didn't change it. To remove the hivra user this command added, run the uninstall command." (The copy names web-1's actual user.) Only No. |
| A `login` connection on Proxmox VE while the T43 gate is off | No Replace: "web-1 runs Proxmox VE, which needs a root login for now. Hivra didn't change it. To remove the hivra user this command added, run the uninstall command." Only No. |
| A connection of another provider (a Hetzner server Hivra created) | No Replace: "This SSH identity belongs to web-1, a server Hivra created on Hetzner. Manage it from its card." Only No. The script refuses to run on such a server (6.1 step 7), so a report like this is forged or comes from a copy of that server. |
| More than one connection | No Replace: "More than one of your connections uses this SSH identity. Remove the extra ones first." Only No. |

**Replace, step by step.**

1. The owner chooses Replace: an owner-session, same-origin POST with the
   enrollment id and the connection revision the card showed.
2. `begin_server_enrollment_replacement` (SQL) locks the enrollment, then the
   connection. It checks the owner, the `reported` phase, `confirm_by`, that the
   connection still pins the reported key at the expected revision, and that it
   has no preparation or preflight lease. For a key-only change it also refuses
   while a Hivra operation on the connection started in the last 10 minutes,
   as credential recovery does today. It takes a short verification lease on the
   enrollment, so a second click can't start a second check, and counts the
   attempt (at most 5 per enrollment). The connection is not changed.
3. **Verify before swapping.** The app signs in to web-1's current address. For
   a switch, the owner may choose the address on the card instead; for a
   key-only change the address can't move, as in credential recovery today. The
   sign-in requires web-1's pinned Ed25519 key, uses user `hivra` and the
   enrollment's private key, and runs one fixed, read-only probe through the
   sudo transport (9.2) that prints the effective UID. Success shows three
   things at once: the server presented web-1's pinned key, which only web-1
   holds; it accepted this enrollment's key, which only a run of this
   enrollment's script installs; and sudo ran without a password as UID 0.
   Nothing on the server changes. Its auth log records one sudo line.
4. On success, `complete_server_enrollment_replacement` locks both rows again,
   checks the lease and the expected revision, and changes the connection the
   way today's functions do: a key-only change like credential recovery (new
   sealed bundle, revision + 1, status `pending`,
   `pending_binding_rebind_from_revision` recorded when agents are bound,
   targets unavailable), or a switch like `update_infrastructure_connection`
   with an operational patch and a credential rotation. The enrollment becomes
   `confirmed` with outcome `replaced_access`, `connection_id` = web-1 and
   `replaced_from_revision`. Its sealed key is wiped, and `replacement_verified`
   and `access_replaced` events are appended. Inspection, then preflight, start.
5. On failure (a different host key, no connection, authentication refused, no
   sudo sentinel, or a UID other than 0), `fail_server_enrollment_replacement`
   records the failure class, appends `replacement_refused` and ends the lease.
   The connection, its secret, its revision and its targets are untouched, so
   web-1 and its computers are exactly as they were before the check. (If the
   command really ran on web-1, web-1's old key already stopped working then,
   6.6; the failure copy says to check that the command finished.) The
   enrollment stays `reported` until `confirm_by`, so the owner can try again
   or choose No.

**Running computers.** Nothing on the server is stopped. After a key-only
change, web-1 is `pending` until preflight passes at the new revision. In that
window, bound gVisor computers allow only status and delete
(`isGvisorPendingBoundObservation`), and Proxmox agents allow only teardown
(`credentialRecoveryTeardownAuthority`, `proxmox-execution-context.ts:206-210`).
Launch, exec, start, stop and resize are refused with "Hivra is checking web-1
again." When preflight passes, the existing SQL rebinds every bound agent to
the new revision in one transaction (migration `20260826130000`, lines
1223-1259) and normal operation resumes. If preflight fails, they stay in that
state, as after today's credential recovery, and the card says why. In the
genuine case, web-1's old key stopped working when the command ran on it (6.6),
so Replace restores access instead of interrupting it. A switch is offered only
when no agent uses web-1, so no computer is affected.

**Receipts.** `connection_id` on enrollments is not unique. The enrollment that
first connected web-1 keeps its row and events, and each replacement adds its
own. The connection card lists them in order: "Connected with the setup command
on 24 Sep at 12:04 … · access replaced with the setup command on 2 Oct at 09:14,
confirmed by you." Retention treats every enrollment that points at an existing
connection as that connection's receipt (12).

**Old credentials.** After a switch, Hivra deletes the key it used before from
its sealed bundle. That key stays in the old user's authorized keys file on the
server, because the only command Hivra runs during Replace is the read-only
probe. The result says, for a root connection: "Hivra no longer uses root's key
on web-1. You can remove it from /root/.ssh/authorized_keys."

**Copies and moved servers.** A server copied from web-1 (an image with its host
keys baked in) reports web-1's identity. A key-only Replace then fails at step
3, because the new key is on the copy and not on web-1, and the failure copy
adds: "If you ran the command on a copy of web-1, that server has web-1's SSH
identity. Give it its own SSH host keys, then run a new command." A server that
agents use and whose address changed also fails step 3 at its old address;
moving a connection that agents use to a new address is outside this slice, and
today's rules refuse it too.

### 8.2 Advanced wizard (INF-14)

"Connect with SSH details instead" gains a passphrase field. The key is
decrypted once and stored in the existing sealed bundle; the passphrase is never
stored. It also gains a sudo-user option (privilege `sudo`, section 9).

The pasted SHA-256 fingerprint stays the default, exactly as today. Next to it:
"Don't have it? The setup command gets it from the server itself. [Use the setup
command]". Below that, as a fallback, is **Read it from the server**:

- Hivra opens one connection to the validated destination
  (`resolveValidatedSshDestination`, 10.2) only to capture the presented Ed25519
  key. The verifier records it and refuses, so no authentication or command
  follows.
- Hivra shows the fingerprint with Copy, per-provider "where to find this" links
  (AWS system log, Hetzner and DigitalOcean consoles), and: "Check this matches
  your provider's console before you continue. If someone is intercepting
  Hivra's connection, this could be their key instead of your server's." It
  pins only after the owner confirms.
- Every failure reads the same, "Hivra couldn't read an Ed25519 SSH identity
  from 203.0.113.24:22", whether the port was closed, filtered or slow, spoke
  something other than SSH, or offered no Ed25519 key. Every failure response is
  sent 10 s after the request, so neither text nor timing tells those apart.
- Limit: 5/min per user, the same as today's owner-driven SSH checks
  (`api/infrastructure/connections/[id]/discover/route.ts:45` and
  `…/preflight/route.ts:30`).

The fallback has two risks the command path doesn't have. First-contact
interception (T44): only the owner's comparison with the console covers it,
which is why capture is not the default. Use as a port probe (T45): the uniform
failure and the limit leave only what today's wizard already allows, since an
owner can save a connection to any validated public host and port and inspect
it at 5/min. On a mismatch at any later sign-in, both fingerprints show side by
side.

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
| Any failure maps to `command_failed` | `HIVRA_SUDO_V1` on stderr means bash started as root and any later failure is the script's. No sentinel plus a non-zero exit means the command never reached the script, and a diagnosis follows (below) | One sudo call per successful operation still tells a transport failure apart from a script failure. The earlier draft's separate `sudo -n true` pre-check logged a second line on every operation; the diagnosis runs only after a failure. |

The runner removes the `HIVRA_SUDO_V1` line before callers see stderr.

**When there is no sentinel.** Several things fail before the script starts:
sudo wants a password or doesn't allow the user; `/usr/bin/env`,
`/usr/bin/timeout` or `/bin/bash` is missing; or a sudoers rule allows some
commands but not this one. sudo's own messages follow the server's locale, so
Hivra does not parse them. Instead, only on this failure path, the runner runs
up to two fixed diagnostic commands over the same connection:

1. As the login user, without sudo: `/bin/sh -c` with a fixed probe that
   prints `missing <path>` for each of `/usr/bin/sudo`, `/usr/bin/env`,
   `/usr/bin/timeout` and `/bin/bash` that is not executable. Any missing path
   gives: "This server is missing /usr/bin/timeout, which Hivra needs."
2. If nothing is missing: `/usr/bin/sudo -n -- /usr/bin/true`. If that fails:
   "Hivra signed in as hivra, but sudo wouldn't run without a password." If it
   succeeds, sudo allows some commands but not Hivra's: "sudo on this server
   wouldn't run Hivra's command. Hivra needs the rule `hivra ALL=(ALL:ALL)
   NOPASSWD: ALL`."

Each maps to the privilege outcome (9.4) with its own copy, so the password
copy appears only when sudo itself refused to run without one, never for a
missing tool. The diagnosis adds at most
one sudo log line, and only after a failure. The earlier draft's wrapper had no
`env -i`, no fixed `PATH` and no remote limit; this replaces it.

**Checked locally while writing this** (bash 3.2, local mode, no sudo): under
the loader, `set -Eeuo pipefail` with an `ERR` trap, a function returning 7
under `set -e`, `exit 3`, and 300 KB of random binary data read by the script
all behaved exactly as under `bash -s` (same output, same exit code, same data
hash). Errexit inside `eval` still aborts, because the `eval` is the last
command of the `&&` chain, where bash does not suspend errexit or the `ERR`
trap. What sudo itself does to stdin is not checked locally; see `use_pty`
below.

**`use_pty`.** Current Ubuntu and Debian sudoers files set `Defaults use_pty`.
Depending on the sudo version, sudo may then run the command on its own
pseudo-terminal even when the SSH session has none, relaying stdin, stdout and
stderr through its own process instead of handing the pipes over. That could
change binary data (a terminal line discipline translates bytes such as CR and
^D), how EOF arrives, and when the command sees the channel close. So the
disposable-runner test (section 15) runs the exact sudo command over a real
sshd with `use_pty` on and with it off, and checks that binary stdin (1 MB of
random bytes, including NUL, CR, ^C and ^D), errexit and `ERR` traps, and exit
codes behave exactly as under `bash -s`. If anything differs with `use_pty` on,
the enrollment's sudoers file adds `Defaults:hivra !use_pty` before release,
and the advanced sudo-user option is not offered until its instructions include
the same rule. This is a release gate for the sudo transport, alongside T43.

**Early finish under sudo.** Proxmox provisioning resolves on a marker and
leaves a `nohup … &` child running in the same session (section 2). Under
`timeout`, the child survives as long as the script itself exits before the
limit, because `timeout` signals its process group only when the limit is
reached. Under sudo, the child may also live inside sudo's session: with
`use_pty` in effect (above), sudo can run the command on its own
pseudo-terminal and close it when the command exits, and the SSH channel closes
as soon as the runner has its marker. Before Proxmox provisioning is
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
opened and a session closed line.

How often that happens depends on the lane:

- **Linux Sandbox (gVisor) and the host checks.** Operations are owner-driven:
  inspection, Prepare, preflight, launch, opening a computer's status, running a
  command, start, stop, resize and delete. Nothing on this lane polls in the
  background today (verified: `observeGvisorComputer` and
  `executeGvisorComputerCommand` are called only from
  `api/hivra/agents/[id]/gvisor/**`). The Proxmox-lane callers below do not
  reach gVisor agents, because the shared resolver behind
  `resolveHivraAgentExecutionContext` and its teardown variant refuses any agent
  whose substrate is not `proxmox-kvm` (`agent-execution-context.ts:127`).
- **Proxmox.** Many callers run host scripts over user connections through
  `agent-execution-context.ts` and `proxmox-execution-context.ts`, and some run
  without the owner: the `recover-stuck-hivra-agents` cron every 2 minutes
  (`recover-stuck-provisioning.ts`, `vercel.json`), the attachment host
  observer (`attachment-host-observer.ts`), tool and skill installs, and the
  Bankr wallet routes. None of them reaches a `sudo` connection until the T43
  gate lets Proxmox preflight accept `sudo` (9.2, 9.6). Opening that gate
  therefore also needs a count of the sudo log lines these callers produce on a
  test host over an hour, recorded with the gate result.

Hivra does not change the server's logging.
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
  and inspects again. It is an operational change, so like any other it is
  refused while agents use the connection, and while the T43 gate is off it is
  not offered on Proxmox VE;
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
| `GET /enroll` | 60/min per IP; bad format answered without a database read | ≤ 20 script fetches per code, after which the `fetch_limit` refusal is served (6.2) |
| Report | 30/min per IP (as first boot); 12/min per code after the format check | One accepted report per code; after 10 refused reports (including 422s), the code is cancelled ("Get a new command") |
| Status poll | 120/min per user | — |
| Yes / No / cancel | 20/min per user | Row lock; one outcome |
| Replace access (8.1) | 5/min per user | A verification lease per enrollment; ≤ 5 verification attempts per enrollment |
| Advanced key capture (8.2) | 5/min per user, as discover and preflight today | — (every failure answered at a fixed 10 s) |

429 responses carry `Retry-After`, and the UI turns it into "You can try again
in N minutes" (`retry-after-copy.ts`).

## 12. Audit receipts and retention

`infrastructure_server_enrollment_events` is append-only: an event row is
never updated, and it is deleted only together with its enrollment. Each row
belongs to one enrollment (`enrollment_id … references
infrastructure_server_enrollments (id) on delete cascade`), and it goes only by
that cascade, from the retention sweep or account deletion below.

Every occurrence is its own row, and no row holds a count:

| Kind | Rows per enrollment |
| --- | --- |
| `issued`, `reported`, `unsupported`, `confirmed`, `rejected`, `cancelled`, `expired`, `connection_created`, `access_replaced` | At most one each |
| `script_served` | One per fetch, at most 20 (the fetch cap; a fetch refused with `fetch_limit` writes none) |
| `refused_report` | One per refused report, with its refusal class, at most 10 (at the 10th the code is cancelled) |
| `replacement_verified`, `replacement_refused` | One per Replace attempt, at most 5 |
| `identity_mismatch` | At most one: the first sign-in after Yes or a Replace check that met a different host key. Later mismatches belong to the connection, not the enrollment |

The running counts that the caps and the panel need (`script_fetches`,
`last_fetched_at`, `refused_reports`, `last_refusal`, `last_refused_at`,
`replacement_attempts`) live on the enrollment row, and the same SECURITY
DEFINER function updates the row and appends the event in one transaction. Each
event holds the enrollment id, user id, time, actor (`owner` or `server`),
script version, the observed address for `reported`, and the host fingerprint
where relevant. No row holds the code, its hash, a key or the report body.

How immutability is enforced:

- **Grants.** No API role (`anon`, `authenticated`, `service_role`) has
  `INSERT`, `UPDATE` or `DELETE` on events. Only the SECURITY DEFINER functions
  insert, and none of them updates or deletes an event.
- **A guard trigger**, `BEFORE UPDATE OR DELETE` on events, which also covers
  the functions' owner. It refuses every `UPDATE`. It allows a `DELETE` only
  when `pg_trigger_depth() > 1`, which is the case when the foreign-key cascade
  from a deleted enrollment runs it; a direct `DELETE` runs it at depth 1 and is
  refused. The retention sweep and account deletion therefore keep working.

Both were checked in PGlite while writing this: as `service_role` with only
`SELECT` on events and `SELECT, DELETE` on enrollments, updating, deleting or
inserting an event was refused and deleting an enrollment removed its events
by cascade; with the trigger, a direct update and a direct delete were refused
and the cascade still removed the events. The PGlite suite (section 15) pins
both.

The owner sees these on the connection card: "Connected with the setup command
on 24 Sep at 12:04 from 203.0.113.24 · identity SHA256:Xb…9Q · confirmed by you
at 12:05." Replacements add their own line (8.1).

**Retention** (the only ways enrollment rows and their events, including
observed addresses, are deleted):

| Row | Kept until |
| --- | --- |
| Ended without a connection (`unsupported`, `rejected`, `cancelled`, `expired`) | 30 days after it ended (`decided_at`, or `expires_at` for expiry) |
| `confirmed` (outcome `connected` or `replaced_access`), connection still exists | While the connection exists: every enrollment that points at it is one of its identity receipts |
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
  `script_version`, `admin_public_key`, `admin_key_fingerprint`,
  `sealed_admin_private_key` (null outside `issued` and `reported`),
  `script_fetches` (≤ 20), `last_fetched_at`, `refused_reports` (≤ 10),
  `last_refusal` (`private_address | ipv4_required | invalid_report`) and
  `last_refused_at`, `reported_at`, `confirm_by` (= reported + 30 min),
  `report_digest`, `observed_address` (null when not seen, 10.1), `ssh_port`,
  `host_public_key`, `host_fingerprint_sha256`, `facts jsonb` (bounded),
  `consent` (`terminal | no_terminal`), `words` (chosen by the app, checked
  against the list), `replacement_run_id` and `replacement_lease_expires_at`,
  `replacement_attempts` (≤ 5), `last_replacement_failure`, `decided_at`,
  `outcome` (`connected | replaced_access`, set only in `confirmed`),
  `replaced_from_revision` (only for `replaced_access`), `connection_id`
  (**not unique**, indexed, `on delete set null`: several enrollments can be
  receipts for one connection, 8.1), `connection_removed_at`. The account code
  is not stored; it is derived from `user_id` (section 5).
- `infrastructure_server_enrollment_events` as in section 12, with
  `enrollment_id` on delete cascade and the immutability guard trigger.
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
  `confirm_server_enrollment`, `begin_server_enrollment_replacement`,
  `complete_server_enrollment_replacement`,
  `fail_server_enrollment_replacement`, `decline_server_enrollment`,
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
| T1 | Guessing a code online | 160-bit code; pattern check before any read; memory and durable limits; 15-minute life | Generator emits `^hse1_[a-z2-7]{32}$` from 20 random bytes; pattern-invalid codes never reach the store (spy); the 21st fetch gets the `fetch_limit` refusal and the 11th refused report cancels the code (PGlite) |
| T2 | Code leaks before use (screen share, chat paste, clipboard manager, shell history) and an attacker reports first | One report spends the code, so the owner's own run then fails with "already used"; nothing is trusted before Yes; the card shows observed address, words and fingerprint, with "No" guidance | Second report with a different body → 401, row unchanged (PGlite and route); no SSH or connection row before confirm (spy on runner and RPC); card copy snapshot |
| T3 | Code leaks after use | Spent; only a byte-identical replay is acknowledged, with no state change | Replay after `reported` → same acknowledgement, one event; replay after `confirmed` → 401 |
| T4 | Database or log read exposes codes or keys | Only `code_sha256` stored; private key sealed with a purpose tag and wiped in terminal phases; allowlisted logging | Store never receives the raw code (spy); check constraint rejects a key in terminal phases (PGlite); route logger calls contain only allowlisted keys |
| T5 | Someone is tricked into running an attacker's command (consent phishing for root) | Terminal prompt names the receiving account by its account code (section 5), which nobody can choose, instead of a masked email that collides trivially; Hivra shows the same code next to the command and in the account menu; the prompt says to continue only if the code is theirs and they copied the command themselves; default is No; **always asked when `/dev/tty` opens, whatever the flags**; `--yes` counts only with no terminal; the plan and uninstall command are printed even then; `consent` reported to the card. It protects a victim who has a Hivra account and compares the code. It is not a full defence (remaining risks) | Harness under a pseudo-terminal: `--yes` still prompts, and `n` → no side effects; the prompt contains the account code from the final line and no `@`; no terminal and no `--yes` → exit, nothing sent, no side effects; no terminal (`setsid`) with `--yes` → proceeds and reports `consent:"no_terminal"`. Unit: `accountCode` fixed vectors; the same user id gives the same code in the final line, the command panel and the account menu; 100,000 random user ids give no two equal codes (about 0.005 collisions expected at 40 bits); the final-line renderer refuses any account value that is not a code (an email, an empty string) |
| T6 | Tampered script (TLS interception, swapped file, varying content for `curl \| bash`) | HTTPS with normal certificate checks and `--proto '=https'`; body is a pinned file refused if its sha256 differs; identical for every requester; body sha256 published in the repo, the UI and `/enroll/script.sha256`; verify recipe | Route test: body identical across User-Agents, headers and codes; a changed file → 503, nothing served; version and sha256 constants change together |
| T7 | A truncated download runs part of the script, or drops `--dry-run` | Body is only function definitions ending in a newline; the final line is one brace group, so every proper prefix is an unclosed compound command that bash refuses to run; caller arguments before the fixed values; `HIVRA_ARGS_V1` and `HIVRA_END_V1` sentinels; exact argument count and patterns checked before any fact is read; no body function name is a prefix of an entry name (6.2) | Harness runs every line prefix of the body and **every byte prefix of each final line** (enroll, both refusals and uninstall; with and without a newline), for no arguments, `--dry-run` and `--yes`, with side-effect commands stubbed **and a stub command on `PATH` for every proper prefix of each entry name**: no stub called, no plan printed, every non-empty proper prefix of a final line exits non-zero; only the complete script reaches the plan. Separately, with the braces removed from a test copy of the line, the entry function refuses every short argument list (second layer). Test that no body function name is a proper prefix of an entry function name |
| T8 | Injection through server-rendered values | Four values (origin, code, key, account code) checked against strict patterns, never escaped, always single-quoted; rendering throws otherwise; the entry function re-checks them | Render refuses quotes, `$(`, backticks, `}`, `;`, newlines, NUL and Unicode in each field; property test over random strings |
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
| T20 | Telling unknown codes from expired or used ones | One refusal script and one 401 body for every unusable code; the `fetch_limit` refusal is served only for a usable code already fetched 20 times, which tells nothing to anyone who has not fetched it | Byte equality across unknown, expired, used and cancelled codes (route tests); `fetch_limit` only after 20 recorded fetches of a usable code |
| T21 | Floods and large or slow bodies | Limits in §11; 2 KB body and 5 s read deadline; format check before the database | 413/408 paths; limit refusals with `Retry-After`; no store call for malformed input |
| T22 | A double Yes or a race creates two connections | Row lock on the enrollment; the phase guard (`reported → confirmed` once); the known-identity check at commit | PGlite: two concurrent confirms → one connection, one `confirmed` event; a confirm after a connection with the same fingerprint appeared → refused |
| T23 | Expiry races (report or Yes lands just after the deadline) | `expires_at`/`confirm_by` checked at commit with `clock_timestamp()` | PGlite with a mocked clock: commit after the deadline → refused |
| T24 | Denial ("I never connected that") | Events are never updated and go only with their enrollment: no API role has insert, update or delete on events, and a guard trigger refuses every update and every delete not run by the foreign-key cascade (`pg_trigger_depth() > 1`); counts live on the enrollment row, not in events; retention in §12; the receipt lives as long as the connection | PGlite: every transition writes one event; update, delete and insert on events refused for `service_role` and everyone else; a direct update or delete as the table owner refused by the trigger; deleting an enrollment removes its events; fetch and refusal counters on the row match the number of `script_served` and `refused_report` events |
| T25 | The code reaches platform or app logs | Never in a URL; app logs allowlisted; the GET and report never echo it | Route tests: no response header or log argument contains the code; UI never renders the code in an `href` |
| T26 | A browser or CDN caches the served script | `no-store, private`; text/plain; nosniff; no redirects | Header assertions on every `/enroll*` response |
| T27 | Stale evidence after a privilege change | `ssh_privilege` is revision-bound; v2 snapshots record `privilegeVia`, SQL refuses a mismatch at commit, and preflight and prepare require a match (v1 = `login`) | Update to `sudo` raises the revision and marks targets superseded; SQL refuses a v2 snapshot whose `privilegeVia` differs; preflight refuses a snapshot whose `privilegeVia` differs; a v1 snapshot on a root `login` connection still passes preflight |
| T28 | `sudo` asks for a password and hangs, is missing, or refuses Hivra's command | `sudo -n`; no `HIVRA_SUDO_V1` plus non-zero exit starts a diagnosis that tells a missing tool, a password or disallowed user, and a sudoers rule that allows other commands apart, each with its own copy (9.2); the script checks `sudo` exists before changing anything | Runner test for the sentinel both ways (transport failed; script failed after the sentinel); diagnosis: missing `timeout` → "missing /usr/bin/timeout" copy and no password copy; `sudo -n true` failing → password copy; `sudo -n true` passing → the sudoers-rule copy; the diagnosis never runs after a success; outcome test for each copy; harness: missing sudo → exit, no changes |
| T29 | Script bodies or secrets appear in sudo logs or `ps`, or the transport changes how a script behaves | In sudo mode argv is one constant command; every script body and data stream travels on stdin (9.2, 9.3); `use_pty` behaviour is a release gate (9.2) | Runner test: in sudo mode, the command sent over SSH is identical for a gVisor identity guard, a computer operation, Prepare and discovery apart from `<N>`, and contains no script byte or stdin byte; local-mode round trip: the script receives exactly its data on stdin (binary-safe JSON, 1 MB), heredocs, errexit, `ERR` traps and `exit` codes behave as under `bash -s`, a 96 KB script runs. **Disposable runner, real sshd and sudo, `use_pty` on and off:** 1 MB of random stdin including NUL, CR, ^C and ^D arrives byte-identical; `set -Eeuo pipefail` with an `ERR` trap, a failing function under `set -e`, and `exit 3` give the same output and exit codes as `bash -s`; if `use_pty` on differs, the release carries `Defaults:hivra !use_pty` and the test is re-run |
| T30 | The same server connected twice, or a forged report that claims an existing connection's identity (host keys are public) to rewrite a working connection | A match changes nothing by itself: Yes is refused for a known identity; **Replace web-1's access** is its own owner action; Hivra first signs in to web-1 with its pinned key and the new key through the sudo transport and needs UID 0; only then, under the expected revision, does the connection change; a forged report fails that sign-in and web-1 keeps working; earlier receipts are kept (8.1). Across accounts, re-enrollment replaces the server's key after a prompt that says only what the server knows | PGlite: confirm with a fingerprint an existing connection pins → refused, nothing changed; `complete_server_enrollment_replacement` without a held lease, with a stale revision, or after `confirm_by` → refused; after a replacement both enrollments keep `connection_id`; the 6th attempt → refused. Service: a check that meets a different host key, is refused authentication, gets no sentinel, or reads a UID other than 0 leaves the connection's secret bytes, revision, status, targets and its computers' authority unchanged, and appends `replacement_refused`; a successful check moves the key by credential recovery (revision + 1, pending rebind recorded). Harness: re-enroll path for `reported` and `pending` markers |
| T31 | Old script versions with bugs keep being accepted | Report allowlist of current and previous version only; the served body is always current | Report with an unknown `scriptVersion` → 400 and a refused-report count |
| T32 | Owner says Yes without looking | Words and "choose No if your terminal said already used / Hivra didn't answer"; No is as prominent as Yes; a forged report still has to pass pinned sign-in to be useful | Card test: Yes (or Replace) and No have the same weight; words rendered from the row. Remaining risk is stated in the copy |
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
| T44 | Advanced wizard fallback: an attacker on the path between Hivra and the server answers the key capture with their own key, and Hivra pins it | The pasted fingerprint stays the default, and the setup command is offered next to it; capture is a fallback that says the key could be an interceptor's and asks the owner to compare it with the provider's console; Hivra pins only after the owner confirms; the verifier refuses after recording the key, so nothing is authenticated or sent at capture | Wizard test: the fingerprint field is shown and required by default, capture only after "Read it from the server"; the capture screen shows the warning and the console links; no connection is created until the owner confirms; runner test: the capture connection sends no authentication and no command |
| T45 | Advanced key capture used as a port probe against arbitrary public hosts | Only destinations that pass `resolveValidatedSshDestination`; one failure text for closed, filtered, slow, non-SSH and no-Ed25519 answers, sent at a fixed 10 s; 5/min per user, as discover and preflight already allow for saved connections (8.2) | Route test: refused, timed-out, non-SSH and RSA-only fakes give byte-identical bodies and no response before 10 s; a reserved or metadata address never reaches the socket; the 6th capture in a minute → 429 with `Retry-After` |
| T46 | Replacing access disrupts running computers, or leaves a working connection worse | A key-only Replace keeps address, user, privilege and identity and follows credential recovery: bound computers keep running, allow status and delete (gVisor) or teardown (Proxmox) until preflight passes, then rebind in one transaction; a switch from a `login` connection is offered only when no agent uses it and, while the T43 gate is off, not on Proxmox VE; connections of other providers and multiple matches get no Replace (8.1) | Service: a `login` connection with a bound agent → no Replace offered and the route refuses before any SSH; Proxmox VE snapshot with the gate off → refused; a `hetzner-cloud` match → only No; after a key-only Replace, a bound gVisor computer's status and delete work and exec is refused until preflight passes, then exec works; PGlite: preflight at the new revision rebinds every bound agent |

Remaining risks, accepted:

- The code sits in the user's shell history and briefly in `ps` until it is
  spent. The view-first recipe writes it to a file until the user deletes it.
- The account code protects only a person who has a Hivra account and compares
  it. A server administrator with no Hivra account has only "you copied this
  command from Hivra yourself" to go on, and someone who doesn't read the prompt
  is not protected by it. Comparing only the first few characters weakens it:
  four matching characters take about a million attacker accounts, and two take
  about a thousand.
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
- Capture in the advanced wizard (8.2) trusts the first key it sees if the
  owner confirms without comparing it. It is a fallback behind the pasted
  fingerprint and the setup command for that reason.
- An owner who clicks Yes without reading can confirm a forged report. In that
  case the forged server still needs Hivra's key installed by its own run, which
  means it belongs to the attacker. Hivra would then launch that owner's future
  agents on the attacker's machine. That is why the words and the "already
  used" guidance are on the card. A forged report that claims a server already
  connected can't change that server, even if the owner chooses Replace,
  because the verification sign-in fails (8.1).

## 15. Tests

New (jest unless noted):

- `src/lib/infrastructure/__tests__/server-enrollment-code.test.ts`: format,
  entropy source, hash-at-rest purpose prefix, one-time display.
- `src/lib/__tests__/account-code.test.ts`: `accountCode` vectors, alphabet and
  format, distribution over random ids, and the same value in the final line,
  the command panel and the account menu (T5).
- `src/lib/infrastructure/__tests__/server-enrollment-script.test.ts`: pinned
  sha256 and version, final-line rendering and refusals including
  `fetch_limit` (T6, T8, T20), identical body, the final line is one brace
  group, argument order (`"$@"` first, sentinels present).
- `src/app/enroll/__tests__/route.test.ts`, plus `uninstall` and `script`
  variants: headers, refusal equality, fetch counting, no redirects (T20, T25,
  T26).
- `src/app/api/infrastructure/server-enrollments/report/__tests__/route.test.ts`
  and `src/lib/infrastructure/__tests__/server-enrollment-receiver.test.ts`:
  hardening, check order, statuses including `ipv4_required`, replay,
  allowlisted logging (T2-T4, T15, T21, T31, T38).
- `src/app/api/infrastructure/server-enrollments/__tests__/*.test.ts`: issue
  (account checks), status, confirm (refused for a known identity), replace,
  decline, cancel (T19, T22, T30).
- `src/lib/infrastructure/__tests__/server-enrollment-replacement.test.ts`: the
  offer for each kind of matched connection, verify-before-swap with each
  failure class, nothing changed on failure, credential-recovery path on
  success, bound computers' authority during and after (T30, T46).
- Advanced wizard (`src/components/infrastructure/__tests__/InfrastructureConnectionWizard.test.tsx`
  and a new
  `src/app/api/infrastructure/connections/host-key-capture/__tests__/route.test.ts`):
  pasted fingerprint by default, capture as fallback with its warning, uniform
  failures at a fixed delay, limits (T44, T45).
- `src/lib/__tests__/trusted-client-address.test.ts` (T16, T37).
- `scripts/test-server-enrollment.cjs` (PGlite, following
  `test-provider-computer-ownership.cjs`): transitions, consume-once, replay,
  expiry at commit, concurrent confirm, known-identity refusal, the replacement
  functions (lease, attempts, revision, receipts), grants, RLS, EXECUTE
  revocation, events immutable by grants and trigger while the cascade still
  works, row counters matching events, retention sweep, account deletion, key
  wiping, discovery v2 commit checks, rebind after a replacement (T1, T3, T4,
  T22-T24, T27, T30, T41, T46).
- `dashboard/bootstrap/test_server_enroll.py` (Python `unittest`, like
  `test_hetzner_enroll.py`): sources the body under bash with side-effect
  commands as PATH stubs that record calls (`useradd`, `usermod`, `install`,
  `visudo`, `curl`, `userdel`, `loginctl`, `pkill`, `mv`, `rm`), and uses
  Python's `pty` for terminal cases. Covers T5, T7 (line and byte prefixes,
  with a stub on `PATH` for every prefix of each entry name), T9-T14, T28, T30,
  T35, T38-T40, T42, dry-run, re-enrollment and uninstall.
- `dashboard/scripts/test-server-enroll-host.py`: runs under `sudo` on the
  disposable CI runner (`HIVRA_DISPOSABLE_CI`, like the DeepSeek install tests in
  `public-release-safety.yml`). Real `useradd`, `visudo`, `sshd -T` and an
  actual key sign-in plus the exact sudo transport command against a local sshd
  where the runner has one, against a local fake report endpoint. With
  `use_pty` on and off: the T43 early-close check, and the T29 check that
  binary stdin, errexit, `ERR` traps and exit codes behave as under `bash -s`.
  The diagnosis paths of T28 against real sudo (a password-only user, a user
  whose rule allows only other commands). Then uninstall, and a check that
  nothing remains.
- Runner (`src/lib/services/__tests__/proxmox-host-script-runner.test.ts`,
  `proxmox-host-script-stdin.test.ts`): sudo transport command and framing,
  sentinel, the no-sentinel diagnosis, managed fleet and `login` unchanged,
  local-mode round trip (T12, T28, T29).
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
  `expiresAt`; the account code next to the command; fetch, refusal and
  download-limit lines; card fields, consent row and buttons; the known-server
  card with Replace instead of Yes, and each no-Replace copy; unsupported
  framing; the No path shows uninstall (T5, T25, T30, T32, T39, T40, T46).

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
3. **A terminal prompt** naming the receiving account by its account code before
   anything is sent or changed (T5). It is always asked when a terminal exists;
   `--yes` counts only without one, for automation. It adds one keypress. It
   slows the common paste-into-a-terminal attack; it cannot stop a command built
   to run without a terminal (section 14, remaining risks). The account code is
   new: a short value Hivra shows next to the command and in the account menu,
   because a masked email can be imitated with one sign-up.
4. **Three words shown in both places**, so "Is this your server?" can be
   answered by matching the terminal instead of recognising an IP address.
5. **An unsupported server can spend the code**, after a yes in the terminal,
   and gets the specific rebuild message in Hivra at once, framed as "a server
   used your command". Answering no sends nothing.
6. **No SSH connection before Yes**, including a reachability check.
   Unreachable servers are explained after confirmation, with **Check again**.
7. **IPv4 only on hosted Hivra**, refused at report with copy.
8. **A server already connected is never updated by Yes.** Replacing its access
   is a separate owner action, and Hivra signs in with the new key before
   changing anything (8.1).
9. **The advanced wizard keeps the pasted fingerprint as its default.** The
   proposal's trust-on-first-use capture is still offered, as a fallback with a
   warning, because it adds a first-contact interception risk the pasted
   fingerprint and the command don't have (8.2).

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
  terminal does not, and No leaves nothing trusted. The terminal of each run
  shows the account code of the account that issued the command, and it matches
  that account's menu.
- Replace drill on the AWS instance: run a new command on the connected
  instance; the card offers Replace, not Yes; Replace signs in, then the agent's
  computer opens again after the check. Then a forged report: from a second
  machine, with a second code in the same account, post a hand-made report
  that claims the instance's host key (read with `ssh-keyscan`); Replace fails
  at the sign-in, and the instance's connection, revision and computer are
  unchanged.
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
   origin, `trustedClientAddress`) with no behaviour change, and `accountCode`
   with the account-menu display.
2. Migration: tables, connection columns, discovery v2 checks, functions
   (including the replacement functions and the events guard trigger), grants,
   retention sweep; the PGlite suite.
3. Script body and uninstall mode, with the Python harness and disposable-runner
   test; pinned version and sha256.
4. Machine routes (`/enroll*`, report) with middleware exclusions and tests.
5. Owner routes (issue, status, confirm, replace, decline, cancel).
6. Runner sudo transport, discovery contract v2, gVisor runtime and preflight
   rules, Proxmox copy and the T43 gate, privilege outcome copy, and the
   retired-behaviour test updates.
7. UI: My server panel, "View the script first", "Is this your server?",
   the known-server card, connection-card receipts, uninstall on Disconnect;
   advanced wizard passphrase, sudo option and the key-capture fallback.
8. Account deletion list and retention cron.
9. Canary acceptance (section 18).
