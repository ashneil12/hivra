#!/usr/bin/env bash
# Hivra: set this computer up for the local bridge. It lets an agent ask to run
# one command here, and nothing runs until you approve that command in Hivra.
# The bridge only dials out to Hivra; nothing on your router or firewall
# changes. Run it as yourself, not with sudo. Source:
# https://github.com/ashneil12/hivra/tree/canary/services/host-connector
set -euo pipefail
umask 077
origin='@@ORIGIN@@'
code="${1:-}"
if ! [[ "$code" =~ ^hvb_[A-Za-z0-9_-]{32}$ ]]; then
  echo "Use the full command from Hivra, including the code at the end." >&2
  exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run this with sudo or as root. It sets the bridge up for your own account." >&2
  exit 1
fi
if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
  echo "Your home folder could not be found." >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) echo "This works on a Mac or on Linux." >&2; exit 1 ;;
esac
for tool in curl base64 mktemp; do
  command -v "$tool" >/dev/null || { echo "$tool is required." >&2; exit 1; }
done
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  echo "The bridge needs Python 3.8 or newer, and python3 was not found." >&2
  if [ "$os" = mac ]; then echo "Install it from https://www.python.org/downloads/ or run: xcode-select --install" >&2
  else echo "Install it with your package manager, for example: sudo apt install python3" >&2; fi
  echo "Then run the same command again." >&2
  exit 1
fi
python="$(command -v python3)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

program_dir="$HOME/.hivra-bridge"
config_dir="$HOME/.config/hivra-bridge"
config="$config_dir/config.json"
shared="$HOME/Hivra"
mkdir -p "$program_dir" "$config_dir" "$shared"
chmod 700 "$program_dir" "$config_dir"

# @@FILES@@

# The code works once and expires in 15 minutes. What it returns is written to
# the bridge's own config (readable only by you) and never printed.
if ! curl -fsS --max-time 30 -X POST -H 'content-type: application/json' \
  --data "{\"token\":\"$code\"}" "$origin/api/hivra/bridge/enrol" > "$tmp/enrol.json"; then
  echo "Hivra did not accept that code. It may have expired or been used. Get a new command in Hivra." >&2
  exit 1
fi
"$python" -I - "$tmp/enrol.json" "$config" "$shared" <<'PY'
import json, os, sys
source, target, shared = sys.argv[1:4]
with open(source, "r", encoding="utf-8") as handle:
    settings = json.load(handle)
if not isinstance(settings, dict) or "bridgeKey" not in settings:
    sys.exit("Hivra's reply was not what the bridge expects.")
folders = [shared]
try:
    with open(target, "r", encoding="utf-8") as handle:
        kept = json.load(handle).get("allowedFolders")
    if isinstance(kept, list) and kept:
        folders = kept  # setting up again keeps the folders you chose
except (OSError, ValueError, AttributeError):
    pass
settings["allowedFolders"] = folders
partial = target + ".new"
descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump(settings, handle, indent=2)
os.replace(partial, target)
os.chmod(target, 0o600)
PY

start_hint="$python $program_dir/hivra_bridge.py run --config $config"
started=no
if [ "$os" = mac ]; then
  label=cloud.hivra.bridge
  agents="$HOME/Library/LaunchAgents"
  plist="$agents/$label.plist"
  mkdir -p "$agents"
  xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$python")</string>
    <string>$(xml "$program_dir/hivra_bridge.py")</string>
    <string>run</string>
    <string>--config</string>
    <string>$(xml "$config")</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- No KeepAlive on purpose: a bridge that was revoked in Hivra stays stopped. -->
  <key>StandardErrorPath</key><string>$(xml "$config_dir/bridge.err")</string>
</dict>
</plist>
PLIST
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  if launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || launchctl load -w "$plist" >/dev/null 2>&1; then started=yes; fi
  stop_hint="launchctl bootout $domain/$label"
else
  unit_dir="$HOME/.config/systemd/user"
  unit="$unit_dir/hivra-bridge.service"
  esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g'; }
  mkdir -p "$unit_dir"
  cat > "$unit" <<UNIT
[Unit]
Description=Hivra bridge (lets your agents run commands you approve)
After=network-online.target

[Service]
ExecStart="$(esc "$python")" "$(esc "$program_dir/hivra_bridge.py")" run --config "$(esc "$config")"
Restart=on-failure
RestartSec=10
# Exit status 3 means Hivra revoked this bridge: it stays stopped.
RestartPreventExitStatus=3

[Install]
WantedBy=default.target
UNIT
  if systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
    if systemctl --user enable --now hivra-bridge.service >/dev/null 2>&1; then started=yes; fi
  fi
  stop_hint="systemctl --user disable --now hivra-bridge.service"
fi

echo
if [ "$started" = yes ]; then
  echo "Done. The bridge is running and will start again when you log in."
else
  echo "The bridge is installed, but this computer would not start it for you."
  echo "To run it now, in this terminal (Ctrl-C stops it):"
  echo "  $start_hint"
fi
echo
echo "Shared folder: $shared"
echo "Commands you approve in Hivra start there. To allow more folders, edit \"allowedFolders\" in"
echo "  $config"
echo "(your whole home folder is not allowed), then restart the bridge."
echo
if [ "$started" = yes ]; then echo "To stop it: $stop_hint"; else echo "To stop it: press Ctrl-C in the terminal running it."; fi
echo "Pressing Revoke in Hivra also turns it off. Nothing runs here until you approve it in Hivra."
