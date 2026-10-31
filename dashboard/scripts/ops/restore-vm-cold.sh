#!/bin/bash
# restore-vm-cold.sh — bring a cold-archived Hermes tenant back to a live VM.
#
# Run from a PVE host. Mirror of archive-vm-cold.sh's lifecycle invariants:
#   1. download archive from Storage Box to PVE-local first (decouples the
#      two ssh streams; piping cold→VM directly hangs in our environment)
#   2. verify SHA256 BEFORE doing anything destructive on the new VM
#   3. clone template, resize, set IP/dns, start, wait for SSH
#   4. extract archive into the new VM
#   5. declare docker volumes, docker compose pull && up -d
#   6. health-check the agent gateway
#
# Exit codes:
#   0  success — final RESULT line emitted, agent healthy
#   1  bad args / preflight failure
#   2  archive download or sha256 mismatch (refuses to clone)
#   3  VM provision / boot failure
#   4  guest extract failure
#   5  docker compose / health failure
#
# All positional args are required and chosen by the dashboard's restore
# orchestrator (it knows the destination host's vmid range, ip pool, and
# canonical template id from Vercel env).
#
# Args:
#   $1  instance_id              UUID of the tenant; used for path/volume naming
#   $2  archive_uri              Storage Box-relative path, e.g.
#                                free/<id>/data-<ts>.tar.zst
#   $3  expected_sha256          64 lowercase hex chars from the manifest
#   $4  new_vmid                 unused VMID on this host, in the tenant range
#   $5  guest_ip                 unused IP in this host's vmbr1 subnet, no CIDR
#   $6  guest_gateway            host's vmbr1 gateway (e.g. 10.250.20.1)
#   $7  template_vmid            template VMID to clone from (e.g. 9004)
#   $8  guest_disk_target_gb     final guest disk size (e.g. 30); script only
#                                resizes UP from the template, never down
#   $9  cpu_limit                CPU throttle for the restored VM (e.g. 0.5
#                                for free tier, 2/4/8 for paid tiers).
#                                Defaults to 0.5 (free) when not supplied so
#                                old callers don't accidentally provision an
#                                unbounded VM. Sourced from tier-specs.ts via
#                                the orchestrator.
#   $10 ram_limit_mb             Persisted VM memory for the restored paid size.

set -euo pipefail

# >>> VMID-bound guest SSH: identical in backup-vm-restic.sh, archive-vm-cold.sh and restore-vm-cold.sh >>>
# Bash mirror of buildHermesVmidBoundGuestSshPrelude (dashboard/src/lib/proxmox/hermes-guest-ssh.ts).
# A guest IP is not an identity: a stale neighbour entry or a recycled IP can route an SSH connection to
# another tenant. attest_guest_ssh_pin runs before the first connection. It checks that VMID is a running
# VM configured with GUEST_IP, that it is not a Hivra computer, and that it has a QEMU Guest Agent channel.
# It then reads the guest's Ed25519 SSH host key through the agent (the VMID's virtio channel, not the
# network) and pins every later connection to that key in a private known_hosts file.
# Inputs: VMID, GUEST_IP, VM_SSH_KEY. Output: GUEST_SSH_PIN_OPTS (ssh options, no timeout or log level).
# On failure it prints a "VMID-bound SSH refused:" line and returns 1; the caller exits before contacting the guest.
GUEST_SSH_IDENTITY_DIR=""
GUEST_SSH_PIN_OPTS=()
guest_ssh_refuse() {
  printf 'VMID-bound SSH refused: %s; nothing was sent to the guest\n' "$1" >&2
}
cleanup_hivra_guest_ssh_identity() {
  case "${GUEST_SSH_IDENTITY_DIR:-}" in
    /run/hivra-guest-ssh-identity.*) rm -rf -- "$GUEST_SSH_IDENTITY_DIR" ;;
    "") ;;
    *) printf 'refusing to remove unexpected guest identity directory\n' >&2; return 1 ;;
  esac
}
attest_guest_ssh_pin() {
  # errexit is suspended inside this function when it runs as an if/|| condition,
  # so every check returns explicitly.
  local attempts="$1" config conf_ip tags agent attempt up=0 key_json key_line
  case "${GUEST_IP:-}" in
    ""|*[!0-9.]*) guest_ssh_refuse "the guest ip is not an IPv4 address"; return 1 ;;
  esac
  [ -f "${VM_SSH_KEY:-}" ] || { guest_ssh_refuse "this host has no guest SSH key at ${VM_SSH_KEY:-(unset)}"; return 1; }
  case "${VMID:-}" in
    ""|*[!0-9]*) guest_ssh_refuse "the vmid is not a number"; return 1 ;;
  esac
  config="$(qm config "$VMID" </dev/null 2>/dev/null)" \
    || { guest_ssh_refuse "VM $VMID does not exist on this host"; return 1; }
  [ "$(qm status "$VMID" </dev/null 2>/dev/null | awk '{print $2}')" = running ] \
    || { guest_ssh_refuse "VM $VMID is not running"; return 1; }
  conf_ip="$(printf '%s\n' "$config" | awk '
    /^ipconfig0:/ && !seen {
      seen = 1
      line = $0
      sub(/^ipconfig0:[ \t]*/, "", line)
      n = split(line, parts, ",")
      for (i = 1; i <= n; i++) {
        if (substr(parts[i], 1, 3) == "ip=") {
          value = substr(parts[i], 4)
          if (value ~ /^[0-9.]+\/[0-9]+$/) { sub(/\/[0-9]+$/, "", value); print value }
        }
      }
    }')"
  [ "$conf_ip" = "$GUEST_IP" ] \
    || { guest_ssh_refuse "VM $VMID is configured with ip ${conf_ip:-none}, not $GUEST_IP"; return 1; }
  tags="$(printf '%s\n' "$config" | awk '/^tags:/ && !seen { seen = 1; line = $0; sub(/^tags:[ \t]*/, "", line); gsub(/[;, ]+/, ";", line); print line }')"
  case ";$tags;" in
    *";hivra-bind-"*) guest_ssh_refuse "VM $VMID is a Hivra computer, not a Hermes instance VM"; return 1 ;;
  esac
  agent="$(printf '%s\n' "$config" | awk '/^agent:/ && !seen { seen = 1; line = $0; sub(/^agent:[ \t]*/, "", line); print line }')"
  case ",$agent," in
    *,1,*|*,on,*|*,yes,*|*,true,*|*,enabled=1,*|*,enabled=on,*|*,enabled=yes,*|*,enabled=true,*) ;;
    *) guest_ssh_refuse "VM $VMID has no QEMU Guest Agent channel, so its SSH host key can't be attested"; return 1 ;;
  esac
  for attempt in $(seq 1 "$attempts"); do
    if timeout 5 qm guest cmd "$VMID" ping </dev/null >/dev/null 2>&1; then up=1; break; fi
    if [ "$attempt" -lt "$attempts" ]; then sleep 5; fi
  done
  [ "$up" = 1 ] || { guest_ssh_refuse "QEMU Guest Agent in VM $VMID did not answer, so its SSH host key can't be attested"; return 1; }
  key_json="$(qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub </dev/null 2>/dev/null)" \
    || { guest_ssh_refuse "VM $VMID SSH host key could not be read through QEMU Guest Agent"; return 1; }
  key_line="$(printf '%s' "$key_json" | /usr/bin/python3 -c '
import base64,binascii,json,sys
try:
    document=json.load(sys.stdin)
    fields=document.get("out-data", "").strip().split()
    raw=base64.b64decode(fields[1], validate=True)
    expected=b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"
    if document.get("exited") != 1 or document.get("exitcode") != 0 or len(fields) < 2 or fields[0] != "ssh-ed25519" or len(raw) != 51 or not raw.startswith(expected):
        raise ValueError("invalid VMID-bound SSH host key")
except (AttributeError,IndexError,KeyError,TypeError,ValueError,binascii.Error,json.JSONDecodeError):
    raise SystemExit(1)
print("ssh-ed25519 "+fields[1])
')" || { guest_ssh_refuse "VM $VMID did not attest a valid Ed25519 SSH host key"; return 1; }
  GUEST_SSH_IDENTITY_DIR="$(mktemp -d /run/hivra-guest-ssh-identity.XXXXXXXX)" \
    || { guest_ssh_refuse "no private directory for the attested SSH host key"; return 1; }
  chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
  GUEST_SSH_KNOWN_HOSTS="$GUEST_SSH_IDENTITY_DIR/known_hosts"
  GUEST_SSH_HOST_ALIAS="hivra-vmid-$VMID"
  printf '%s %s\n' "$GUEST_SSH_HOST_ALIAS" "$key_line" > "$GUEST_SSH_KNOWN_HOSTS"
  chmod 0600 "$GUEST_SSH_KNOWN_HOSTS"
  GUEST_SSH_PIN_OPTS=(-i "$VM_SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no
    -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS"
    -o HostKeyAlias="$GUEST_SSH_HOST_ALIAS")
  return 0
}
# <<< VMID-bound guest SSH <<<

INSTANCE_ID="${1:-}"
ARCHIVE_URI="${2:-}"
EXPECTED_SHA="${3:-}"
NEW_VMID="${4:-}"
GUEST_IP="${5:-}"
GUEST_GW="${6:-}"
TEMPLATE_VMID="${7:-}"
TARGET_DISK_GB="${8:-30}"
CPU_LIMIT="${9:-0.5}"
RAM_LIMIT_MB="${10:-4096}"
CPU_CORES=$(awk -v cpu="$CPU_LIMIT" 'BEGIN { n=int(cpu); if(cpu>n) n++; if(n<2) n=2; print n }')

for var in INSTANCE_ID ARCHIVE_URI EXPECTED_SHA NEW_VMID GUEST_IP GUEST_GW TEMPLATE_VMID; do
  if [ -z "${!var}" ]; then
    echo "[restore] missing required arg: $var" >&2
    exit 1
  fi
done

# Sanity: expected sha is 64 lowercase hex
if ! [[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]]; then
  echo "[restore] EXPECTED_SHA must be 64 lowercase hex chars" >&2
  exit 1
fi

# Sanity: instance_id is a uuid
if ! [[ "$INSTANCE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  echo "[restore] INSTANCE_ID must be a UUID" >&2
  exit 1
fi

# Sanity: archive path looks reasonable (free/<id>/<file> or paid/<id>/<file>)
if ! [[ "$ARCHIVE_URI" =~ ^(free|paid)/[^/]+/[^/]+$ ]]; then
  echo "[restore] ARCHIVE_URI shape must be free/<id>/<file> or paid/<id>/<file>" >&2
  exit 1
fi

# Refuse if the destination VMID is already taken
if qm config "$NEW_VMID" >/dev/null 2>&1; then
  echo "[restore] VMID $NEW_VMID already exists on $(hostname)" >&2
  exit 1
fi

PVE_HOST=$(hostname)
TS=$(date -u +%Y%m%dT%H%M%SZ)
echo "═══ restore-vm-cold instance=$INSTANCE_ID vmid=$NEW_VMID host=$PVE_HOST ts=$TS ═══"

# ──────────────────────────────────────────────────────────────────────────────
# Step 1+2: download archive, verify sha BEFORE any destructive op
# ──────────────────────────────────────────────────────────────────────────────
SCRATCH=$(mktemp -d /tmp/hermes-restore-$INSTANCE_ID-XXXX)
trap 'rm -rf "$SCRATCH"; cleanup_hivra_guest_ssh_identity || true' EXIT
LOCAL_ARCHIVE="$SCRATCH/archive.tar.zst"

echo "  step 1/6: download archive cold → $PVE_HOST"
START=$(date +%s)
if ! rsync -a --partial -e ssh "cold:$ARCHIVE_URI" "$LOCAL_ARCHIVE" 2>&1 | tail -3; then
  echo "[restore] rsync from cold storage failed" >&2
  exit 2
fi
DL_SEC=$(( $(date +%s) - START ))
ARCHIVE_SIZE=$(stat -c %s "$LOCAL_ARCHIVE")

echo "  step 2/6: verify SHA256 against manifest"
ACTUAL_SHA=$(sha256sum "$LOCAL_ARCHIVE" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[restore] SHA MISMATCH expected=$EXPECTED_SHA actual=$ACTUAL_SHA" >&2
  echo "[restore] refusing to clone destination VM; archive may be corrupt" >&2
  exit 2
fi
echo "    sha256:${ACTUAL_SHA:0:16}…  size:$(numfmt --to=iec $ARCHIVE_SIZE)  download:${DL_SEC}s"

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: clone template, resize, set IP/dns, start
# ──────────────────────────────────────────────────────────────────────────────
echo "  step 3/6: clone template $TEMPLATE_VMID → vmid $NEW_VMID"
qm clone "$TEMPLATE_VMID" "$NEW_VMID" \
  --full 0 \
  --name "hermes-$INSTANCE_ID" >/dev/null

# Resize up to target if the template is smaller. `qm resize` is a no-op
# when the requested size is <= current size (idempotent on a 30G template).
qm resize "$NEW_VMID" scsi0 "${TARGET_DISK_GB}G" 2>/dev/null || true

qm set "$NEW_VMID" \
  --ipconfig0 "ip=$GUEST_IP/24,gw=$GUEST_GW" \
  --nameserver "185.12.64.1 185.12.64.2 1.1.1.1 8.8.8.8" \
  --cpulimit "$CPU_LIMIT" \
  --cores "$CPU_CORES" \
  --memory "$RAM_LIMIT_MB" \
  --agent enabled=1 \
  --onboot 1 >/dev/null

qm start "$NEW_VMID" >/dev/null
echo "    cloned + booting at $GUEST_IP"

# Attest the guest's SSH host key through QEMU Guest Agent before the first connection.
# The agent channel comes from the --agent flag above, which the clone needs for the next boot.
VMID="$NEW_VMID"
VM_SSH_KEY=/etc/hivra/keys/vm-orchestrator
if ! attest_guest_ssh_pin 36; then
  echo "[restore] guest identity not attested; destroying the clone this run just made" >&2
  qm stop "$NEW_VMID" >/dev/null 2>&1 || true
  qm destroy "$NEW_VMID" --skiplock --purge >/dev/null 2>&1 || true
  exit 3
fi
SSH_OPTS=("${GUEST_SSH_PIN_OPTS[@]}" -o ConnectTimeout=5 -o LogLevel=ERROR)

# Wait for guest SSH
SSH_UP=false
for _ in $(seq 1 36); do  # up to 3 min
  if ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" true 2>/dev/null; then
    SSH_UP=true
    break
  fi
  sleep 5
done

if [ "$SSH_UP" != true ]; then
  echo "[restore] guest SSH never came up at $GUEST_IP" >&2
  qm stop "$NEW_VMID" >/dev/null 2>&1 || true
  qm destroy "$NEW_VMID" --skiplock --purge >/dev/null 2>&1 || true
  exit 3
fi
echo "    guest SSH up"

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: stream archive PVE → VM, extract
# ──────────────────────────────────────────────────────────────────────────────
echo "  step 4/6: stream + extract archive into guest"
START=$(date +%s)
if ! cat "$LOCAL_ARCHIVE" | \
     ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" "sudo -n bash -c 'zstd -dc | tar -C / -xf -'"; then
  echo "[restore] guest extract failed" >&2
  qm stop "$NEW_VMID" >/dev/null 2>&1 || true
  qm destroy "$NEW_VMID" --skiplock --purge >/dev/null 2>&1 || true
  exit 4
fi
EXTRACT_SEC=$(( $(date +%s) - START ))
echo "    extract done in ${EXTRACT_SEC}s"

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: declare docker volumes, ensure host-level Caddy + shared docker
# network exist (the archive only carries the per-instance dir; the VM-level
# `/opt/hermes/Caddyfile` + `/opt/hermes/docker-compose.yml` + `hermes_net`
# external network all come from the original provisioning step and would
# otherwise be missing on a fresh template clone — without them the inner
# hermes-caddy container never starts and the outer host caddy 502s).
# ──────────────────────────────────────────────────────────────────────────────
echo "  step 5/6: ensure host caddy + declare volumes + docker compose up"
if ! ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" bash <<EOS
# pipefail matters here: every docker compose call below is piped into \`tail\`
# for log brevity, and WITHOUT it the pipeline's status is tail's (always 0) —
# so a failed or 124-timed-out \`compose up\` looked like success, step 5 passed,
# and the restore continued to hand back a box whose containers never started.
# The only pipes in this heredoc are those three tails, so enabling it is safe.
set -e
set -o pipefail
INSTANCE_ID="$INSTANCE_ID"

# Shared docker network the per-instance compose declares as external.
sudo docker network create hermes_net >/dev/null 2>&1 || true

# Idempotently install the VM-level Caddyfile that imports every instance's
# Caddyfile and runs as a shared container exposing :80/:443. Single-tenant
# VMs in this fleet, so a fixed template is fine.
if [ ! -f /opt/hermes/Caddyfile ]; then
  sudo install -d -o hermes -g hermes /opt/hermes
  sudo tee /opt/hermes/Caddyfile >/dev/null <<'CADDYFILE'
{
	log {
		output file /var/log/caddy/access.log {
			roll_size 100mb
			roll_keep 5
		}
		format json
		level INFO
	}
}

import /opt/hermes/instances/*/Caddyfile
CADDYFILE
  sudo chown hermes:hermes /opt/hermes/Caddyfile
fi
if [ ! -f /opt/hermes/docker-compose.yml ]; then
  sudo tee /opt/hermes/docker-compose.yml >/dev/null <<'COMPOSE'
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    networks:
      - hermes_net
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./instances:/opt/hermes/instances:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:

networks:
  hermes_net:
    external: true
COMPOSE
  sudo chown hermes:hermes /opt/hermes/docker-compose.yml
fi

sudo docker volume create "agent-\${INSTANCE_ID}_agent-source" >/dev/null
sudo docker volume create "agent-\${INSTANCE_ID}_webui-state" >/dev/null
sudo docker volume create "agent-\${INSTANCE_ID}_webui-workspace" >/dev/null

# Per-instance agent containers
cd "/opt/hermes/instances/\${INSTANCE_ID}"
# These three are deliberately NON-FATAL, but no longer SILENT — that was the
# actual defect: pipefail was off, so their status came from \`tail\` and a
# failure could not even be seen in the logs.
#
# They must stay non-fatal. \`timeout 120 docker compose up -d\` routinely trips
# on a cold image pull (the step-6 comment records an 8-minute pull during the
# 2026-05-17 parallel-restore smoke test). Before pipefail that 124 was masked
# and the restore carried on to step 5b (which recreates the containers anyway)
# and step 6 (the real gate, which parks the box as health_pending for the
# recovery sweep). Letting it abort step 5 instead would drop into the
# \`qm stop\`/\`qm destroy\` branch below and DELETE a VM whose data restored
# perfectly — strictly worse than the bug being fixed.
sudo docker compose pull 2>&1 | tail -3 \
  || echo "[restore] WARN: compose pull non-zero (images may be baked into the template); continuing" >&2
sudo timeout 120 docker compose up -d 2>&1 | tail -5 \
  || echo "[restore] WARN: instance compose up non-zero/timed out; step 5b recreates and step 6 gates on health" >&2

# Shared host caddy (idempotent — already-running container is a no-op)
cd /opt/hermes
sudo timeout 60 docker compose up -d 2>&1 | tail -5 \
  || echo "[restore] WARN: host caddy compose up non-zero/timed out; continuing" >&2
EOS
then
  echo "[restore] docker compose failed" >&2
  qm stop "$NEW_VMID" >/dev/null 2>&1 || true
  qm destroy "$NEW_VMID" --skiplock --purge >/dev/null 2>&1 || true
  exit 5
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 5b: fix per-instance volume ownership, then restart the stack.
#
# Provisioning seeds each agent volume to uid 1024 via busybox chown
# (webui-instance-builder.ts chowns /state, /workspace, /target). The restore
# path doesn't: Docker initializes a named volume's _data mountpoint as
# root:root the first time a container mounts it (at the compose up above),
# AFTER any in-place chown — so the uid-1024 webui agent crash-loops on
# "mkdir: cannot create directory '/home/hermes/.hermes': Permission denied"
# (webui-state mounts at /home/hermes/.hermes). Run this as its OWN ssh command
# — NOT inside the set -e step-5 heredoc, where a non-zero from the crash-
# looping gateway's compose up aborted the block before it could run — so the
# fixup always executes once compose has created the mountpoints. Idempotent.
# ──────────────────────────────────────────────────────────────────────────────
echo "  step 5b/6: fix volume ownership (uid 1024) + re-seed dashboard auth env"

# ── 5b-i. Re-seed the four dashboard basic-auth env vars ────────────────────
# A box archived before the dashboard auth gate landed comes back with a
# pre-hardening per-instance .env. Nothing in the restore path re-renders any
# provisioning artifact, but the CONTAINER IMAGE is pulled fresh — so an old
# box meets a new image that refuses to bind the dashboard to 0.0.0.0 without a
# registered auth provider, and official-dashboard crash-loops forever:
#   "Refusing to bind dashboard to 0.0.0.0 — the auth gate engages on
#    non-loopback binds, but no auth providers are registered."
# Self-contained on purpose: the credential is ALREADY on the box as
# API_SERVER_KEY (both are the per-instance webuiPassword), and the secret is a
# pure derivation of it — so no new script argument or caller change is needed.
# Must mirror webui-instance-builder.ts exactly:
#   USERNAME = "hivra"  (DASHBOARD_BASIC_AUTH_USERNAME)
#   SECRET   = sha256("<password>:hermes-dashboard-basic-auth")
#   TTL      = 43200
# Idempotent: only appends keys that are absent, never rewrites an existing one.
ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" "sudo bash -c '
  ENVF=\"/opt/hermes/instances/${INSTANCE_ID}/.env\"
  [ -f \"\$ENVF\" ] || exit 0
  grep -q \"^HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=\" \"\$ENVF\" && exit 0
  PW=\$(grep -m1 \"^API_SERVER_KEY=\" \"\$ENVF\" | cut -d= -f2-)
  [ -n \"\$PW\" ] || { echo \"[restore] no API_SERVER_KEY; cannot seed dashboard auth\" >&2; exit 0; }
  SECRET=\$(printf \"%s:hermes-dashboard-basic-auth\" \"\$PW\" | sha256sum | cut -d\" \" -f1)
  {
    echo \"HERMES_DASHBOARD_BASIC_AUTH_USERNAME=hivra\"
    echo \"HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=\$PW\"
    echo \"HERMES_DASHBOARD_BASIC_AUTH_SECRET=\$SECRET\"
    echo \"HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS=43200\"
  } >> \"\$ENVF\"
  echo \"[restore] seeded dashboard basic-auth env\"
'" || echo "[restore] dashboard-auth seeding returned nonzero; continuing" >&2

# ── 5b-ii. Volume ownership, RETRIED ────────────────────────────────────────
# Docker initializes a named volume's _data mountpoint as root:root the first
# time a container mounts it (at the compose up above), AFTER any in-place
# chown — so the uid-1024 agent crash-loops on
# "mkdir: cannot create directory '/home/hermes/.hermes': Permission denied".
# This ran as ONE un-retried ssh whose failure was swallowed by `|| echo`, so a
# single ConnectTimeout=5 miss (common while the freshly-booted guest is still
# settling) silently skipped the chown and left the box permanently broken —
# observed in prod on fixturecase19 (2026-07-24). Retry, and VERIFY the result
# instead of trusting the exit code. Recreate (not restart) so the containers
# pick up the .env seeded above: `compose restart` reuses the old container env.
# Retry only the CHEAP half. The chown is a couple of seconds and is what the
# transient ssh failure was losing; the container recreate is up to 180s and
# retrying THAT three times added ~9min of worst-case runway to a script whose
# caller only has a 800s function budget — i.e. it risked the outer timeout
# SIGKILLing a restore that was actually fine. Chown (retried, verified) first,
# recreate exactly once after.
OWNERSHIP_OK=false
for attempt in 1 2 3; do
  ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" "sudo bash -c '
    for v in agent-source webui-state webui-workspace; do
      d=\"/var/lib/docker/volumes/agent-${INSTANCE_ID}_\${v}/_data\"
      [ -d \"\$d\" ] && chown -R 1024:1024 \"\$d\"
    done
  '" 2>/dev/null || { echo "[restore] chown ssh failed on attempt $attempt" >&2; sleep 5; continue; }
  OWNED=$(ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" \
    "sudo stat -c %u /var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-state/_data 2>/dev/null" || echo "")
  if [ "$OWNED" = "1024" ]; then OWNERSHIP_OK=true; break; fi
  echo "[restore] volume still owned by uid=${OWNED:-unknown} after attempt $attempt" >&2
  sleep 5
done
[ "$OWNERSHIP_OK" = true ] \
  || echo "[restore] WARNING: volume ownership not confirmed as uid 1024 after 3 attempts — the agent will likely crash-loop" >&2

# Recreate ONCE (not `restart`): containers must pick up the .env seeded in 5b-i,
# and restart would reuse the old container env. Non-fatal — step 6 is the real
# gate, and a health_pending exit parks the box for the recovery sweep rather
# than tearing down a VM whose data restored fine.
ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" "sudo bash -c '
  cd \"/opt/hermes/instances/${INSTANCE_ID}\" && timeout 180 docker compose up -d --force-recreate 2>&1 | tail -3
'" || echo "[restore] container recreate returned nonzero; continuing to health probe" >&2

# ──────────────────────────────────────────────────────────────────────────────
# Step 6: health probe
# ──────────────────────────────────────────────────────────────────────────────
echo "  step 6/6: health probe (up to 300s)"
HEALTHY=false
# 300s — cold-pull of all container images on a freshly-cloned VM can
# easily exceed the prior 60s budget (saw 8+ min during the
# 2026-05-17 parallel-restore smoke test).
for _ in $(seq 1 60); do  # 300s
  STATUS=$(ssh "${SSH_OPTS[@]}" "hermes@$GUEST_IP" \
    "sudo docker ps --filter 'name=agent-${INSTANCE_ID}-gateway' --format '{{.Status}}' 2>/dev/null" || echo "")
  if echo "$STATUS" | grep -q "healthy"; then
    HEALTHY=true
    break
  fi
  sleep 5
done

if [ "$HEALTHY" != true ]; then
  echo "[restore] gateway never reported healthy after 60s" >&2
  # Don't destroy here — the data restore worked, agent may still be coming up.
  # Caller decides whether to teardown or wait.
  echo "RESULT status=health_pending instance=$INSTANCE_ID vmid=$NEW_VMID host=$PVE_HOST ip=$GUEST_IP archive=$ARCHIVE_URI sha256=$EXPECTED_SHA size=$ARCHIVE_SIZE"
  exit 5
fi

echo "═══ restored: $INSTANCE_ID at $GUEST_IP (vmid $NEW_VMID on $PVE_HOST) ═══"
# Final line is the machine-parseable result the orchestrator scrapes.
echo "RESULT status=ok instance=$INSTANCE_ID vmid=$NEW_VMID host=$PVE_HOST ip=$GUEST_IP archive=$ARCHIVE_URI sha256=$EXPECTED_SHA size=$ARCHIVE_SIZE"
