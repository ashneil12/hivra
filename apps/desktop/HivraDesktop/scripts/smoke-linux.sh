#!/usr/bin/env bash
# Starts one built Hivra executable under Xvfb and fails unless its Hivra window
# appears and paints non-uniform pixels. This is a native-shell smoke test, not
# a substitute for interactive desktop acceptance.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 /path/to/hivra-desktop /path/to/output-dir" >&2
  exit 2
fi

exe=$(readlink -f "$1")
outdir=$(mkdir -p "$2" && cd "$2" && pwd)
export HIVRA_SMOKE_EXE="$exe" HIVRA_SMOKE_OUT="$outdir"

dbus-run-session -- xvfb-run -a -s '-screen 0 1280x800x24' bash -euxo pipefail -c '
  # Xvfb has no GPU compositor; these are smoke-test environment workarounds,
  # not flags shipped into user desktops.
  export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
  "$HIVRA_SMOKE_EXE" >"$HIVRA_SMOKE_OUT/app.log" 2>&1 &
  app_pid=$!
  window=""
  for _ in $(seq 1 30); do
    window=$(xdotool search --name "^Hivra$" 2>/dev/null | head -n 1 || true)
    [ -n "$window" ] && break
    if ! kill -0 "$app_pid" 2>/dev/null; then
      echo "Hivra exited before creating its window" >&2
      cat "$HIVRA_SMOKE_OUT/app.log" >&2 || true
      exit 1
    fi
    sleep 1
  done
  if [ -z "$window" ]; then
    echo "No Hivra window appeared under Xvfb" >&2
    cat "$HIVRA_SMOKE_OUT/app.log" >&2 || true
    exit 1
  fi
  sleep 5
  import -window "$window" "$HIVRA_SMOKE_OUT/screen.png"
  identify "$HIVRA_SMOKE_OUT/screen.png"
  deviation=$(identify -format "%[standard-deviation]" "$HIVRA_SMOKE_OUT/screen.png")
  if awk -v value="$deviation" "BEGIN { exit !(value > 100) }"; then
    echo "Hivra painted a non-empty native window (deviation $deviation)"
  else
    echo "Hivra window appears blank (deviation $deviation)" >&2
    exit 1
  fi
  handler=$(xdg-mime query default x-scheme-handler/hivra 2>/dev/null || true)
  if [ "$handler" != "hivra-desktop-handler.desktop" ]; then
    echo "Hivra did not register as the hivra:// handler (got \"$handler\")" >&2
    exit 1
  fi
  echo "Hivra registered as the hivra:// handler"
  kill "$app_pid" 2>/dev/null || true
'
