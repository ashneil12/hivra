#!/usr/bin/env bash
# Install the Hivra connector. Run as root with the connector configuration
# (issued by Hivra for this machine) on standard input:
#
#   sudo bash install.sh < config.json
#
# It creates an unprivileged hivra-connector user, installs the program to
# /opt/hivra-connector and its configuration to /etc/hivra-connector (0640,
# readable only by root and that user), checks the relay accepts it, then
# enables the systemd service. It changes nothing else on the machine.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Run this as root (sudo)." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required." >&2; exit 1; }

config="$(mktemp)"
trap 'rm -f "$config"' EXIT
cat > "$config"
python3 - "$config" <<'PY'
import json, sys
json.load(open(sys.argv[1]))
PY

id hivra-connector >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hivra-connector
install -d -m 0755 -o root -g root /opt/hivra-connector
install -m 0644 -o root -g root "$here/hivra_connector.py" /opt/hivra-connector/hivra_connector.py
install -d -m 0750 -o root -g hivra-connector /etc/hivra-connector
install -m 0640 -o root -g hivra-connector "$config" /etc/hivra-connector/config.json

if ! runuser -u hivra-connector -- python3 /opt/hivra-connector/hivra_connector.py check --config /etc/hivra-connector/config.json; then
  echo "The relay did not accept this connector. Nothing was enabled." >&2
  exit 1
fi

install -m 0644 -o root -g root "$here/hivra-connector.service" /etc/systemd/system/hivra-connector.service
systemctl daemon-reload
systemctl enable --now hivra-connector.service
echo "Hivra connector is running. Return to Hivra to finish connecting this machine."
