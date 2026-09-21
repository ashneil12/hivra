#!/usr/bin/env bash
set -euo pipefail

SITE_HOST="${SITE_HOST:-hermesos.cloud}"
LOCAL_AUTH_HOST="${LOCAL_AUTH_HOST:-local.${SITE_HOST}}"

if ! grep -Eq "(^|[[:space:]])${LOCAL_AUTH_HOST}([[:space:]]|\$)" /etc/hosts; then
  cat <<EOF
Missing hosts entry for ${LOCAL_AUTH_HOST}.

Add this line to /etc/hosts, then rerun this command:
127.0.0.1 ${LOCAL_AUTH_HOST}

After that, start the server again with:
sudo npm run dev:live-auth
EOF
  exit 1
fi

cat <<EOF
Starting Next.js with HTTPS on port 443 for live Clerk debugging.

Open this URL in your browser:
https://${LOCAL_AUTH_HOST}
EOF

exec npx next dev --webpack --experimental-https -p 443
