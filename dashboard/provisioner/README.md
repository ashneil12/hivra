# Hivra portable provisioner

This directory is the versioned runtime installed by Hivra on a user-owned
Proxmox VE host. It creates one KVM virtual machine per agent and can install
Claude Code, Codex, Aeon, OpenClaw, or Agent Zero inside the guest.

For a Proxmox host, run `prepare-proxmox-host.sh` as root. Preparation installs
this exact bundle under `/opt/hivra/provisioner`, creates a host-to-guest key,
downloads the Ubuntu cloud image, and creates an isolated NAT bridge. It does
not create an agent VM; launches happen only after a successful read-only
preflight and an explicit launch request.

The scripts accept supported environment overrides for bridge, storage,
network, image, and key paths. No provider, Hivra fleet, or model credential is
embedded in this bundle.

Release `2026.08.27.1` also lets the guest installer explicitly use
`HIVRA_COMPUTER_SUBSTRATE=provider-vm`, which omits the Proxmox-only QEMU guest
agent requirement. The default remains `proxmox-kvm` and still requires that
agent. This flag does not create, enroll, expose or publish a provider computer;
automatic Hetzner preparation and placement remain separate integration gates.
Both paths currently require amd64 artifacts. Unknown runtime/substrate values
fail before package installation rather than choosing another agent.

The control plane accepts the exact reviewed Proxmox predecessor
`2026.08.26.10` while it remains on the compatible-release list, retaining its
actual observed version and requiring its existing checksums and capabilities.
Preparing a host installs the current bundle only after explicit approval;
deploying the dashboard does not upgrade existing hosts or guests. The new
provider-VM flag is not advertised for the predecessor.

Release `2026.08.27.2` bounds the Proxmox guest's initial SSH/cloud-init check to
60 probes and ten minutes of Linux monotonic uptime, whichever comes first.
Only a clean `status: done` permits runtime installation. Failed, degraded,
disabled, malformed and late results fail closed into the existing owned-VM
cleanup; guest diagnostic output is not copied into control-plane logs. This
does not bound the later package installation or upgrade installed hosts. The
exact `.26.10` and `.27.1` releases retain their existing lifecycle compatibility
without acquiring this new check.

Release `2026.08.27.3` installs the native agent terminal and general box terminal
inside the shared guest installer, including for an explicitly selected provider
VM. Both run as `bux`, start in `/home/bux`, and listen only on loopback at
`/terminal/` and `/box-terminal/`. The external authenticated access layer is
unchanged and is still configured separately. Each terminal service and HTTP
endpoint must pass a readiness check. Missing/invalid runtime selections show
an actionable error; they never launch a different agent. This does not itself
activate automatic Hetzner setup, and dashboard deployment does not update
existing guests or hosts.

Release `2026.08.27.4` adds the shared `hivra-install-agent.py` entrypoint. An
authorized lifecycle worker streams a versioned JSON document through stdin
with the selected agent, substrate, browser choice, model settings and optional
named-tunnel token. It synchronously runs the existing guest installer and
configures the named tunnel; a provider VM requires a named tunnel. It does not
allocate a computer, choose an agent, acquire lifecycle authority, or certify
public reachability. The Proxmox caller continues to own those responsibilities.
Package installation is not newly bounded by this extraction; the provider
worker's durable deadline/recovery remains an integration gate.

Named-tunnel setup reconciles matching root-owned configuration and restarts
only its own service to ensure that process loaded the checked token and unit.
An explicit installation replay can therefore reconnect the tunnel; it is not
a seamless live update. Different credentials, custom units/drop-ins,
unsafe files and service errors stop setup with an explicit repair requirement.
It never kills unrelated `cloudflared` processes or tmux sessions. Model keys
are supplied to the runtime's existing environment interface; the tunnel token
is written only to the private service environment file, not process arguments.
The existing direct shell-installer interface remains available for advanced
use. This change does not enable public Hetzner agent launch or upgrade hosts.

## Guest runtime background

`2026.08.31.2` also includes a private typed DeepSeek guest path under the existing
installation lock, not an enabled catalog launch. Only a fresh provider VM with
a verified root-owned source bundle may bootstrap the base; exact owned replays
skip that mutable base. An explicit canonical ASCII-DNS HTTPS origin is mandatory.
Direct HTTPS must match its assigned hostname; control-plane named-origin binding
remains a gate before public dispatch. Legacy Proxmox temporary copies and quick
tunnels are not eligible. The original five launch choices/v1 documents are unchanged.

Package/gateway/config/unit differences and changed browser intent require explicit
repair, not overwrite. Nonempty legacy model fields are rejected for v2; native
Models setup owns keys until typed custody is implemented. The native web profile
owns sessions; its terminal opens a labelled computer shell, not a competing
session owner. Real guest/public access and cancellation reconciliation remain
pending. The following describes the existing coding-agent surface.

`2026.08.31.3` stages a private worker-v2 native cleanup obligation and retains
the stop-only code closure before dispatch. Explicit cancellation stops the
native service only after the installer is fenced and empty; an old successful
or failed installer outcome is never rewritten to acknowledge later cleanup.
Cancellation disables the exact owned unit; boot-bound receipts and read-only
state verification prevent an old cleanup cache from hiding a restarted service.
Status does not execute native cleanup. The server-side v2 dispatch and database
release fence remain disabled pending their separate implementation and tests.

`2026.08.31.4` keeps the same staged native lifecycle and closes a gateway
credential-boundary defect: after the outer gateway authenticates a Hivra
management bearer or browser session, that replayable authority is removed
before HTTP or WebSocket traffic reaches bux-owned terminal, VNC or runtime
backends. Unrelated backend cookies and non-Hivra authorization schemes remain.
This release change does not enable DeepSeek in the public catalog.

The runtime began as the following Claude Code box and has since been extended
to the other catalog agents.

A single idempotent script that turns a **fresh Ubuntu 22.04 box** into the
Claude-Code-in-the-cloud agent that was first validated on a disposable lab computer.
Built on top of [`browser-use/bux`](https://github.com/browser-use/bux),
with the cloud browser swapped for a **self-hosted Chrome on the box** and a
**Hivra-branded** chat surface + system prompt.

## What it gives you

- **Claude Code CLI** (`/usr/bin/claude`), Node 24, `ttyd`, the
  `browser-harness-js` browser skill, and a dedicated `bux` agent user — all
  from the stock bux installer.
- **A self-hosted browser**: real Google Chrome (.deb) running headless on
  `127.0.0.1:9222`, supervised by `bux-local-browser.service`, with a persistent
  profile. No Browser-Use-Cloud dependency. The agent connects via the
  `browser-harness-js` skill using `{ profileDir }`.
- **The Hivra streaming chat surface** at `http://<box>:8080` —
  `bux-hivra-chat.service`, a thin Node frontend that spawns the **official
  `claude` CLI** (`claude -p --output-format stream-json`) and streams its NDJSON
  to the browser. Not the Agent SDK; stays on the ToS-permitted side and uses the
  user's own login.
- **A Hivra system prompt** (clean cloud-assistant persona, local-browser
  instructions) replacing bux's Telegram/agency persona.

## Prerequisites

- A **fresh Ubuntu 22.04** box (amd64) reachable over SSH, with `sudo`/root.
- Outbound internet (the script pulls bux from GitHub, Chrome from Google's apt
  repo, and Node/skills via the bux installer).
- ~4 GB RAM minimum (Chrome pushes the box well past bux's 2 GB baseline). The
  reference box is 4 vCPU / 6 GB / 40 GB.

## Usage

```bash
# copy this whole directory to the box, then:
sudo ./provision-claude-code-box.sh
```

The script is **idempotent** — re-running it is safe (it skips the bux installer
and Chrome install if already present, and re-applies the overlay + prompt).

### Tunables (env overrides)

| Var | Default | Notes |
|---|---|---|
| `AGENT_USER` | `bux` | **Pinned** — the bux installer + keeper hardcode `bux`; the script hard-fails on any other value. |
| `BUX_DIR` | `/opt/bux` | **Pinned** — bux's unit `ExecStart` paths hardcode `/opt/bux`; the script hard-fails on any other value. |
| `BUX_REF` | `f17c1b31d6688dd92e745ade650e00d46b4dc4da` | Reviewed bux commit. |
| `CDP_PORT` | `9222` | Local Chrome remote-debugging port. |
| `PROFILE_DIR` | `/home/bux/.browser-profile` | **Must be non-default** (see gotcha #1). |
| `HIVRA_CHAT_PORT` | `8080` | Hivra chat HTTP port. |
| `DUMMY_BU_KEY` | `local` | Dummy `BROWSER_USE_API_KEY` (installer requires one; we self-host). |

## The one manual step

Login is the user's own native OAuth — **not** baked into the image:

```bash
sudo -iu bux claude auth login        # prints an OAuth URL
# authorize in a browser, paste the returned <code>#<state> into the prompt
sudo -iu bux claude auth status       # should show authMethod=claude.ai, subscriptionType=max
```

Credentials land in `/home/bux/.claude/.credentials.json`. `claude setup-token`
is the alternative long-lived-token path.

> Headless paste tip: drive the login over `tmux` (`tmux new-session` + `tmux
> load-buffer` / `paste-buffer`). Use `load-buffer`, not a here-string through
> `sudo`, or the `#` in the code gets reconstructed as a shell comment and the
> code is truncated.

## What it does, step by step

1. **Base packages** — curl, git, tmux, gnupg, etc.
2. **Stock bux** — clones `browser-use/bux` to `/opt/bux` and runs `install.sh`
   with `BROWSER_USE_API_KEY=<dummy>` and `WITH_ZTK=0`. Cloning to `/opt/bux`
   (not `curl | bash`) is required because the systemd units hardcode
   `/opt/bux/agent/*`.
3. **Google Chrome stable** — adds Google's apt repo, installs
   `google-chrome-stable` (the `.deb`, **not** snap).
4. **Browser overlay** — disables + removes the cloud keeper unit
   (`bux-browser-keeper.service`), drops in `local-browser-keeper.py`, creates the
   non-default profile dir, installs `bux-local-browser.service`.
5. **Hivra chat** — deploys `hivra-chat/{server.js,index.html,app.js}` to
   `/opt/bux/hivra-chat` and installs `bux-hivra-chat.service`.
6. **System prompt** — overwrites `/home/bux/system-prompt.md` with the Hivra
   prompt and re-points the `~/CLAUDE.md` / `~/AGENTS.md` symlinks the installer
   made (the `claude` CLI reads `~/CLAUDE.md`, and hivra-chat runs `claude` with
   `cwd=$HOME`).
7. **Enable + start** the overlay services and run bounded post-flight checks
   (requested browser services active, `browser.env` valid for the configured
   CDP port, local CDP and noVNC answering with HTTP 200, and `/healthz`
   answering with HTTP 200). After those checks, write and checksum the private
   `/var/lib/hivra/runtime-receipt.json` installed-state inventory, derived
   CycloneDX `/var/lib/hivra/runtime-sbom.cdx.json`, and exact
   `/var/lib/hivra/runtime-notice-manifest.json`. The current schema recursively
   inventories regular packages beneath the selected global runtime roots, so
   nested npm dependencies and duplicate versions are bound by their install
   paths rather than being silently omitted. These root-only artifacts bind
   package/artifact identities, observed license/notice-file hashes and explicit
   review gaps; they never contain credentials, user files, browser profiles or
   process environments, and they never claim release approval.

For an already-running Proxmox computer, `hivra-update-guest-runtime.sh VMID IP`
updates only the Hivra Chat connection-service assets and then verifies secure
surface authentication plus unchanged agent identity/API-token metadata. The
dashboard owns the lifecycle lock and performs the reboot after this helper
returns a verified receipt; the helper never powers the VM on or off itself.

## Architecture notes

- **Cloud-coupling swap.** bux's only cloud dependency is its browser keeper,
  which POSTs to Browser-Use-Cloud and writes `BU_CDP_WS` into
  `/home/bux/.claude/browser.env`. The overlay's `local-browser-keeper.py` writes
  the **same** `browser.env` contract pointing at the local Chrome, so everything
  downstream (agent + `browser-harness-js`) is unchanged.
- **Chat transport.** `POST /api/chat {message, sessionId}` starts the agent CLI
  (`claude` with the prompt on **stdin**, so arbitrary user text never hits arg
  parsing) and streams its NDJSON events as a chunked response. Multi-turn is
  via `--resume <session_id>` (client captures `session_id` from the
  `system/init` and `result` events). Server uses only Node built-ins — no
  `package.json`, no `npm install`.
- **Detached chat runs.** Each turn runs under its own runner process
  (`hivra-chat/chat-runs.cjs`) that owns the CLI and writes the stream to
  `~/.hivra/chat-runs/<runId>/events.ndjson`; the HTTP response only tails that
  log. With `{detach: true, runId, clientRef}` a closed tab or dropped network
  no longer ends the turn: `GET /api/chat/runs` lists recent runs,
  `GET /api/chat/runs/<id>/events` replays one from the start (live until it
  finishes) and `POST /api/chat/runs/<id>/stop` is the only way to end it early.
  Requests without `detach` keep the historical contract (their disconnect
  stops the turn). The `10-hivra-detached-runs.conf` drop-in sets
  `KillMode=process` on `bux-hivra-chat.service`, so a gateway restart (runtime
  update, crash) leaves in-flight runs working; permission flags are unchanged.
- **Agent terminal.** For Claude Code and Codex, `hivra-agent-shell` runs the
  CLI inside a private tmux session (`tmux -L hivra-agent`, session named after
  the CLI). Closing the Terminal tab detaches; reopening it re-attaches to the
  same session.
- **Surface authentication.** `/api/meta` advertises `surfaceAuth: "post-cookie-v1"`.
  The dashboard checks that capability without credentials, then POSTs the
  bearer to `/auth/bootstrap` to obtain an opaque, HttpOnly session cookie and
  redirect to a clean local URL. Terminal, browser, and native dashboard links
  never put the bearer in a URL. Older connection services without this
  capability require an explicit runtime update before those surfaces open;
  header-authenticated API access remains unchanged.
- **Aeon fork sync.** The Aeon dashboard saves every config edit into `~/aeon`
  and pushes it with a plain `git push`. After GitHub connect, and on every
  gateway start, the gateway makes that clone push-capable against the user's
  fork: `gh auth setup-git` for HTTPS credentials, the GitHub account (and its
  noreply address) as the clone's commit identity, and a local branch tracking
  the fork's default branch. Edits made on the computer are committed and
  replayed onto the fork (only this computer's own commits: the depth-1
  template checkout's shallow boundary marks where they begin); edits that
  cannot be applied stay on a local `hivra/unpushed-edits-<time>` branch.
  Hivra's `apps/dashboard/next.config.ts` is never pushed. Workflows GitHub
  disabled by itself (`disabled_fork`, `disabled_inactivity`) among `aeon.yml`,
  `scheduler.yml`, `messages.yml`, `chain-runner.yml` and `setup-commands.yml`
  are enabled; a manual disable is left alone. The outcome is written to
  `~/.hivra/aeon-connect.json` and returned as `connect` by
  `GET /api/login/status`.

## Gotchas (do NOT reintroduce these)

1. **Chrome 136+ refuses remote-debugging on its DEFAULT profile.** Since Chrome
   136 (anti-cookie-theft), `--remote-debugging-port` is ignored if
   `--user-data-dir` is the default `~/.config/google-chrome`. You **must** use a
   custom profile dir (we use `/home/bux/.browser-profile`). This also breaks the
   harness's no-arg `session.connect()` auto-detect, which only scans default
   dirs — hence the agent connects with `{ profileDir }`.
2. **Headless Chrome doesn't write `DevToolsActivePort` into a custom dir.**
   `--headless=new` skips writing that file when `--user-data-dir` is custom, but
   the harness's `{ profileDir }` connect form reads it. So
   `local-browser-keeper.py` writes it itself, in Chrome's exact 2-line format
   (line 1 = port, line 2 = `/devtools/browser/<uuid>`).
3. **`process.env.BU_CDP_WS` does NOT reach harness snippets.**
   `browser-harness-js` runs a persistent Bun server; snippet evals execute in
   the server's environment, not the caller's. Connect with `{ profileDir }`, not
   env or `wsUrl`. (Also: harness snippets are an ES module — `require()` is
   undefined; use `Bun.write`.)
4. **The Node `req.on('close')` kill bug.** In Node 18+, `req` `'close'` fires as
   soon as the request **body** is fully read — using it to kill the child would
   SIGTERM `claude` instantly (`_done code:null`). The server kills the child on
   `res.on('close')` (client disconnect) guarded by a `finished` flag, and never
   on `req` close. Keep it that way.
5. **cloudflared quick tunnels need `--protocol http2`.** If you expose the chat
   via a `trycloudflare` quick tunnel, the default QUIC/UDP transport does not
   survive the box's double-NAT (the tunnel never registers; CF error 1033).
   Always run `cloudflared tunnel --protocol http2 --url http://localhost:8080`.
   Quick tunnels are ephemeral (URL changes on restart, not reboot-safe); for
   anything real use a named tunnel or route through the host Caddy/gateway.

## Self-host tradeoffs (carried over from the dogfood)

- **Datacenter egress IP** → more anti-bot blocks than a residential browser.
  Likely needs a residential-proxy egress for productization.
- **No CAPTCHA solver / no hosted live-view relay** (`live.browser-use.com`) —
  on login walls / 2FA / CAPTCHA, the agent stops and tells the user what's
  blocking instead of solving it.
- **Headless** today; Xvfb + headful is the realism upgrade.

## Exposure is intentionally NOT configured

The script does not open the chat to the internet. Decide per deployment:
named cloudflared tunnel, the host Caddy/gateway, or a quick tunnel (with
`--protocol http2`, for testing only).
