#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
exec node dashboard/scripts/catalog-curator/intake.mjs "$@"
