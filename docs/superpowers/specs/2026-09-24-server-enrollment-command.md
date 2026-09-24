# My server: one-command enrollment, design and threat model

Date: 2026-09-24
Status: Proposed design and threat model, written before implementation. Nothing
in this document is implemented. No route, table, script or UI described below
exists yet. Merging slice 13 needs this document reviewed first.
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
defends one side.

## 2. What exists today (verified in code, 2026-09-24)

| Area | Current behaviour | Evidence |
| --- | --- | --- |
| Manual SSH path | Owner pastes a private key that already signs in, and a SHA-256 host fingerprint read off the server. No passphrase field. | `InfrastructureConnectionWizard.tsx:633-702` |
| Privilege | Discovery counts only `id -u` = 0 as privileged. gVisor requires the SSH user to be the literal string `root`. Proxmox preflight also checks `id -u`. | `host-discovery.ts:253, 481, 627`; `gvisor-computer-service.ts:137, 232`; `gvisor-target.ts:75, 88`; `proxmox-preflight.ts:618` |
| Privilege copy | "Hivra needs a root login on … Let root sign in with your SSH key". | `host-discovery-outcome.ts:143-152`; `connection-preflight.ts:105` |
| Hetzner first boot | A 256-bit `hbe1_` capability, 15-minute TTL, verifier digest bound to owner/connection/order/attempt/recipe, delivered in cloud-init, posted back with the Ed25519 host key in an `Authorization` header, consumed once in SQL, identical replays acknowledged. | `first-boot-enrollment.ts`, `first-boot-receiver.ts`, `api/infrastructure/first-boot/enroll/route.ts`, migration `20260827190000` |
| Machine-route hardening | No query string, browser `Origin`/`Sec-Fetch-Site` refused, strict JSON, no `Content-Encoding`, 2 KB body with 5 s read deadline, constant `{accepted:false}` denials, allowlisted log fields. | `first-boot/enroll/route.ts` |
| Middleware | Exact-path Clerk exclusion for the receiver, listed in both matcher entries and pinned by `proxy-config.test.ts`. | `src/proxy.ts:47-83` |
| Trusted origin | Callback origin comes from `NEXT_PUBLIC_APP_URL`, never request headers; validated as bare `https://host`. | `hetzner-cloud/capacity/route.ts:141-150`; `firstBootCallbackUrl` |
| Reachability probe | Before a guided purchase, Hivra checks the machine endpoint answers the constant 401 JSON (not a login redirect). | `first-boot-callback-readiness.ts` |
| Pinned helper | The guest helper's sha256 is a constant; the file is refused if it differs. | `first-boot-cloud-init.ts:11, 46-56` |
| Key generation | Ed25519 generation with rejection sampling around an `ssh2` leading-zero bug. | `hetzner-cloud.ts:265-300` |
| Pinned SSH | User connections refuse to run without a pinned fingerprint; `hostVerifier` compares SHA-256. The first-boot client also restricts `serverHostKey` to `ssh-ed25519`. | `proxmox-instance-service.ts:1510-1517, 1616-1630`; `first-boot-ssh.ts:307` |
| SSRF guard | SSH destinations are resolved once; any reserved answer fails the hostname; loopback, link-local and metadata stay blocked even when self-host private networks are allowed. | `connection-runtime.ts:81-147` |
| Rate limits | In-memory fixed windows per serverless instance, keyed by `getIP()`. | `rate-limit.ts:15, 188-197` |

What this design reuses from the Hetzner first-boot machinery:

| Reused as-is | Extracted and shared | Pattern copied | Not applicable |
| --- | --- | --- | --- |
| `encryptSecret`/`decryptSecret` with a purpose tag; `readBoundedJson`, `hasStrictJsonContentType`, `isSameOriginMutationRequest`; `resolveValidatedSshDestination`; `reservedAddressReason`; the pinned-SSH runner | `canonicalFirstBootHostKey` becomes a shared `canonicalEd25519HostKey`; the rejection-sampling key generator leaves `hetzner-cloud.ts` for a shared module; `firstBootCallbackUrl`'s origin validation becomes a shared `trustedAppOrigin()` | Machine-route hardening; exact-path middleware exclusion; reachability probe; pinned-file sha256 constant; private table with RLS, revoked grants, guard trigger and SECURITY DEFINER transitions; consume-once plus identical-replay acknowledgement | Provider API evidence, metadata server ID, cloud-init, firewall-before-power, creation receipts |

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
- Password-only servers with no sudo user: out of scope. The command needs a
  user who can run `sudo` (or a root shell).
- Non-x86 and non-supported operating systems enroll no user. The script reports
  what it found so Hivra can say why (6.1, step 5).
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
> Works with Ubuntu 22.04 or 24.04 on x86, or Proxmox VE 8 or 9. The server must
> accept SSH from the internet. Home or office machine? Hosted Hivra can't reach
> private networks yet.
>
> *Waiting for your server… no contact yet · 0:41* — check your terminal if nothing happens.
> [Connect with SSH details instead (advanced)]

The origin in the command is the deployment's own `NEXT_PUBLIC_APP_URL` (Canary
shows the Canary origin). The code is never put in a link or the page URL.

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
> | Reported by the server | ip-172-31-4-9 · Ubuntu 24.04 · x86 · 4 CPU · 16 GB |
> | Your terminal shows | **amber falcon river** |
> | Server identity | SHA256:Xb…9Q [Copy] |
>
> Only choose Yes if your terminal shows these three words. If your terminal
> said the command was already used, someone else has your command: choose No.
>
> **[Yes, this is my server]** **[No, cancel]**
> Hivra will connect to 203.0.113.24 on port 22 as hivra. [Use a different address]

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
| Redemption | Fetching the script does not use the code (so `--dry-run` and "view first" keep it valid). The code is spent by exactly one accepted report: `issued → reported` or `issued → unsupported`, in one conditional `UPDATE … WHERE phase = 'issued' AND expires_at > clock_timestamp()`. A byte-identical repeat of the accepted report gets the same acknowledgement and changes nothing (network retries). Anything else after that is refused. |
| Active limit | At most 3 unexpired, unanswered codes per user. |

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

In order. It stops at the first failure and undoes anything it changed:

1. Requires bash, and effective UID 0 (from `sudo bash` or a root shell). Sets
   `PATH=/usr/sbin:/usr/bin:/sbin:/bin`, `LC_ALL=C`, `umask 077`,
   `set -Eeuo pipefail`. Redirects its own stdin from `/dev/null`, so no
   command it runs can read further piped input.
2. Reads facts, read-only: `/etc/os-release` `ID` and `VERSION_ID`, `uname -m`,
   CPU count, `MemTotal`, `hostname`, `systemd-detect-virt`, `pveversion` if
   present, and the effective sshd settings for user `hivra` from `sshd -T -C
   user=hivra,host=hivra-check,addr=127.0.0.1` (port, `authorizedkeysfile`,
   `pubkeyauthentication`, `allowusers`/`allowgroups`/`denyusers`/`denygroups`,
   and the Ed25519 `hostkey` path). Each value must match a strict pattern, or
   it is sent as null. Nothing else is read: no interface addresses, MAC
   addresses, machine-id, user lists or files outside those listed.
3. Takes the host key from the Ed25519 private key that sshd actually uses
   (`ssh-keygen -y -f <hostkey path>`), so the key reported is the key sshd
   presents. No Ed25519 host key: stop, and say so.
4. Checks what it needs, without changing anything. Otherwise it stops with one
   plain sentence, and the code stays valid for a re-run:
   - `sudo` installed. Proxmox VE ships without it: "This server doesn't have
     sudo. Install it with `apt install sudo`, then run the command again."
   - sshd would let `hivra` sign in with a key (no `AllowUsers`/`AllowGroups`
     that excludes it, public-key auth on, `authorizedkeysfile` a supported
     `%h`/`%u` pattern).
   - No `hivra` user exists, or the one that exists has Hivra's marker
     (`/etc/hivra/enrollment.json`). A foreign `hivra` user is never taken
     over. A Hetzner server Hivra created has no marker, so it is refused and
     sent back to its Hetzner card.
5. If the server is not Ubuntu 22.04/24.04 x86_64 or Proxmox VE 8/9 x86_64, it
   sends an `unsupported` report (facts only, no host key, no user) and stops.
   That spends the code, and Hivra shows the specific rebuild instruction
   (INF-05 copy). Hivra re-checks support against the same shared rules, and
   Hivra's answer wins.
6. Prints the plan (4) and asks `Continue? [y/N]` on `/dev/tty`. With no
   terminal, it stops unless `--yes` was passed.
7. Creates `hivra`: `useradd --create-home --user-group --shell /bin/bash
   --comment Hivra hivra`, then `usermod -p '*' hivra`. That makes password
   sign-in impossible while keeping key sign-in valid when sshd has
   `UsePAM no`; a `!` lock would block keys there.
8. Writes exactly one line to hivra's authorized keys file (mode 0600, owner
   hivra): `restrict ssh-ed25519 <Hivra's public key> hivra-enrollment`.
   `restrict` turns off port, agent and X11 forwarding and PTYs. The Hivra
   runner uses only non-PTY `exec` today (`proxmox-instance-service.ts:1649`).
   A future feature that needs more must bump the script version.
9. Writes `/etc/sudoers.d/hivra-enrollment` (`hivra ALL=(ALL:ALL) NOPASSWD:
   ALL`) to a temporary file, checks it with `visudo -cf`, then installs it as
   0440 root:root with a rename. It never edits `/etc/sudoers`. The file name
   has no dot, because sudo skips such files.
10. Writes the marker, `/etc/hivra/enrollment.json` (0644, root, no secrets:
    script version, origin, pending status, admin-key fingerprint, host-key
    fingerprint, time).
11. Sends one HTTPS report (section 7). It tries IPv4 first, so the address
    Hivra sees is IPv4 where one exists. At most 6 attempts in 90 s, retrying
    only 408/429/5xx and network errors, with the same body each time.
12. On `accepted`: marks the marker connected (adds the enrollment id), disarms
    the rollback, and prints the words. On any definite refusal or a timeout:
    rolls back steps 7-10 of this run and prints the reason.

It installs no packages and changes no firewall, sshd configuration, services,
timers or cron. It leaves nothing running, and contacts only the one origin
named in its last line.

### 6.2 Served form, integrity and "view the script first"

The script is one file in the repo, `dashboard/bootstrap/server-enroll.sh`. It
is the **body**: function definitions only, so running it alone does nothing.
Its sha256 is a constant next to its version (`SERVER_ENROLL_SCRIPT_VERSION`,
date-based like `FIRST_BOOT_RECIPE_VERSION`). The route refuses to serve if the
file on disk hashes differently (as `loadEnrollmentHelper` does), and a test
fails if the version and sha256 are not bumped together. The file joins
`outputFileTracingIncludes` for the `/enroll` routes.

Every response is the body plus **one final line**:

```
hivra_enroll_entry 'https://hivra.cloud' 'hse1_<32 base32 characters>' 'ssh-ed25519 <68 base64 characters>' 'sam***@example.com' "$@"
```

| Route (GET, no session) | Final line |
| --- | --- |
| `/enroll` with a usable code in `Authorization` | `hivra_enroll_entry …` as above |
| `/enroll` with no code, or an unknown, expired, used or cancelled code | `hivra_refuse 'expired_or_used'` (or `'missing_code'` when no header was sent), which prints one sentence and exits 1. The body and line are byte-identical for every unusable code. |
| `/enroll/uninstall` | `hivra_uninstall_entry "$@"` |
| `/enroll/script` | none: the bare body, `text/plain`, to read |
| `/enroll/script.sha256` | the body's sha256 |

Why this form:

- **Truncation-safe.** Nothing runs until the last line arrives, so a download
  cut short runs nothing.
- **The same for everyone.** The body does not vary with requester, User-Agent,
  timing or code, so it can be checked against the public repo. Only the final
  line differs, and it holds four values, each checked against a strict pattern
  before rendering: origin (`trustedAppOrigin()`), code (`^hse1_[a-z2-7]{32}$`),
  key (`^ssh-ed25519 [A-Za-z0-9+/]{68}$`) and account label
  (`^[a-z0-9]{1,3}\*\*\*@[a-z0-9.-]{1,253}$`, or the fixed text `your Hivra
  account`). None can contain a quote, so single-quoting is exact. Rendering
  throws instead of escaping.
- **Verifiable in two commands.** "View the script first" shows the body, its
  version and sha256 (also in the repo and at `/enroll/script.sha256`), the
  final line for this command, and the sha256 of the whole download for this
  command (computed at issue). Then:

  ```
  curl -fsS --proto '=https' -H 'Authorization: Bearer hse1_…' https://hivra.cloud/enroll -o hivra-enroll.sh
  sha256sum hivra-enroll.sh                 # matches "your download" in Hivra
  head -n -1 hivra-enroll.sh | sha256sum    # matches the published script
  less hivra-enroll.sh
  sudo bash hivra-enroll.sh
  ```

  Downloading does not spend the code.

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

The code exists in the user's shell history and, for about a second, in the
argv of the `curl` they ran. After that, it lives only in bash memory. The
report goes through `curl --config <(printf …)` and `--data-binary @<(…)`, so
the code is in no process's argv or environment and never reaches disk. The
marker holds no secret. The residual risk is shell history and the brief `ps`
window. Both expire with the code, which is spent seconds later.

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
contents of a re-enrolled user, and removes a pending marker. If the rollback
itself fails, the script prints the exact commands to finish it and the
uninstall command. A key left on a server is useless once the row expires,
because the sealed private key is wiped.

### 6.6 Running it again (re-enrollment)

On a server with Hivra's marker, the prompt adds: "This server is already
connected to a Hivra account (set up 2026-09-20 from https://hivra.cloud).
Continuing replaces that access with this account's." The script replaces the
whole authorized-keys file with the new key and leaves the sudoers file alone
if it is byte-identical. The previous connection then fails to sign in, and
Hivra maps that failure to "Hivra's key was removed from this server. Run a new
setup command to reconnect." In the same account, confirming a server whose
pinned identity matches an existing connection updates that connection's key
(its revision goes up and its evidence is superseded) instead of making a
duplicate.

### 6.7 Uninstall

`curl -fsS --proto '=https' https://hivra.cloud/enroll/uninstall | sudo bash`
serves the same pinned body with the uninstall entry. It needs no code and
contacts no one. It supports `--dry-run` and asks before changing anything. It
refuses to act unless the marker is present. It ends hivra's sessions
(`loginctl terminate-user`, then `pkill -u hivra`), runs `userdel -r hivra`,
removes `/etc/sudoers.d/hivra-enrollment` only if it is byte-identical to what
Hivra writes, and removes the marker. It then says plainly what it left:
"Software that Prepare installed (Docker, gVisor, Proxmox settings) is not
removed. Remove agents' computers in Hivra first." Hivra learns of the uninstall
only when its next sign-in fails. **Disconnect** in Hivra deletes the private
key whether or not the uninstall ran, and shows the uninstall command.

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
   "hostPublicKey":"ssh-ed25519 …","adminKeyFingerprint":"SHA256:…","sshPort":22,
   "reenrollment":false,
   "facts":{"hostname":"ip-172-31-4-9","osId":"ubuntu","osVersionId":"24.04",
            "architecture":"x86_64","cpuCount":4,"memoryBytes":16729309184,
            "virtualization":"kvm","proxmoxVersion":null}}
  ```

  `kind:"unsupported"` sends null `hostPublicKey`, `adminKeyFingerprint` and
  `sshPort`.
- Order of checks: code pattern → IP rate limit → look up `code_sha256` →
  per-code limit → schema → `scriptVersion` on the allowlist (current and
  previous release) → `adminKeyFingerprint` equals the row's key → host key
  through `canonicalEd25519HostKey` → trusted client address (section 10) →
  support re-check → one SQL transition. SQL rechecks phase and expiry at
  commit, stores the report and its digest, chooses three words from a fixed
  256-word list with `crypto.randomInt`, and appends a `reported` event.
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
  `invalid_report` (400) and `not_usable` (401: unknown, expired, used or
  cancelled codes, and a changed body after a report; the same bytes every
  time). A 429 or 503 means try again. The script rolls back on 400, 401 and
  422.
- Log fields are an allowlist only: failure class, script version, a
  public/private address class. The code, headers, body, keys and address are
  never logged.

## 8. "Is this your server?" and trust on first use

The report proves only that someone holding the code, with root on some
machine, answered within the window. It does not prove the machine is the
owner's. So a report makes nothing trusted:

- Before Yes, Hivra opens no SSH connection, creates no connection row, and
  runs nothing.
- The card separates "Connected from (seen by Hivra)", which Hivra observed,
  from "Reported by the server", which a malicious server could forge. It also
  shows the three words and the identity fingerprint.
- **Yes** is an owner-session, same-origin POST. In one SECURITY DEFINER
  transaction it: locks the row; checks the owner, `reported` phase, `confirm_by`
  and expiry; checks the plan's connection limit; applies the duplicate-host
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

Today privilege means "the SSH login is UID 0". Target:

1. **Connection field** `infrastructure_connections.ssh_privilege text not null
   default 'login' check (ssh_privilege in ('login','sudo'))`. `login` runs host
   scripts as the SSH user, as today. `sudo` runs every host script through
   `sudo -n`. Existing rows keep `login`, so root connections behave exactly as
   before. The field is one of the revision-bound operational fields in
   `update_infrastructure_connection`: changing it raises the revision and
   supersedes discovery, preflight and target evidence.
2. **One wrapper in the runner.** `buildUserProxmoxEnvironment` passes
   `PROXMOX_SSH_PRIVILEGE=sudo` for such connections. `runProxmoxHostInvocation`
   wraps the fixed remote command only when `HIVRA_USER_INFRA_CONNECTION=true`
   and that variable is `sudo`:
   `/usr/bin/sudo -n -- /usr/bin/true 2>/dev/null || { printf 'HIVRA_SUDO_UNAVAILABLE\n' >&2; exit 97; }; exec /usr/bin/sudo -n -- <fixed command>`.
   The managed fleet never sets it. No user input enters the wrapper. `-n` never
   waits for a password, and the sentinel maps to the privilege outcome. Sudo
   logs each command line on the server, which gives the owner an audit trail.
   So secrets must travel on stdin only
   (`runProxmoxHostScriptWithStdin`), never in a script body.
3. **Discovery.** Under `sudo`, the unchanged discovery script runs through the
   wrapper, reports EUID 0, and every root-based requirement is computed as
   before. Under `login` with a non-root user, the script adds one read-only
   probe: `timeout 5 sudo -n -- /usr/bin/id -u`, only when `sudo` exists. This
   becomes `environment.passwordlessSudo`. The snapshot also records
   `environment.privilegeVia: "login" | "sudo"` from the connection. These two
   fields bump `HOST_DISCOVERY_CONTRACT_VERSION` to 2, and the parser still
   reads v1 snapshots until they expire.
4. **Outcome copy** (privilege stays the first blocker, INF-04):
   - with passwordless sudo: "ubuntu can use sudo without a password. **[Use
     sudo for setup]**", an owner action that updates the connection (revision
     bump) and inspects again;
   - without: "Signed in as ubuntu without passwordless sudo. Run the setup
     command with sudo, or connect as a user who has it."
   The nested-KVM message never appears when privilege is the blocker.
5. **gVisor.** A shared `hasHostAdministratorAuthority(connection, snapshot)`
   replaces the three `sshUser === "root"` checks. It is true for `login` with
   user `root`, or for `sudo`, in both cases with a current snapshot whose
   `privilegeVia` matches the connection and whose EUID is 0. The adapter
   identity guard, including its `root:root` ownership checks, is unchanged
   because it runs as root through the wrapper.
6. **Proxmox.** Preflight's `id -u` check is unchanged (0 through the wrapper).
   The `PROXMOX_PERMISSION_UNAVAILABLE` remediation becomes "connect as root, or
   as a user with passwordless sudo". Enrolling a PVE node uses a local `hivra`
   user, not a key for root. On PVE, `/root/.ssh/authorized_keys` usually links
   to the cluster-shared `/etc/pve/priv/authorized_keys`, so a root key would
   grant every node in the cluster.

Hivra gets full administrator access either way. A sudoers rule narrower than
`ALL` would be for show, because Hivra's fixed scripts run through
`bash`. The command page, the terminal prompt and the confirmation card all say
"administrator (sudo) access".

## 10. Network boundary: SSRF, the observed address, home machines

- **Observed address.** The address on the card comes from the platform's own
  client address, never from the report. `getIP()` is not used for it: it
  prefers `cf-connecting-ip`, which a client can set on a deployment not
  fronted by Cloudflare (section 16). A new `trustedClientAddress(request)`
  reads only the header the platform overwrites. On Vercel, that is the
  first-hop client address Vercel writes into `x-forwarded-for`/`x-real-ip`.
  This must be confirmed on Canary with a spoofed-header request before relying
  on it. Self-hosted deployments name their trusted header in configuration.
  With none configured, the card has no "seen by Hivra" row and asks the owner
  for the address.
- **Checks.** At report and again at Yes: `net.isIP`, and `reservedAddressReason`
  must be null. Private and CGNAT ranges are allowed only with the self-host
  `HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS=true`. Loopback, unspecified, link-local
  and metadata addresses are always refused. Every later SSH connection goes
  through `resolveValidatedSshDestination`, as today.
- **Nothing reported is fetched or resolved.** The hostname is display-only and
  is never looked up in DNS. The port is an integer used only for SSH to the
  observed or owner-entered address. Hivra makes no HTTP request to anything the
  server reported.
- **Script side.** It contacts only the origin in its last line (`https:`, a
  validated hostname, from `NEXT_PUBLIC_APP_URL`), with curl's normal
  certificate checks, `--proto '=https'`, `--max-redirs 0`, never `-k`.
- **Home and private networks.** A home machine calls back from its router's
  address. On hosted Hivra, a private or CGNAT address is refused at report and
  the script rolls back. A public router address passes, but after Yes the SSH
  connection fails. The card then says: "Hivra couldn't reach 203.0.113.24 on port
  22. Allow SSH from the internet in your provider's firewall (on AWS, the
  security group), then check again. Home or office machines aren't supported
  yet." Hivra's functions connect from changing addresses, so the firewall must
  allow SSH from anywhere. Key-only sign-in and the `restrict` option make that
  acceptable, and the page says it plainly.
- **Before showing a command**, the panel checks that the report endpoint
  answers the constant 401 JSON. That is the `isFirstBootCallbackReachable`
  pattern, so a preview behind deployment protection shows "Setup commands
  aren't available on this deployment" instead of a command that can't work.

## 11. Rate limits

The in-memory limiter is per serverless instance, and its IP key can be spoofed
(section 16). It only sheds load. The real bounds are durable and live in SQL.

| Surface | Best-effort (memory) | Durable (SQL) |
| --- | --- | --- |
| Issue a code | 10/min per user and IP | ≤ 3 active per user, taken under a per-user advisory lock; ≤ 30 issued per user per 24 h |
| `GET /enroll` | 60/min per IP; bad format answered without a database read | ≤ 20 script fetches per code, after which the refusal script is served |
| Report | 30/min per IP (as first boot); 12/min per code after the format check | One accepted report per code; after 10 refused reports, the code is cancelled ("Get a new command") |
| Status poll | 120/min per user | — |
| Yes / No / cancel | 20/min per user | Row lock; one outcome |
| Advanced key capture (8) | 10/min per user | — |

429 responses carry `Retry-After`, and the UI turns it into "You can try again
in N minutes" (`retry-after-copy.ts`).

## 12. Audit receipts

`infrastructure_server_enrollment_events` is append-only. Service role gets
insert and select only; update and delete are revoked from everyone. Kinds:
`issued`, `script_served` (counted, not one row per fetch), `refused_report`
(counted), `reported`, `unsupported`, `confirmed`, `rejected`, `cancelled`,
`expired`, `connection_created`, `identity_mismatch`. Each row holds the
enrollment id, user id, time, actor (`owner` or `server`), script version, the
observed address for `reported`, and the host fingerprint where relevant. No
row holds the code, its hash, a key or the report body.

The owner sees these on the connection card: "Connected with the setup command
on 24 Sep at 12:04 from 203.0.113.24 · identity SHA256:Xb…9Q · confirmed by you
at 12:05." The enrollment row's report (facts, fingerprint, observed address,
words) is kept as the connection's identity receipt while the connection exists
and for 90 days after it is removed. Unused rows are deleted 30 days after
expiry.

## 13. Data model (target; migrations land with the implementation)

- `infrastructure_server_enrollments`: `id`, `user_id`, `code_sha256` (unique),
  `phase`, `issued_at`, `expires_at` (= issued + 15 min, checked),
  `script_version`, `account_label`, `admin_public_key`,
  `admin_key_fingerprint`, `sealed_admin_private_key` (null outside `issued` and
  `reported`), `script_fetches` (≤ 20), `refused_reports` (≤ 10),
  `reported_at`, `confirm_by` (= reported + 30 min), `report_digest`,
  `observed_address`, `ssh_port`, `host_public_key`, `host_fingerprint_sha256`,
  `facts jsonb` (bounded), `words`, `decided_at`, `connection_id` (unique,
  `on delete set null`).
- `infrastructure_server_enrollment_events` as in section 12.
- `infrastructure_connections`: `ssh_privilege` (section 9), and
  `ssh_host_key_type` (null or `ssh-ed25519`).
- Every new table has RLS enabled and is revoked from `public, anon,
  authenticated`, with explicit service-role grants (the default-privilege
  trap noted in `scripts/test-provider-computer-ownership.cjs`). A guard
  trigger enforces transitions. SECURITY DEFINER functions
  `issue_server_enrollment`, `record_server_enrollment_fetch`,
  `report_server_enrollment`, `confirm_server_enrollment`,
  `decline_server_enrollment` and `expire_server_enrollments` each have
  `set search_path = public, pg_temp` and EXECUTE revoked from `public, anon,
  authenticated`.
- File timestamps come after every existing migration, and the manifest is
  regenerated.

Existing hosts, existing root connections and in-flight Hetzner first-boot
enrollments are untouched. Nothing about them changes, and the shared helpers
are extracted with their tests unchanged.

## 14. Threats, mitigations and tests

Test files are named for the implementation; §15 lists them.

| # | Threat | Mitigation | Test |
| --- | --- | --- | --- |
| T1 | Guessing a code online | 160-bit code; pattern check before any read; memory and durable limits; 15-minute life | Generator emits `^hse1_[a-z2-7]{32}$` from 20 random bytes; pattern-invalid codes never reach the store (spy); the 21st fetch and the 11th refused report are refused (PGlite) |
| T2 | Code leaks before use (screen share, chat paste, clipboard manager, shell history) and an attacker reports first | One report spends the code, so the owner's own run then fails with "already used"; nothing is trusted before Yes; the card shows observed address, words and fingerprint, with "No" guidance | Second report with a different body → 401, row unchanged (PGlite and route); no SSH or connection row before confirm (spy on runner and RPC); card copy snapshot |
| T3 | Code leaks after use | Spent; only a byte-identical replay is acknowledged, with no state change | Replay after `reported` → same acknowledgement, one event; replay after `confirmed` → 401 |
| T4 | Database or log read exposes codes or keys | Only `code_sha256` stored; private key sealed with a purpose tag and wiped in terminal phases; allowlisted logging | Store never receives the raw code (spy); check constraint rejects a key in terminal phases (PGlite); route logger calls contain only allowlisted keys |
| T5 | Someone is tricked into running an attacker's command (consent phishing for root) | Terminal prompt names the receiving account (masked email) and says to continue only if it is theirs and they copied it themselves; default is No; `--yes` only for automation; uninstall | Harness: no tty and no `--yes` → exit, no side effects; the prompt contains the label from the final line; answer `n` → no side effects |
| T6 | Tampered script (TLS interception, swapped file, varying content for `curl \| bash`) | HTTPS with normal certificate checks and `--proto '=https'`; body is a pinned file refused if its sha256 differs; identical for every requester; body sha256 published in the repo, the UI and `/enroll/script.sha256`; verify recipe | Route test: body identical across User-Agents, headers and codes; a changed file → 503, nothing served; version and sha256 constants change together |
| T7 | A truncated download runs half the script | Body is only function definitions; one final call line | Harness runs every line-prefix of the served script with side-effect functions stubbed: none called |
| T8 | Injection through server-rendered values | Four values checked against strict patterns, never escaped, always single-quoted; rendering throws otherwise | Render refuses quotes, `$(`, backticks, newlines, NUL and Unicode in each field; property test over random strings |
| T9 | Injection through local data (hostname, `os-release`, sshd output) | Check then interpolate; no `eval`; all expansions quoted; `--` before operands; absolute paths; failing values sent as null | Harness with hostile `os-release`, hostname and `sshd -T` fixtures: report JSON is valid, values null, no command executed |
| T10 | A hostile or garbled acknowledgement (terminal escapes, fake instructions) | Fixed-format lines checked by pattern; never executed; the script's actions do not depend on response content beyond accepted/refused | Harness: acknowledgement with escapes, extra lines or oversize → treated as failure, rollback, nothing printed from it |
| T11 | Code visible on the server (argv, environment, disk) | Header only in the user's own `curl`; after that, bash memory and process-substitution pipes | Harness records every child argv and environment: the code appears in none; no file under the test root contains it; marker has no secret |
| T12 | Passwordless sudo widens what Hivra can do | Stated in three places; per-enrollment key with `restrict`; password sign-in impossible; `visudo`-checked 0440 drop-in; Disconnect deletes the key; uninstall; `sudo` used only for connections that recorded it | Harness: exact sudoers bytes, `visudo -cf` invoked, key-line bytes, `usermod -p '*'`; runner test: managed-fleet environment never wraps; `login` connections never wrap |
| T13 | Taking over an existing `hivra` user or clobbering files | Refuse a `hivra` user without the marker; refuse a foreign `hivra-enrollment` sudoers file; uninstall removes only byte-identical files | Harness: foreign user → exit, no changes; foreign sudoers → exit; uninstall leaves a modified sudoers file |
| T14 | A failed run leaves access behind | Trap rollback until `accepted`; printed manual commands if rollback fails; sealed key wiped at expiry | Harness: 401, 422, timeout and malformed acknowledgement each roll back user, sudoers and marker; PGlite: sweep nulls keys of expired rows |
| T15 | SSRF through the enrollment | Observed address from the trusted platform header only; reserved-range refusal; nothing reported is fetched or resolved; owner-entered addresses use `resolveValidatedSshDestination` | Report with loopback, metadata, link-local and private observed addresses → 422 on hosted; DNS lookup spy never called with the reported hostname; confirm with an edited address runs the resolver |
| T16 | Spoofed client-address headers make the card show the victim's server | `trustedClientAddress` ignores `cf-connecting-ip` and client-supplied `x-forwarded-for` hops, reading the platform header only; the words plus pinned sign-in still stop a forged report | Unit: a spoofed `cf-connecting-ip` does not change the observed address; **Canary check** with a spoofed header (live acceptance) |
| T17 | Interception of Hivra's first SSH connection | The key comes over TLS from the box before any SSH; the first connection must present that exact Ed25519 key; `serverHostKey` restricted | Runner test: a different presented key → refused before authentication, `identity_mismatch` event, both fingerprints in the DTO |
| T18 | A server lies about its facts | Facts labelled "reported"; support and readiness come from pinned-SSH discovery and preparation evidence; a lying server can only affect its owner's own agents | Report facts never feed `requirementsForEngine`; discovery after confirm recomputes |
| T19 | Cross-site issue, confirm or cancel (CSRF) | Clerk session; `isSameOriginMutationRequest`; strict JSON; owner check in SQL | Route tests: missing/foreign `Origin` → 403; another user's enrollment id → 404; PGlite: confirm with the wrong user → no change |
| T20 | Telling unknown codes from expired or used ones | One refusal script and one 401 body for every unusable code | Byte equality across unknown, expired, used and cancelled codes (route tests) |
| T21 | Floods and large or slow bodies | Limits in §11; 2 KB body and 5 s read deadline; format check before the database | 413/408 paths; limit refusals with `Retry-After`; no store call for malformed input |
| T22 | A double Yes or a race creates two connections | Row lock; `connection_id` unique; the phase guard | PGlite: two concurrent confirms → one connection, one `confirmed` event |
| T23 | Expiry races (report or Yes lands just after the deadline) | `expires_at`/`confirm_by` checked at commit with `clock_timestamp()` | PGlite with a mocked clock: commit after the deadline → refused |
| T24 | Denial ("I never connected that") | Append-only events; receipt kept with the connection | PGlite: every transition writes one event; update and delete refused for service role and everyone else |
| T25 | The code reaches platform or app logs | Never in a URL; app logs allowlisted; the GET and report never echo it | Route tests: no response header or log argument contains the code; UI never renders the code in an `href` |
| T26 | A browser or CDN caches the served script | `no-store, private`; text/plain; nosniff; no redirects | Header assertions on every `/enroll*` response |
| T27 | Stale evidence after a privilege change | `ssh_privilege` is revision-bound; snapshots record `privilegeVia` and must match | Update to `sudo` raises the revision and marks targets superseded; gVisor refuses a snapshot whose `privilegeVia` differs |
| T28 | `sudo` asks for a password and hangs, or is missing | `sudo -n`; sentinel exit 97 mapped to the privilege outcome; the script checks `sudo` exists before changing anything | Runner test for the sentinel; outcome test for both copies; harness: missing sudo → exit, no changes |
| T29 | Secrets appear in sudo logs | Privileged script bodies are fixed source; secrets only on stdin | Test pins that secret-carrying operations use `runProxmoxHostScriptWithStdin` and their script bodies contain no secret fixture |
| T30 | The same server in two accounts, or connected twice | Re-enrollment replaces the key after a prompt naming the old origin; same-account duplicates update the existing connection | Harness re-enroll path; PGlite duplicate-fingerprint confirm → existing connection updated, revision bumped |
| T31 | Old script versions with bugs keep being accepted | Report allowlist of current and previous version only; the served body is always current | Report with an unknown `scriptVersion` → 400 and a refused-report count |
| T32 | Owner says Yes without looking | Words and "choose No if your terminal said already used"; No is as prominent as Yes; a forged report still has to pass pinned sign-in to be useful | Card test: both buttons same weight; words rendered from the row. Remaining risk is stated in the copy |
| T33 | Server rebuilt on the same address | Pinned mismatch shows both fingerprints and "Run a new setup command to reconnect" | Mismatch outcome copy test |
| T34 | Home or private machine expected to work | Refused at report on hosted; unreachable-after-Yes copy; command page says so up front | Report 422 on private addresses; unreachable outcome copy test |
| T35 | The script fetches or runs more code | No downloads, installs, services or extra network calls; one origin | Harness: network stub sees only the report POST; package manager and `systemctl` stubs never called |

Remaining risks, accepted: the code sits in the user's shell history and
briefly in `ps` until it is spent; the Hivra origin itself is a trust root, as
it already is for the dashboard; a server administrator who enables sudo I/O
logging records Hivra's stdin on their own machine; an owner who clicks Yes
without reading can confirm a forged report. In that last case the forged server
still needs Hivra's key installed by its own run, which means it belongs to the
attacker. Hivra would then launch that owner's future agents on the attacker's
machine. That is why the words and the "already used" guidance are on the card.

## 15. Tests

New (jest unless noted):

- `src/lib/infrastructure/__tests__/server-enrollment-code.test.ts`: format,
  entropy source, hash-at-rest purpose prefix, one-time display.
- `src/lib/infrastructure/__tests__/server-enrollment-script.test.ts`: pinned
  sha256 and version, final-line rendering and refusals (T6, T8), identical
  body.
- `src/app/enroll/__tests__/route.test.ts`, plus `uninstall` and `script`
  variants: headers, refusal equality, fetch counting, no redirects (T20, T25,
  T26).
- `src/app/api/infrastructure/server-enrollments/report/__tests__/route.test.ts`
  and `src/lib/infrastructure/__tests__/server-enrollment-receiver.test.ts`:
  hardening, check order, statuses, replay, allowlisted logging (T2-T4, T15,
  T21, T31).
- `src/app/api/infrastructure/server-enrollments/__tests__/*.test.ts`: issue,
  status, confirm, decline, cancel (T19, T22).
- `src/lib/__tests__/trusted-client-address.test.ts` (T16).
- `scripts/test-server-enrollment.cjs` (PGlite, following
  `test-provider-computer-ownership.cjs`): transitions, consume-once, replay,
  expiry at commit, concurrent confirm, grants, RLS, EXECUTE revocation,
  append-only events, key wiping (T1, T3, T4, T22-T24, T30).
- `dashboard/bootstrap/test_server_enroll.py` (Python `unittest`, like
  `test_hetzner_enroll.py`): sources the body, with its last line absent, under
  bash; replaces the side-effect functions (`hivra_useradd`, `hivra_install_file`,
  `hivra_post_report` and so on) with recorders. Covers T5, T7, T9-T14, T28,
  T30 and T35, dry-run, re-enrollment and uninstall.
- `dashboard/scripts/test-server-enroll-host.py`: runs under `sudo` on the
  disposable CI runner (`HIVRA_DISPOSABLE_CI`, like the DeepSeek install tests in
  `public-release-safety.yml`). Real `useradd`, `visudo`, `sshd -T` and an
  actual key sign-in plus `sudo -n id -u` against a local sshd where the runner
  has one, against a local fake report endpoint. Then uninstall, and a check
  that nothing remains.
- Runner and discovery: sudo wrapper and sentinel, managed fleet never wrapped,
  sudo probe parsing, contract v2 with v1 still read, `privilegeVia` matching
  (T12, T27-T29).
- `src/__tests__/proxy-config.test.ts`: the new exact exclusions exist in both
  matcher entries where required, resolve to real routes, and leave siblings
  protected.
- Next config: `/enroll` routes include `bootstrap/server-enroll.sh`.
- UI: the panel never puts the code in an `href` or storage; countdown from
  `expiresAt`; card fields and buttons; the No path shows uninstall (T25, T32).

Existing tests that assert retired root-only behaviour, to update in slice 13
and name in its commit: `host-discovery-outcome.test.ts` and
`InfrastructureHostDiscoveryResult.test.tsx` ("Hivra needs a root login",
`connect-as-root`); `connection-preflight.test.ts`
(`PROXMOX_PERMISSION_UNAVAILABLE` remediation); the gVisor service and target
tests that expect "requires a root Linux host connection".

## 16. Discrepancies found while writing this

- **`getIP()` trusts `cf-connecting-ip` first** (`rate-limit.ts:188-197`). Where
  Cloudflare does not front the deployment and strip that header, a client can
  choose its own rate-limit key. Whether Canary or production is fronted by
  Cloudflare was not checked. That makes this a possible code defect for
  in-memory rate limiting. It is also why the enrollment's observed address
  must not use `getIP()`. Fix it separately with its own test; this design does
  not depend on the fix.
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
3. **A terminal prompt** naming the receiving account before any change (T5),
   with `--yes` for automation. It adds one keypress, and it is the only defence
   the server side has against being tricked into running a command.
4. **Three words shown in both places**, so "Is this your server?" can be
   answered by matching the terminal instead of recognising an IP address.
5. **An unsupported server spends the code** and gets the specific rebuild
   message in Hivra immediately, instead of a silent wait.
6. **No SSH connection before Yes**, including a reachability check.
   Unreachable servers are explained after confirmation, with **Check again**.

## 18. Acceptance

The slice is done only when all of these pass on Canary's Git-built deployment
at the merge SHA:

- A real AWS Ubuntu 24.04 instance, signed in as `ubuntu`: run the command →
  terminal prompt → words match → Yes → "Ready for Linux Sandbox" → launch an
  agent → chat. (This is the proposal's slice-13 acceptance. Creating paid
  capacity needs the owner's approval for that exact target.)
- Same instance: uninstall, then Hivra reports it can no longer sign in, and
  Disconnect removes the connection.
- Leaked-code drill on Canary with two accounts: the second machine reports
  first, the owner's run says "already used", the card shows words the owner's
  terminal does not, and No leaves nothing trusted.
- A spoofed `cf-connecting-ip` and `x-forwarded-for` on the report does not
  change "Connected from".
- `curl` to `/enroll` on Canary gets the script, not a Clerk or protection
  redirect.
- Proxmox VE 8 via sudo: preflight and a Proxmox launch through the wrapper.
- An IPv6-only server: record what happens; this has not been verified.
- Script behaviour in at least one provider web console (paste support,
  `/dev/tty`).

Until then the capability is unimplemented. Nothing in this document claims a
working enrollment command.

## 19. Implementation order

1. Shared extractions (host-key canonicalisation, key generator, trusted
   origin, `trustedClientAddress`) with no behaviour change.
2. Migration: tables, connection columns, functions, grants; the PGlite suite.
3. Script body and uninstall mode, with the Python harness and disposable-runner
   test; pinned version and sha256.
4. Machine routes (`/enroll*`, report) with middleware exclusions and tests.
5. Owner routes (issue, status, confirm, decline, cancel).
6. Runner sudo wrapper, discovery contract v2, gVisor authority, Proxmox copy,
   privilege outcome copy, and the retired-behaviour test updates.
7. UI: My server panel, "View the script first", "Is this your server?",
   connection-card receipts, uninstall on Disconnect; advanced wizard
   passphrase, sudo option and trust-on-first-use.
8. Canary acceptance (section 18).
