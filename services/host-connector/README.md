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

**Status:** built and tested locally. Hivra's one-command enrolment now installs
it (`curl -fsSL <app>/api/infrastructure/home-connector/install | sudo bash -s -- <one-time code>`;
the code works once, expires in 15 minutes and is exchanged for this machine's
config, so no long-lived secret lands in shell history). That flow is behind
`HIVRA_HOME_CONNECTOR_ENABLED`, **off by default**, and the relay is not
deployed, so nothing uses it yet. The installer carries copies of
`hivra_connector.py`, `hivra-connector.service` and `install.sh` kept
identical in `dashboard/bootstrap/home-connector/` (a test enforces it).

```sh
sudo bash install.sh < config.json   # installs, checks the relay accepts it, starts it
sudo bash uninstall.sh               # removes the service, user, program and config
python3 -m unittest -v test_hivra_connector
```
