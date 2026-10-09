#!/usr/bin/env bash
# aeon-invoke.sh - dispatch an Aeon skill via the Actions workflow_dispatch API.
# Usage: aeon-invoke.sh <slug> [var]
set -euo pipefail
SKILL="${1:?Usage: aeon-invoke.sh <slug> [var]}"
VAR="${2:-}"
source "$(dirname "$0")/_lib.sh"
_aeon_load_config

BR="$(_aeon_api GET "repos/$AEON_FORK_REPO" | python3 -c "import sys,json;print(json.load(sys.stdin).get('default_branch','main'))")"
BODY="$(SKILL="$SKILL" VAR="$VAR" BR="$BR" python3 -c "
import os, json
inputs = {'skill': os.environ['SKILL']}
if os.environ.get('VAR'):
    inputs['var'] = os.environ['VAR']
print(json.dumps({'ref': os.environ['BR'], 'inputs': inputs}))")"

_aeon_api POST "repos/$AEON_FORK_REPO/actions/workflows/aeon.yml/dispatches" "$BODY"
echo "Dispatched: $SKILL${VAR:+ (var=$VAR)} on $AEON_FORK_REPO (branch $BR)"
echo "Watch runs: https://github.com/$AEON_FORK_REPO/actions"
