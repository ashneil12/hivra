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

## Local bridge (user mode, off unless you start it)

Behind the server flag `HIVRA_LOCAL_BRIDGE_ENABLED` (off by default).
`hivra_bridge.py` lets an agent run one command, as you, on your own computer.
It is not the system connector: you start it, and stopping it is the off switch.

- Dials out to the relay; nothing listens on this machine. One message type,
  `exec`: an argv list (never a shell string), a `cwd` inside a folder you list
  in `allowedFolders` (with no `cwd` the first folder is used),
  `timeoutSeconds` up to 120 and `maxOutputBytes` up to 1 MiB. No terminal,
  port forwarding or file transfer. At the time limit, or when the command
  ends, the whole process group is killed, so nothing is left running.
- **Not a sandbox.** An approved command runs as you and can read and change
  anything you can. `allowedFolders` only sets where it starts. The bridge
  refuses a folder that is your home, a parent of it, `~/.ssh`, `~/.gnupg` or
  `~/Library/Keychains`, but that is a guard against mistakes, not a boundary.
- Every request carries a ticket (it lives 60 s, single use, and is refused if
  issued before the bridge started) bound to you, one agent, this computer and
  the exact argv, cwd, time limit and output cap, signed with `bridgeKey`,
  a random 32-byte key made when you enroll, shown to you once in the config and
  kept encrypted by Hivra's control plane. It is not derived from the relay
  secret, so the relay cannot mint tickets. Hivra mints a ticket only
  after you approve that exact command in the dashboard (Approve, Deny, or
  Allow any command from this agent for 1 hour; there is no allow-forever).
  Revoking or re-enrolling a computer ends every allowance for it.
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
