#!/usr/bin/env bash
# Remove the Hivra connector and everything install.sh created. Hivra can no
# longer reach this machine through the relay afterwards. Run as root.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run this as root (sudo)." >&2; exit 1; }
systemctl disable --now hivra-connector.service 2>/dev/null || true
rm -f /etc/systemd/system/hivra-connector.service
systemctl daemon-reload 2>/dev/null || true
rm -rf /opt/hivra-connector /etc/hivra-connector
id hivra-connector >/dev/null 2>&1 && userdel hivra-connector || true
echo "Hivra connector removed. Also disconnect this machine in Hivra to revoke its credential."
