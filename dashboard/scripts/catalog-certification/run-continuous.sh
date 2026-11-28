#!/usr/bin/env bash
# Keep the serial catalog certifier alive. launchd starts this once; this loop
# decides its own backoff so a product failure can never spin paid computers.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONCE="$SCRIPT_DIR/run-once.sh"
NEXT_SLEEP="${CERT_LOOP_NEXT_SLEEP:-10}"
IDLE_SLEEP="${CERT_LOOP_IDLE_SLEEP:-300}"
ERROR_SLEEP="${CERT_LOOP_ERROR_SLEEP:-300}"
ACCOUNT_SLEEP="${CERT_LOOP_ACCOUNT_SLEEP:-3600}"

echo "[certify-loop] starting continuous catalog certification"
while true; do
  "$ONCE"
  status=$?
  case "$status" in
    0)
      echo "[certify-loop] target certified; next target in ${NEXT_SLEEP}s"
      sleep "$NEXT_SLEEP"
      ;;
    75)
      echo "[certify-loop] no catalog certification due; sleeping ${IDLE_SLEEP}s"
      sleep "$IDLE_SLEEP"
      ;;
    76|77)
      echo "[certify-loop] standing tenant unavailable or held for cleanup review; checking again in ${ACCOUNT_SLEEP}s"
      sleep "$ACCOUNT_SLEEP"
      ;;
    *)
      echo "[certify-loop] run exited $status; backing off ${ERROR_SLEEP}s"
      sleep "$ERROR_SLEEP"
      ;;
  esac
done
