#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }

cd /root/hivra-image-bake
source ./runtime-bake-pins.env
source ./agent-zero-bake-pins.env
archive="$PWD/agent-zero.oci.tar"
image="agent0ai/agent-zero@$AGENT_ZERO_INDEX_DIGEST"
[[ "$AGENT_ZERO_INDEX_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$AGENT_ZERO_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]
[ -f "$archive" ] && [ ! -L "$archive" ]
[ "$(stat -c '%u:%g:%a' -- "$archive")" = '0:0:400' ]
printf '%s  %s\n' "$AGENT_ZERO_ARCHIVE_SHA256" "$archive" | sha256sum --strict --check --status - \
  || die "Agent Zero build archive checksum mismatch"

systemctl start docker.service
[ "$(docker info --format '{{range .DriverStatus}}{{if eq (index . 0) "driver-type"}}{{index . 1}}{{end}}{{end}}')" = io.containerd.snapshotter.v1 ] \
  || die "Agent Zero build requires Docker's containerd image store"
[ "$(docker image ls -aq)" = "" ]
[ "$(docker container ls -aq)" = "" ]
[ "$(docker volume ls -q)" = "" ]
timeout --kill-after=15s 35m docker load --input "$archive"
rm -- "$archive"
[ "$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image")" = "$AGENT_ZERO_INDEX_DIGEST linux/amd64" ] \
  || die "Agent Zero build did not load the exact linux/amd64 index reference"
[ "$(docker container ls -aq)" = "" ]
[ "$(docker volume ls -q)" = "" ]
systemctl stop docker.socket docker.service containerd.service
rm -f -- /var/lib/docker/engine-id /etc/docker/key.json
rm -rf -- /var/lib/docker/network

[ ! -e /opt/a0 ] && [ ! -e /home/bux ] && [ ! -e /etc/systemd/system/hivra-agent-zero.service ]
available_kib="$(df -k --output=avail /var/lib/containerd | tail -n 1)"
[ "$available_kib" -ge "$((5 * 1024 * 1024))" ] \
  || die "Agent Zero build needs 5 GiB free after preload (available: $available_kib KiB)"
install -d -o root -g root -m 0755 /etc/hivra
printf '{"schema":1,"kind":"agent-zero","baseImageSha256":"%s","imageDigest":"%s","archiveSha256":"%s"}\n' \
  "$BASE_IMAGE_SHA256" "$AGENT_ZERO_INDEX_DIGEST" "$AGENT_ZERO_ARCHIVE_SHA256" > /etc/hivra/agent-zero-bake.json
chmod 0644 /etc/hivra/agent-zero-bake.json
