# Claude terminal gateway (QA candidate)

This standalone Node gateway is for one pinned owner and one dedicated sandbox
on a QA host. The dashboard's Canary pilot mints its handoff. It exposes
the sandbox's ttyd page for Claude Code's native sign-in; it does not handle
Claude credentials, inject model keys, or use credits.

## Host contract

Run on the **host**, not in the sandbox, with Node 22 or newer and a dedicated
service account. The host operator creates the owner/sandbox binding and
supplies a pre-existing Unix socket for that sandbox's ttyd `-b /terminal -O`
endpoint. This gateway does not create that transport or accept a TCP
destination. Never point it at a Docker socket, a shared multiplexer or a
guest-supplied path. The full path must be on trusted host-controlled
directories with no symlink components. The immediate directory and socket
must be root- or gateway-owned; the directory must not be writable by the
group or others and the socket must not be writable by others. Only the
gateway's account should be allowed to connect to the host-side socket.

Put a trusted HTTPS reverse proxy on a **dedicated terminal origin** that
shares no other apps or cookies. Proxy only to the loopback port; preserve
the canonical public `Host`, browser `Origin`, cookie and WebSocket upgrade.
Do not cache responses or record bootstrap bodies or cookies; suppress such
data in access logs, traces and request captures. Do not route any other
hostname to the gateway or let untrusted workloads use the loopback port.
Only the optional, exact embedding origin gets metadata CORS or permission to
frame the page.

Example host startup (replace configuration labels and paths; no token values
belong in the environment or command line):

```sh
HIVRA_TERMINAL_GATEWAY_PORT=8797 \
HIVRA_TERMINAL_GATEWAY_ORIGIN=https://terminal.qa.example \
HIVRA_TERMINAL_GATEWAY_EMBED_ORIGIN=https://dashboard.qa.example \
HIVRA_TERMINAL_GATEWAY_OWNER="${OWNER_HASH:?}" \
HIVRA_TERMINAL_GATEWAY_SANDBOX="${SANDBOX_UUID:?}" \
HIVRA_TERMINAL_GATEWAY_SOCKET=/run/hivra-terminal-qa/ttyd.sock \
HIVRA_TERMINAL_GATEWAY_KEY_FILE=/etc/hivra-terminal-qa/bootstrap.key \
HIVRA_TERMINAL_GATEWAY_JOURNAL_DIR=/var/lib/hivra-terminal-qa/redemptions \
node dashboard/provisioner/gvisor/claude-terminal-gateway/server.cjs
```

Provision a fresh, application-only 32-byte random key for this binding,
encoded as 64 lowercase hex digits with an optional final newline. Store it
in a root-owned file (0400/0600 for owner access or 0440 with a dedicated
gateway-read group). The trusted issuer gets the same key separately.
Neither the key nor the nonce journal may be mounted into the sandbox. The
journal is an existing directory, owned by the gateway service account with
mode 0700, on a trusted local filesystem that supports directory fsync. Its
parent must not let the service account or untrusted users swap the directory
itself. Retain it across gateway restarts with the same key. Keep both hosts'
clocks in sync. Replace the placeholders with the exact adapter owner hash
and sandbox UUID in the host-side relay binding. They are not supplied by
the browser.

Stop the gateway before stopping or replacing the sandbox; process exit
revokes all cookies and closes open streams. Do not repoint a running
gateway. A detected change to the pinned socket or its directory retires the
binding until process restart. Rotate the key if reassigning a binding so
unused proofs for the old sandbox cannot be redeemed against its replacement.
Keep one gateway per binding.

## Browser and issuer contract

1. Credential-free `GET /api/meta` returns `agentKind: "claude"`,
   `surfaceAuth: "post-cookie-v1"` and an opaque process `bootId`.
2. After verifying the exact owner, sandbox row and public origin, the
   trusted issuer mints `v1.<expiry>.<nonce>.<mac>`. Expiry is a decimal Unix
   timestamp in seconds at most 60 seconds ahead. Nonce is 16 random bytes
   as lowercase hex. MAC is lowercase hex HMAC-SHA256 using the **decoded
   32-byte key** over UTF-8
   `v1\n<exact HTTPS origin>\n<owner hash>\n<sandbox UUID>\n<expiry>\n<nonce>`,
   with no final newline.
3. `POST /auth/bootstrap` accepts the proof in the existing URL-encoded
   `token` form field with `destination=/terminal/`. The gateway accepts the exact terminal or
   configured embedding origin, or a browser-suppressed (missing or `null`)
   Origin since the proof is explicit, non-ambient authority. It atomically
   records a proof's nonce before issuing authority; no replay is allowed
   after process restart.
4. Success is a 303 to the clean `/terminal/` path with a 15-minute opaque
   `__Host-hivra_auth` cookie (`HttpOnly; Secure; SameSite=None; Partitioned`).
   The session is in memory, does not renew on use, and is not passed to
   ttyd. Issuers must mint a fresh proof for each bootstrap, new tab, or retry
   after expiry or restart; a caller cannot reuse a saved proof like a KVM
   management bearer.
5. Only `GET /terminal/`, `GET /terminal/token`, and a same-origin
   `GET /terminal/ws` WebSocket upgrade offering ttyd's `tty` subprotocol
   reach the socket. The gateway does not forward browser credentials or
   arbitrary headers. It forwards no upstream `Set-Cookie` or redirects.
   The ttyd token endpoint must report an empty token: upstream credential
   mode is unsupported.

The gateway caps headers, form bodies and buffered terminal responses;
upstream HTTP and WebSocket handshakes have a five-second deadline. It
allows one WebSocket at a time, with a five-minute idle limit, 8 MiB upload
and 64 MiB download budgets, and no lifetime beyond the cookie expiry.
The websocket carries only the selected sandbox's ttyd protocol. A valid
owner may still see everything that Claude Code displays in the terminal.

Focused local tests use an in-process Unix-socket HTTP/WS fixture, not a
Claude account, browser, deployed host, or standing credential:

```sh
sudo "$(command -v node)" --test dashboard/provisioner/gvisor/claude-terminal-gateway/server.test.cjs
```

The tests generate ephemeral keys and run as root to exercise the real
root-owned key-file check. Do not use a production signing key for tests.
