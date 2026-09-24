# Home and office machines: an outbound connector (draft)

**Status:** the relay (`services/host-relay-worker`) and the connector
(`services/host-connector`) are built and tested locally, including an end to
end test with the real connector. Not deployed. Hivra's control plane does not
use them yet: the transport seam, connector issuance and the "At home"
enrollment land with the one-command enrollment (slice 13).

## Problem

Hosted Hivra reaches a user's server over inbound SSH from its Vercel
functions (`ssh2` in `proxmox-instance-service.ts`'s runner, used by discovery,
gVisor preparation, Proxmox and launches). A machine behind a home or office
router has no inbound port, so "Connect my own machine → At home" ends at
"Hosted Hivra cannot connect to your local network" (INF-11).

## Options considered

| Option | Why not (or why) |
| --- | --- |
| Join a tailnet | Vercel functions cannot join a tailnet per invocation; `tsnet` in a function would need an auth key per cold start and a long-lived process. |
| Tailscale Funnel (TLS-terminated TCP) | Works from Vercel (TLS to `*.ts.net:443`, then SSH over it), but only for users who already run Tailscale with Funnel enabled. Keep as a later "use my tailnet" option. |
| Cloudflare Tunnel | The client side needs `cloudflared access`, which a function cannot run. |
| Reverse SSH to a Hivra VPS | Needs Hivra-operated servers and per-host port allocation; the relay would terminate SSH-level port binding on shared infrastructure. |
| **Cloudflare Durable Object byte relay** | Chosen. Outbound-only from the machine, no Hivra servers, end-to-end SSH preserved. |

## Design

```
home machine                      Cloudflare                       Vercel function
hivra-connector ── wss /agent ──▶  HostRelay DO  ◀── wss /client ── ssh2 (sock = WebSocket duplex)
      │  on "open <id>"                 │ pairs streams
      └─ wss /stream/<id> ◀──────────────┘
      └─ tcp 127.0.0.1:22 (sshd)
```

1. **Relay** (`services/host-relay-worker`): one Durable Object per connection
   id. It pipes binary frames between a client socket and a stream socket and
   never parses SSH. Idle control sockets use the WebSocket Hibernation API so
   an idle machine costs nothing.
2. **Connector** (`hivra-connector`, Python 3 standard library only, installed
   by the enrollment script with `--outbound`): a systemd service under its own
   unprivileged user, holding one control WebSocket. On `open <streamId>` it
   dials `127.0.0.1:22` (fixed, never a relay-supplied address) and a stream
   socket, then copies bytes both ways.
3. **Dashboard transport**: connections gain `transport = 'direct' | 'hivra-relay'`.
   For the relay, the SSH runner opens `wss://relay/<connectionId>/client` with
   a 60-second ticket and passes the WebSocket as `ssh2`'s `sock`. Everything
   above the socket (host-key pin, discovery, preparation, launch) is unchanged.

## Credentials

One secret, `HOST_RELAY_SECRET`, is shared by the Worker and Hivra's control
plane. Everything else derives from it, so the relay stores nothing per machine:

- **Connector secret** = HMAC(secret, `connector|<connectionId>|<generation>`),
  delivered in the enrollment response and stored in
  `/etc/hivra-connector/config.json` (0640, root and the connector user). The
  connector signs `/agent` and `/stream` requests with it over
  `kind|connectionId|streamId|timestamp` (±120 s).
- **Client ticket**: `base64url(json).base64url(hmac)` keyed by
  HMAC(secret, `client-ticket|v1`), audience = connection id, expiry at most
  120 s ahead, single-use `jti` recorded in the Durable Object.
- **Revocation**: the control plane raises the connection's minimum generation
  (admin token = HMAC(secret, `admin|v1`)). Reconnecting a machine issues the
  next generation.

## Threats

| Threat | Mitigation | Test |
| --- | --- | --- |
| The relay reads or alters SSH | SSH is end to end; the host key was pinned at "Is this your server?" and every connection verifies it | Tampered-frame test: `ssh2` rejects a changed host key through the relay |
| A stolen connector secret impersonates the machine | The impostor cannot present the pinned host key, so Hivra refuses the session; rotation from the card revokes the secret | Impostor connector fails host-key check |
| Cross-tenant stream pairing | DO is keyed by connection id; tickets and HMACs bind the id; the DO rejects a stream for an id it did not request | Two connections, crossed ids |
| Ticket replay | 60 s expiry plus single-use `jti` | Replayed ticket rejected |
| The relay makes the connector dial elsewhere (SSRF into the home LAN) | The target is compiled into the connector (`127.0.0.1:22`); relay messages carry only a stream id | Message with an address is ignored |
| Resource abuse | Max 8 concurrent streams per connection, idle timeout, frame size cap, per-connection byte budget | Limits enforced |
| Uninstall leaves access behind | The uninstall script removes the service, user and secret; "Disconnect" in Hivra revokes the secret hash | Uninstall test |

## User experience

My server → "Where is it?" → **At home or in an office** → the same one-line
command with `--outbound` → "Is this your server?" → normal inspection,
preparation and launch. The card shows "Connected through Hivra's relay" and
the relay's last contact time (observed).

## Rollout

- Needs: a Cloudflare Workers deploy of `host-relay-canary` (owner authority
  and a Workers token), `HOST_RELAY_SECRET` on the canary Vercel project, and a
  migration for the connection's `transport` and connector generation.
- Acceptance: a machine with no inbound ports (a Hetzner server with its
  firewall denying all inbound) enrolls with `--outbound`, reaches "Ready for
  Linux Sandbox", and launches.
