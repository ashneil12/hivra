# Claude terminal QA Unix relay

This is a one-fixture host transport, not a public endpoint or host gateway.
The trusted HTTPS gateway authorizes the Hivra owner and proxies its fixed
terminal routes to `/run/hivra-terminal-qa/ttyd.sock`. systemd owns the
listener and starts one root process per accepted Unix stream. Only the
dedicated, non-root `hivra-terminal-gateway` account and root can connect.
Do not share that account, mount this socket or Docker into a sandbox, or
route Cloudflare directly to the relay.

For an authorized dedicated QA VM, with the reviewed workload-aware gVisor
adapter already installed:

1. Use the dedicated `hivra-terminal-gateway` system account to run the
   browser gateway. Ensure `/run/hivra-terminal-qa`, when present, is a
   real root-owned directory with mode `0755`. Do not grant the gateway
   Docker access or write access to this directory.
2. Create `/opt/hivra/gvisor-adapter/claude-terminal-relay.json` as a
   root-owned mode-`0600` regular file in the existing root-owned
   adapter directory. It is a single JSON object with exactly
   `ownerHash` (64 lowercase hex digits), `computerId` and `sandboxId`
   (the exact adapter UUIDs), and `image` (the exact `sha256:<64 lowercase hex>`
   local Docker image ID). Set these from the bound fixture record, not request
   input. The file contains no access token. Install it before opening the
   listener; do not edit or repoint it while the listener or gateway is up.
3. Install `relay.py` as root-owned mode `0755` at
   `/usr/local/libexec/hivra-claude-terminal-relay.py`, and install the two
   units as root-owned mode `0644` under `/etc/systemd/system`. Run
   `systemctl daemon-reload` and start
   `hivra-claude-terminal-relay.socket`; do not start the template or enable
   the socket on fleet hosts. Once the socket exists, start the authenticated
   gateway with `HIVRA_TERMINAL_GATEWAY_SOCKET=/run/hivra-terminal-qa/ttyd.sock`.

Before forwarding a stream, the relay reads the exact root-owned
installed adapter, checks its bound container, network and volume under the
lifecycle lock, and rejects an orphaned helper, pending replacement, or
anything other than a healthy, running container. It gives Docker only the
verified full container ID and a fixed, non-root, non-TTY Python command.
Python connects to the one workload-local ttyd Unix socket and relays bytes,
not control messages. The entire config and Docker socket remain on the host;
the accepted byte stream is never interpreted as shell, command arguments,
target identity, or an address.

Stopping the container kills its exec processes and cuts their streams; a
replacement cannot inherit a connection addressed to the old Docker ID. The
socket limits concurrent instances and systemd limits their lifetime. To
retire or rebind the fixture, stop the authenticated gateway and the socket
first. Stopping the socket stops its triggered instances. Remove the fixture
configuration and the authorized tunnel, gateway and credit binding separately.

Offline checks: run `python3 -m unittest discover -s dashboard/provisioner/gvisor/claude-terminal-relay`
from the repository root. This does not install, start, or require Docker,
systemd, or a public endpoint.
