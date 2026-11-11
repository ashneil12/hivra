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

## Local bridge (user mode, off unless you start it)

Behind the server flag `HIVRA_LOCAL_BRIDGE_ENABLED` (off by default).
`hivra_bridge.py` lets an agent run one command, as you, on your own computer.
It is not the system connector: you start it, and stopping it is the off switch.

- Dials out to the relay; nothing listens on this machine. One message type,
  `exec`: an argv list (never a shell string), a `cwd` inside a folder you list
  in `allowedFolders` (your home folder alone is refused; with no `cwd` the
  first folder is used), `timeoutSeconds` up to 120 and `maxOutputBytes` up to
  1 MiB. No terminal, port forwarding or file transfer.
- Every request carries a ticket (at most 120 s, single use) bound to you, one
  agent, this computer and the exact argv and cwd, signed with `bridgeKey` =
  HMAC(relay secret, `bridge-ticket|v1|<connectionId>`). Hivra mints it only
  after you approve that exact command in the dashboard (Approve, Deny, or
  Allow this agent for 1 hour; there is no allow-forever).
- Every request, allowed or refused, is appended to `log.jsonl` beside the
  config (time, computer, agent, argv, cwd, exit code, approved or denied).
- Revoke in the dashboard raises the connector generation; the bridge exits
  with status 3.

```sh
python3 hivra_bridge.py run --config ~/.config/hivra-bridge/config.json   # config is mode 600
python3 -m unittest -v test_hivra_bridge
```

The config is the JSON the dashboard issues (relay, connectionId, generation,
secret, bridgeKey, ownerId, computerId) plus your own `allowedFolders`.
`hivra-bridge.launchd.plist.example` is an example for macOS; nothing installs it.
