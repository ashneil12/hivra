#!/usr/bin/env bash

set -uo pipefail

while true; do
  npm run dev
  code=$?
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  echo "[dev-keepalive] dev server exited with code $code. Restarting in 2s..."
  sleep 2
done
