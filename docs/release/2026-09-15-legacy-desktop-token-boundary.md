# Legacy native Desktop token boundary — 2026-09-15

Status: source-inspected and regression-tested. This is not a live valid-token
replay acceptance result.

## Observed contract

- `GET /api/instances/[id]/desktop-connection` requires a Clerk user and loads
  that exact running instance through `getSecureUserInstance(id, userId,
  requireRunning: true)` before returning a credential.
- The returned credential is the instance's reusable `api_server_key`, also
  configured as `HERMES_DASHBOARD_SESSION_TOKEN`. It is not a short-lived
  desktop session grant.
- The generated Caddy configuration binds the header, bearer, and WebSocket
  query-token forms to that exact token on that instance's hostname. A token
  from another instance does not match those handlers.
- The only unauthenticated Desktop route is `GET` or `HEAD
  /desktop/api/status`. Other `/desktop` requests reach an explicit `401`
  handler unless the exact instance token matches.

Focused regressions passed for owner-scoped issuance, denial without an owned
instance, exact per-instance token matching in all three credential forms, and
the public-status-only exception.

The credential response now explicitly sends `Cache-Control: no-store,
private` and `Pragma: no-cache`, with a focused regression, so the live bearer
is not retained by browser or intermediary HTTP caches.

## Remaining protocol gap

The launcher deliberately persists this reusable token in the native client's
connection file, and the token has no independent Desktop expiry or revocation
lease. Possession therefore grants the native client's full official-dashboard
API surface for that one computer until the underlying instance key is rotated,
replaced, or removed. Source inspection found no route for replaying one
instance's token against another tenant or computer, but no live test exercised
a valid token against both its intended hostname and a foreign hostname in this
check.

Nous Hermes Desktop `main` at
`eaef52371fb803e4a73eb42f9615c63bac9b54e2` supports two remote modes. Legacy
token mode sends the saved credential in `X-Hermes-Session-Token` and the
WebSocket `token` query. OAuth mode uses a roughly 15-minute access cookie, a
rotating refresh cookie, and a single-use WebSocket ticket. Hivra currently
advertises and provisions the legacy token contract: its edge Caddyfile compares
the static instance key before forwarding, and the guest dashboard has no Hivra
owner identity provider or per-computer grant registry. Switching only the
issuance endpoint to an expiring value would therefore reject the supported
client after expiry with no compatible refresh path. A complete migration must
add owner login/exchange, guest-side expiry validation, refresh rotation and
per-computer revocation before changing the advertised auth mode. That bounded
protocol work was not invented inside this recovery fix.
