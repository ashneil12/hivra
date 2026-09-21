#!/bin/bash
# Migrate a Proxmox host's Caddy config to the static Cloudflare Origin CA
# wildcard cert used for Cloudflare -> Proxmox origin TLS.
#
# Run ON the pve host as root. Idempotent.
#
# Prerequisite: seed these files first, owned by root/caddy-readable as appropriate:
#   /etc/caddy/wildcards/hermesos.cloud.crt
#   /etc/caddy/wildcards/hermesos.cloud.key
#
# This script deliberately does NOT mint Let's Encrypt DNS-01 wildcards and
# does NOT require CLOUDFLARE_API_TOKEN. Browsers see Cloudflare edge certs;
# Proxmox origins present the Cloudflare Origin CA cert to Cloudflare only.

set -euo pipefail

WILDCARD_CERT=/etc/caddy/wildcards/hermesos.cloud.crt
WILDCARD_KEY=/etc/caddy/wildcards/hermesos.cloud.key
SITES_DIR=/etc/caddy/hermes.d
MAIN_CADDYFILE=/etc/caddy/Caddyfile
TLS_DIRECTIVE="  tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key"

if [ "$(id -u)" != "0" ]; then
  echo "ERROR: run as root on the Proxmox host" >&2
  exit 1
fi

mkdir -p /etc/caddy/wildcards "$SITES_DIR"
if [ ! -r "$WILDCARD_CERT" ] || [ ! -r "$WILDCARD_KEY" ]; then
  echo "ERROR: missing Cloudflare Origin CA cert/key:" >&2
  echo "  $WILDCARD_CERT" >&2
  echo "  $WILDCARD_KEY" >&2
  echo "Seed those files before running this migration." >&2
  exit 1
fi

# A *.hermesos.cloud certificate cannot cover *.agents.hermesos.cloud. A
# legacy route may only be retired when the equivalent current-domain route is
# already present; otherwise stop before touching live configuration.
for legacy in "$SITES_DIR"/*.agents.hermesos.cloud.caddy; do
  [ -f "$legacy" ] || continue
  stem="$(basename "$legacy" .agents.hermesos.cloud.caddy)"
  current="$SITES_DIR/$stem.hermesos.cloud.caddy"
  if [ ! -f "$current" ]; then
    echo "LEGACY_WITHOUT_CURRENT_SIBLING legacy=$legacy expected=$current; refusing migration" >&2
    exit 1
  fi
done

echo "==> 1. Rewriting main Caddyfile to static Origin CA wildcard block"
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp -a "$MAIN_CADDYFILE" "${MAIN_CADDYFILE}.bak.origin-ca.$TS"

rollback_configs() {
  cp -a "${MAIN_CADDYFILE}.bak.origin-ca.$TS" "$MAIN_CADDYFILE"
  for backup in "$SITES_DIR"/*.caddy.bak.origin-ca."$TS"; do
    [ -f "$backup" ] || continue
    original="${backup%.bak.origin-ca.$TS}"
    cp -a "$backup" "$original"
  done
  for disabled in "$SITES_DIR"/*.caddy.disabled.origin-ca."$TS"; do
    [ -f "$disabled" ] || continue
    original="${disabled%.disabled.origin-ca.$TS}"
    mv "$disabled" "$original"
  done
  echo "ROLLBACK_COMPLETE timestamp=$TS" >&2
}
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/caddy/Caddyfile')
text = p.read_text()
# Remove legacy DNS-01 wildcard/minter blocks, including variants with or
# without hermesos.cloud on the site label.
import re
text = re.sub(
    r'\n?#\s*Wildcard cert minter[^\n]*\n(?:#[^\n]*\n)*\*\.hermesos\.cloud(?:,\s*hermesos\.cloud)?\s*\{\s*tls\s*\{\s*dns cloudflare \{env\.CLOUDFLARE_API_TOKEN\}\s*\}\s*respond "Hermes — unknown agent" 404\s*\}\s*',
    '\n',
    text,
    flags=re.S,
)
text = re.sub(
    r'\n?\*\.hermesos\.cloud\s*\{\s*tls\s*\{\s*dns cloudflare \{env\.CLOUDFLARE_API_TOKEN\}\s*\}\s*respond "Hermes — unknown agent" 404\s*\}\s*',
    '\n',
    text,
    flags=re.S,
)
origin_block = '''
# Cloudflare Origin CA wildcard cert for Cloudflare -> Proxmox origin TLS.
*.hermesos.cloud, hermesos.cloud {
  tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key
  respond "Hermes — unknown agent" 404
}
'''
if '*.hermesos.cloud, hermesos.cloud {' not in text:
    if re.search(r'^import\s+', text, flags=re.M):
        text = re.sub(r'(?m)^import\s+', origin_block + '\nimport ', text, count=1)
    else:
        text = text.rstrip() + '\n' + origin_block + '\nimport /etc/caddy/hermes.d/*.caddy\n'
p.write_text(text)
PY

echo "==> 2. Pinning tenant *.hermesos.cloud site files to Origin CA cert"
migrated=0
skipped=0

# Retire duplicate legacy siblings before validation. They cannot use the
# single-label wildcard and are a common source of stale exact CertMagic paths.
for legacy in "$SITES_DIR"/*.agents.hermesos.cloud.caddy; do
  [ -f "$legacy" ] || continue
  cp -a "$legacy" "$legacy.bak.origin-ca.$TS"
  mv "$legacy" "$legacy.disabled.origin-ca.$TS"
  echo "    disabled legacy sibling $legacy"
done

for f in "$SITES_DIR"/*.caddy; do
  [ -f "$f" ] || continue
  if ! grep -Eq '^[a-z0-9-]+\.hermesos\.cloud \{$' "$f"; then
    skipped=$((skipped + 1))
    continue
  fi
  cp -a "$f" "$f.bak.origin-ca.$TS"
  # Remove any tls /var/lib/caddy/.local/share/caddy/certificates/... directive;
  # those mutable paths become dangling when CertMagic cleans expired assets.
  awk -v dir="$TLS_DIRECTIVE" '
    # STALE_CERT_DIRECTIVE: strip both mutable CertMagic storage paths and any
    # existing static line, then insert exactly one canonical TLS directive.
    /^[[:space:]]*tls \/var\/lib\/caddy\/\.local\/share\/caddy\/certificates\// { next }
    /^[[:space:]]*tls \/etc\/caddy\/wildcards\/hermesos\.cloud\.(crt|key)/ { next }
    /^[a-z0-9-]+\.hermesos\.cloud \{$/ && !inserted {
      print
      print dir
      inserted=1
      next
    }
    { print }
  ' "$f" > "${f}.new"
  if [ -s "${f}.new" ] && ! cmp -s "$f" "${f}.new"; then
    mv "${f}.new" "$f"
    migrated=$((migrated + 1))
  else
    rm -f "${f}.new"
  fi
done
echo "    migrated $migrated file(s), skipped $skipped"

echo "==> 3. Validating + restarting Caddy without Cloudflare DNS env"
if ! VALIDATE_ERR=$(env -u CLOUDFLARE_API_TOKEN caddy validate --config "$MAIN_CADDYFILE" 2>&1); then
  echo "    validate failed:" >&2
  printf '%s\n' "$VALIDATE_ERR" | tail -20 >&2
  rollback_configs
  exit 1
fi
if ! systemctl restart caddy; then
  echo "    restart failed; restoring prior configuration" >&2
  rollback_configs
  systemctl restart caddy || true
  exit 1
fi
printf 'dns_refs='
(grep -R "dns cloudflare\|acme_dns" "$MAIN_CADDYFILE" "$SITES_DIR" 2>/dev/null || true) | wc -l
systemctl is-active caddy

echo "==> Done. Static Origin CA wildcard TLS is active."
