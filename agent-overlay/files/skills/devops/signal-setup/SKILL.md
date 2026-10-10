---
name: signal-setup
description: Set up, link, or fix the Signal messenger integration on a Hermes box the DURABLE way - persisted JRE + signal-cli under ~/.hermes, never apt/sudo/container-layer installs. Use whenever the user asks to connect Signal, link their phone, or Signal stopped working ("JAVA_HOME is set to an invalid directory", daemon dead after an update).
version: 1.0.0
platforms: [linux]
environments: [docker]
metadata:
  hermes:
    tags: [signal, messaging, platform-setup, signal-cli, persistence]
---

# Signal setup on a Hermes box (the durable way)

The Signal platform (`gateway/platforms/signal.py`) does NOT talk to Signal
directly. It needs an external **signal-cli daemon** (a Java app) serving
HTTP on `SIGNAL_HTTP_URL` (default `http://127.0.0.1:8080`) inside the
gateway container. The gateway retries the adapter every 300s forever, so
once the daemon is up you never need to restart the gateway - watch for
`Signal: connected to <url>` in `~/.hermes/logs/gateway.log`.

## The one rule that matters: everything lives in ~/.hermes

Your container filesystem is **ephemeral** - every image update recreates it
- and on production boxes you have **no sudo**, so `apt-get install
default-jre` either fails or installs Java into a layer that will be wiped.
This exact failure killed a client's Signal integration: Java vanished on an
image update and the daemon died with `JAVA_HOME is set to an invalid
directory`.

Only `~/.hermes` (and `/workspace`) persist. Therefore:

| What | Where it must live |
|---|---|
| Java runtime (Temurin JRE) | `~/.hermes/jre/` |
| signal-cli install | `~/.hermes/signal-cli/` |
| Account/link keys (`--config`) | `~/.hermes/signal-data/` |
| Daemon log | `~/.hermes/logs/signal-cli.log` |

Never hardcode the home directory in scripts (`/home/hermes` has changed
before); derive paths from `$HERMES_HOME` or `$HOME`.

## Version coupling (the other recurring trap)

signal-cli releases are compiled for a specific Java major. **signal-cli
0.14.x needs Java 25** (class-file 69). `UnsupportedClassVersionError` at
daemon start = your JRE major is too old for the signal-cli build. Always
install the matching pair.

## Step 1 - check whether the platform already manages the daemon

Newer Hermes boxes run a platform supervisor that bootstraps and supervises
the daemon automatically the moment Signal credentials appear in the env.
Check for it:

```sh
ls /opt/hermes-platform/signal-daemon.sh 2>/dev/null && echo "platform-managed"
```

**If platform-managed:** do NOT install anything or run your own daemon.
Just make sure `SIGNAL_ACCOUNT` and `SIGNAL_HTTP_URL` are set (Step 3) -
the supervisor installs the JRE + signal-cli into `~/.hermes` and starts the
daemon within ~60s. Logs: `~/.hermes/logs/signal-cli.log`. To restart it,
kill the `signal-cli` process; the supervisor respawns it. Emergency version
pins: set `SIGNAL_CLI_VERSION` / `SIGNAL_JRE_MAJOR` in `~/.hermes/.env`.
Skip to Step 2 (linking).

**If not platform-managed:** install the persisted pair yourself (as your
normal uid - no sudo needed):

```sh
H="${HERMES_HOME:-$HOME/.hermes}"
arch=x64; [ "$(uname -m)" = aarch64 ] && arch=aarch64
# JRE 25 (matches signal-cli 0.14.x)
curl -fsSL -o ${TMPDIR:-/tmp}/jre.tgz "https://api.adoptium.net/v3/binary/latest/25/ga/linux/$arch/jre/hotspot/normal/eclipse"
mkdir -p "$H/jre" && tar -xzf ${TMPDIR:-/tmp}/jre.tgz -C "$H/jre" --strip-components=1
# signal-cli (pinned)
V=0.14.4.1
curl -fsSL -o ${TMPDIR:-/tmp}/scli.tgz "https://github.com/AsamK/signal-cli/releases/download/v$V/signal-cli-$V.tar.gz"
mkdir -p "$H/signal-cli" && tar -xzf ${TMPDIR:-/tmp}/scli.tgz -C "$H/signal-cli" --strip-components=1
mkdir -p "$H/signal-data" "$H/logs"
```

Then write a self-locating start script + a watchdog so the daemon survives
restarts. Put BOTH in `~/.hermes` and register the watchdog as a Hermes cron
job (every 5 min, `no_agent: true`):

```sh
cat > "$H/signal-start.sh" <<'EOF'
#!/bin/sh
HERMES_DIR="$(cd "$(dirname "$0")" && pwd)"
export JAVA_HOME="$HERMES_DIR/jre"
export PATH="$JAVA_HOME/bin:$PATH"
port="${SIGNAL_HTTP_URL##*:}"; case "$port" in ''|*[!0-9]*) port=8080;; esac
exec "$HERMES_DIR/signal-cli/bin/signal-cli" --config "$HERMES_DIR/signal-data" \
  daemon --http "127.0.0.1:$port" >> "$HERMES_DIR/logs/signal-cli.log" 2>&1
EOF
chmod +x "$H/signal-start.sh"
```

Watchdog: probe `"$SIGNAL_HTTP_URL/api/v1/check"`; if it fails, start
`signal-start.sh` in the background, then **sleep at least 12s** before
re-probing (JVM cold start - a 4s check false-negatives).

## Step 2 - register or link the account

Two options; both must use the persisted config dir.

**Link to the user's existing phone (most common).** Ask the user to open
Signal → Settings → Linked Devices, then:

```sh
H="${HERMES_HOME:-$HOME/.hermes}"
JAVA_HOME="$H/jre" PATH="$H/jre/bin:$PATH" \
  "$H/signal-cli/bin/signal-cli" --config "$H/signal-data" link -n "Hermes" 
```

This prints a `sgnl://linkdevice?...` URI - render it as a QR code for the
user (`qrencode -t ANSIUTF8` if available, or send them the URI). If a
platform-managed daemon is already running, prefer linking through it via
JSON-RPC (`startLink`/`finishLink` on `POST $SIGNAL_HTTP_URL/api/v1/rpc`) so
you don't contend for the account database; if you must use the CLI while
the daemon runs, stop the daemon first and let the supervisor respawn it
after.

## Step 3 - configure the platform env

Set in `~/.hermes/.env` (or have the user use the dashboard's
Integrations → Signal form, which writes the same keys):

```
SIGNAL_ACCOUNT=+15551234567     # E.164, the linked/registered number
SIGNAL_HTTP_URL=http://127.0.0.1:8080
```

The gateway supervisor restarts the gateway on .env changes automatically.
Optional hardening: `SIGNAL_ALLOWED_USERS`, `SIGNAL_GROUP_ALLOWED_USERS`,
`SIGNAL_REQUIRE_MENTION=true`.

## Step 4 - verify end to end

```sh
curl -fsS -X POST "$SIGNAL_HTTP_URL/api/v1/rpc" \
  -d '{"jsonrpc":"2.0","method":"listAccounts","id":1}'   # → your account
tail -f ~/.hermes/logs/gateway.log | grep -m1 "Signal: connected to"  # ≤5 min
```

Then send the bot a Signal message and confirm a reply.

## Troubleshooting

- `JAVA_HOME is set to an invalid directory` → Java was installed in the
  ephemeral layer and got wiped. Reinstall into `~/.hermes/jre` (Step 1).
- `UnsupportedClassVersionError` → JRE major doesn't match the signal-cli
  build. signal-cli 0.14.x ⇒ Java 25.
- Daemon up but gateway not connecting → wait ≤300s (adapter retry loop);
  confirm `/api/v1/check` returns 200 from INSIDE the gateway container.
- Port already in use → another daemon copy is running (platform supervisor
  or watchdog). Don't run two; use the existing one.
- Account gone after an update → data was in `~/.local/share/signal-cli`
  (ephemeral). Re-link into `~/.hermes/signal-data`; newer platform versions
  rescue this automatically on first daemon start.
