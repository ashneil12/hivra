#!/usr/bin/env bash
# Keep the catalog remediation worker alive. It is separate from the certifier
# so evidence gathering and cheap-agent repair can overlap without sharing a lock.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONCE="$SCRIPT_DIR/run-fixer-once.sh"
DONE_SLEEP="${FIXER_LOOP_DONE_SLEEP:-60}"
IDLE_SLEEP="${FIXER_LOOP_IDLE_SLEEP:-900}"
ERROR_SLEEP="${FIXER_LOOP_ERROR_SLEEP:-900}"

echo "[fixer-loop] starting continuous catalog remediation"
while true; do
  "$ONCE"
  status=$?
  case "$status" in
    0)
      echo "[fixer-loop] remediation advanced; checking again in ${DONE_SLEEP}s"
      sleep "$DONE_SLEEP"
      ;;
    75)
      echo "[fixer-loop] no remediation due; sleeping ${IDLE_SLEEP}s"
      sleep "$IDLE_SLEEP"
      ;;
    *)
      echo "[fixer-loop] remediation run exited $status; backing off ${ERROR_SLEEP}s"
      sleep "$ERROR_SLEEP"
      ;;
  esac
done
