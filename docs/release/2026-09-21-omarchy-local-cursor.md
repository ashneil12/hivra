# Omarchy local cursor restoration — 21 September 2026

Status: source-tested; not deployed or accepted live.

## Root cause

The prior Omarchy correction forced the Hyprland cursor into encoded video and
hid both browser-side renderers. That removed the double pointer and recovered
guest cursor shapes, but pointer motion then inherited stream latency.

The earlier local-cursor attempt was not sufficient: Canary showed that its
pinned external-Wayland capture supplied only a fixed arrow sprite, so removing
the video cursor alone could not produce hand, text, resize or hidden states.

## Change

- Pin Selkies 2.0 RC1's amd64 image manifest. Its pixelflux host-Wayland path
  delivers cursor images and hotspots separately from video.
- Keep compositor cursor pixels out of the encoded stream and retain Selkies'
  browser-cursor mode, producing one locally rendered pointer with guest shapes.
- Use the Selkies 2.0 WebSocket and display-helper module layout while retaining
  a bounded import fallback for inspection of the previous sealed image.
- Accept either an exact local image config digest or repository manifest digest
  before pulling, without weakening the existing immutable-image check.

## Verification

- Staged broker: 35 tests passed.
- Omarchy layout adapter: 9 tests passed.
- Omarchy installer: 6 tests passed; 1 systemd-only check skipped on macOS.
- Session broker and Omarchy native grant: 75 tests passed.
- Focused capability parsing/cursor checks passed.
- Production dashboard build, TypeScript typecheck, touched-file lint, Python
  compilation, JavaScript syntax, and diff whitespace checks passed.

The broader capability suite remains blocked by the source release's existing
sealed-broker mismatch: `broker.cjs` hashes to `6e056f…` while the retained
capability constant expects `7f71db…`. This predates this cursor change and is
tracked separately from live cursor acceptance.

Repository-wide lint also remains blocked by pre-existing errors in staged
Litepaper vendor files; no touched cursor file reports a lint error.

## Remaining acceptance

Create a new immutable provisioner identity and provider admission before any
runtime update. On an authorised disposable or retained Canary target, use the
normal authenticated desktop flow and confirm one responsive pointer that changes
through arrow, link hand, text, resize and hidden states. Then verify clicks,
keyboard input, window/fullscreen resize, disconnect/reconnect, retained VM data,
and exact installed image/source identities. A dashboard deployment alone does
not update the guest runtime.
