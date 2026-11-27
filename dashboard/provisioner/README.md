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
- Outbound internet (the script pulls bux from GitHub, the pinned Chrome `.deb` from
  Google's download pool (checked against its SHA-256), and Node/skills via the bux
  installer).
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
| `CHROME_VERSION` / `CHROME_LINUX_AMD64_SHA256` | from `chrome-pin.json` | The pinned Google Chrome `.deb` and its SHA-256. Leave unset on managed computers so the installer and the runtime updater read the same pin; set both to override. |
| `CDP_PORT` | `9222` | Local Chrome remote-debugging port. |
| `PROFILE_DIR` | `/home/bux/.browser-profile` | **Must be non-default** (see gotcha #1). |
| `HIVRA_CHAT_PORT` | `8080` | Hivra chat HTTP port. |
| `DUMMY_BU_KEY` | `local` | Dummy `BROWSER_USE_API_KEY` (installer requires one; we self-host). |
| `CLAUDE_CODE_VERSION` / `CODEX_CLI_VERSION` | upstream's newest npm release | Resolved at install time from the npm registry's `latest` tag. Set only to install a specific version. |
| `AEON_REF` / `OPENCLAW_VERSION` / `AGENT_ZERO_IMAGE_DIGEST` | upstream's newest | Resolved at install time: the Aeon repository's `HEAD` commit, OpenClaw's npm `latest`, the digest behind `agent0ai/agent-zero:latest`. Set only to install a specific version. |

### Agent CLI versions

Hivra pins no Claude Code or Codex version. A new computer installs each
CLI's newest npm release, and after that only the owner updates it: the
Update button (below) or the CLI's own npm command. Hivra never updates a CLI
by itself, and the vendors' background self-updaters stay off
(`DISABLE_AUTOUPDATER=1` for every CLI the gateway starts and on both terminal
units, and Codex's `check_for_update_on_startup = false`, set by
`hivra-codex-config-pin.py` only when the owner has not chosen), so a CLI never
swaps itself under a running chat. The agent terminal runs the exact binary
the chat gateway runs and never falls back to another vendor's CLI.

When the owner updates, `hivra-update-guest-runtime.sh` reports the installed
version (`HIVRA_AGENT_CLI` line, `target=latest`) and starts
`hivra-agent-cli-update.sh` as a transient unit: it resolves the newest npm
release (and ends at once when that is installed already), downloads it,
waits until no chat run is in flight (up to 6 hours), holds new runs back for
the few seconds of the swap, verifies the new version and restores the previous
package on failure. The gateway reports the installed version and the swap's
progress to the dashboard as `agentCli` on authenticated `GET /api/meta`.

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

## Architecture notes

[Read the detailed portable provisioner architecture](https://github.com/ashneil12/hivra/blob/canary/docs/release/PORTABLE-PROVISIONER-ARCHITECTURE.md). The notes are kept in the repository rather than copied into each guest.

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
