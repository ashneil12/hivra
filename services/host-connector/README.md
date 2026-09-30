# hivra-connector

A small outbound connector for machines hosted Hivra cannot reach directly
(home or office machines with no inbound ports). It keeps one WebSocket to
Hivra's [relay](../host-relay-worker/) and, when Hivra asks, joins a session to
this machine's SSH server on `127.0.0.1`. Nothing the relay sends can change
that address. SSH stays end to end, and the host key Hivra pinned at
"Is this your server?" is checked on every session.

- Python 3.8+ standard library only (stock Ubuntu 22.04 and 24.04).
- Runs as its own unprivileged `hivra-connector` user under a hardened systemd
  unit ([hivra-connector.service](hivra-connector.service)).
- Configuration: `/etc/hivra-connector/config.json` (root-owned, 0640), issued
  by Hivra for this machine: relay URL, connection id, generation, secret, and
  optionally the local SSH port.
- Exit status 3 means Hivra revoked it; systemd leaves it stopped.

**Status:** built and tested locally; the one-command enrollment will install
it. Not in use yet.

```sh
sudo bash install.sh < config.json   # installs, checks the relay accepts it, starts it
sudo bash uninstall.sh               # removes the service, user, program and config
python3 -m unittest -v test_hivra_connector
```
