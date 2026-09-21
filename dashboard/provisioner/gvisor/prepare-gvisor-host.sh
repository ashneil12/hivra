#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077

prepare_stage="host-eligibility"
tmp_bundle=""
tmp_adapter=""
tmp_dir=""
sidecar_stage=""
cleanup() {
  status=$?
  trap - EXIT
  if [ -n "$tmp_bundle" ]; then rm -f -- "$tmp_bundle"; fi
  if [ -n "$tmp_adapter" ]; then rm -f -- "$tmp_adapter"; fi
  if [ -n "$tmp_dir" ]; then rm -rf -- "$tmp_dir"; fi
  if [ -n "$sidecar_stage" ] && [ -d "$sidecar_stage" ]; then rm -rf -- "$sidecar_stage"; fi
  if [ "$status" -ne 0 ]; then
    printf 'HIVRA_GVISOR_PREPARE_FAILED_V1 %s\n' "$prepare_stage" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$(id -u)" -eq 0 ]
[ "$(uname -s)" = Linux ]
[ "$(uname -m)" = x86_64 ]
[ -r /etc/os-release ]
grep -Eq '^ID=ubuntu$' /etc/os-release
grep -Eq '^VERSION_ID="?(22\.04|24\.04)"?$' /etc/os-release

BUNDLE_URL="${HIVRA_GVISOR_BUNDLE_URL:?Pinned gVisor bundle URL is required}"
BUNDLE_SHA256="${HIVRA_GVISOR_BUNDLE_SHA256:?Pinned gVisor bundle SHA-256 is required}"
ADAPTER_SOURCE="${HIVRA_GVISOR_ADAPTER_SOURCE:?Adapter source is required}"
ADAPTER_SHA256="${HIVRA_GVISOR_ADAPTER_SHA256:?Adapter SHA-256 is required}"
[ "$BUNDLE_URL" = 'https://github.com/google/gvisor/releases/download/release-20260907.0/gvisor-x86_64.tar.bz2' ]
[ "$BUNDLE_SHA256" = '81416511897ab8abd4e723d66823c5b0461a2ee3311cfa70d152404ef9b860cf' ]
[[ "$BUNDLE_SHA256:$ADAPTER_SHA256" =~ ^[0-9a-f]{64}:[0-9a-f]{64}$ ]]

prepare_stage="prerequisites"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io python3 ca-certificates curl bzip2
elif ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 \
  || ! command -v bzip2 >/dev/null 2>&1 || [ ! -r /etc/ssl/certs/ca-certificates.crt ]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 ca-certificates curl bzip2
fi
systemctl enable --now docker

tmp_bundle="$(mktemp /tmp/hivra-gvisor.XXXXXXXX.tar.bz2)"
tmp_adapter="$(mktemp /tmp/hivra-gvisor-adapter.XXXXXXXX)"
tmp_dir="$(mktemp -d /tmp/hivra-gvisor-bin.XXXXXXXX)"
prepare_stage="bundle-download"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "$BUNDLE_URL" -o "$tmp_bundle"
printf '%s  %s\n' "$BUNDLE_SHA256" "$tmp_bundle" | sha256sum -c -
prepare_stage="bundle-validation"
if tar -tjf "$tmp_bundle" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then exit 1; fi
tar -xjf "$tmp_bundle" -C "$tmp_dir"
[ -x "$tmp_dir/runsc" ]
[ -x "$tmp_dir/containerd-shim-runsc-v1" ]
[ -d "$tmp_dir/gvisor-bin" ]
if find "$tmp_dir" -type l -o -type b -o -type c -o -type p -o -type s | grep -q .; then exit 1; fi
for sidecar in checkpointgofer gvisor-sentry-prewarmer gvisor_sentry runsc-metric-server; do
  [ -x "$tmp_dir/gvisor-bin/$sidecar" ]
done
[ "$(find "$tmp_dir/gvisor-bin" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 4 ]

# Preparation may fill in a missing pinned bundle, but it never replaces a
# different installed runtime identity behind existing sandbox bindings.
prepare_stage="installed-identity-check"
if command -v runsc >/dev/null 2>&1; then
  [ "$(readlink -f "$(command -v runsc)")" = /usr/local/bin/runsc ]
  [ "$(sha256sum /usr/local/bin/runsc | awk '{print $1}')" = "$(sha256sum "$tmp_dir/runsc" | awk '{print $1}')" ]
fi
configured_runsc="$(docker info --format '{{with (index .Runtimes "runsc")}}{{.Path}}{{end}}' 2>/dev/null || true)"
if [ -n "$configured_runsc" ]; then
  [ "$(readlink -f "$configured_runsc")" = /usr/local/bin/runsc ]
fi
if [ -e /usr/local/bin/gvisor-bin ]; then
  [ -d /usr/local/bin/gvisor-bin ] && [ ! -L /usr/local/bin/gvisor-bin ]
  [ "$(find /usr/local/bin/gvisor-bin -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 4 ]
  for sidecar in checkpointgofer gvisor-sentry-prewarmer gvisor_sentry runsc-metric-server; do
    [ "$(sha256sum "/usr/local/bin/gvisor-bin/$sidecar" | awk '{print $1}')" = "$(sha256sum "$tmp_dir/gvisor-bin/$sidecar" | awk '{print $1}')" ]
  done
fi
if [ -e /opt/hivra/gvisor-adapter/hivra-gvisor-adapter ]; then
  [ "$(sha256sum /opt/hivra/gvisor-adapter/hivra-gvisor-adapter | awk '{print $1}')" = "$ADAPTER_SHA256" ]
fi
prepare_stage="asset-installation"
while IFS= read -r -d '' binary; do
  name="$(basename "$binary")"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]]
  install -o root -g root -m 0755 "$binary" "/usr/local/bin/$name"
done < <(find "$tmp_dir" -maxdepth 1 -type f -perm /111 -print0)

sidecar_stage="$(mktemp -d /usr/local/bin/.hivra-gvisor-bin.XXXXXXXX)"
sidecar_previous="/usr/local/bin/.hivra-gvisor-bin.previous.$$"
for sidecar in checkpointgofer gvisor-sentry-prewarmer gvisor_sentry runsc-metric-server; do
  install -o root -g root -m 0755 "$tmp_dir/gvisor-bin/$sidecar" "$sidecar_stage/$sidecar"
done
chown root:root "$sidecar_stage"
chmod 0755 "$sidecar_stage"
if [ -e /usr/local/bin/gvisor-bin ]; then
  [ -d /usr/local/bin/gvisor-bin ] && [ ! -L /usr/local/bin/gvisor-bin ]
  mv /usr/local/bin/gvisor-bin "$sidecar_previous"
fi
if ! mv "$sidecar_stage" /usr/local/bin/gvisor-bin; then
  if [ -d "$sidecar_previous" ]; then mv "$sidecar_previous" /usr/local/bin/gvisor-bin; fi
  exit 1
fi
sidecar_stage=""
if [ -d "$sidecar_previous" ]; then rm -rf -- "$sidecar_previous"; fi

printf '%s' "$ADAPTER_SOURCE" | base64 --decode > "$tmp_adapter"
printf '%s  %s\n' "$ADAPTER_SHA256" "$tmp_adapter" | sha256sum -c -
install -d -o root -g root -m 0700 /opt/hivra/gvisor-adapter
install -o root -g root -m 0700 "$tmp_adapter" /opt/hivra/gvisor-adapter/hivra-gvisor-adapter
runsc_sha256="$(sha256sum /usr/local/bin/runsc | awk '{print $1}')"
printf '%s\n' "$BUNDLE_SHA256" > /opt/hivra/gvisor-adapter/bundle.sha256
printf '%s\n' "$runsc_sha256" > /opt/hivra/gvisor-adapter/runsc.sha256
for sidecar in checkpointgofer gvisor-sentry-prewarmer gvisor_sentry runsc-metric-server; do
  sha256sum "/usr/local/bin/gvisor-bin/$sidecar"
done > /opt/hivra/gvisor-adapter/gvisor-bin.sha256
chmod 0600 /opt/hivra/gvisor-adapter/bundle.sha256 /opt/hivra/gvisor-adapter/runsc.sha256 \
  /opt/hivra/gvisor-adapter/gvisor-bin.sha256

prepare_stage="runtime-registration"
/usr/local/bin/runsc install
systemctl reload docker
registered_runsc=""
for _attempt in {1..30}; do
  registered_runsc="$(docker info --format '{{with (index .Runtimes "runsc")}}{{.Path}}{{end}}' 2>/dev/null || true)"
  if [ -n "$registered_runsc" ] && [ "$(readlink -f "$registered_runsc")" = /usr/local/bin/runsc ]; then
    break
  fi
  sleep 1
done
[ -n "$registered_runsc" ]
[ "$(readlink -f "$registered_runsc")" = /usr/local/bin/runsc ]
[ "$(sha256sum /usr/local/bin/runsc | awk '{print $1}')" = "$runsc_sha256" ]
prepare_stage="sidecar-validation"
[ "$(stat -c '%U:%G:%a' /usr/local/bin/gvisor-bin)" = 'root:root:755' ]
for sidecar in checkpointgofer gvisor-sentry-prewarmer gvisor_sentry runsc-metric-server; do
  [ "$(stat -c '%U:%G:%a' "/usr/local/bin/gvisor-bin/$sidecar")" = 'root:root:755' ]
done
(cd / && sha256sum -c /opt/hivra/gvisor-adapter/gvisor-bin.sha256)
prepare_stage="image-pull"
docker pull --platform linux/amd64 'python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285'
prepare_stage="sandbox-smoke-test"
smoke_name="hivra-gvisor-prepare-$(date +%s)-$$"
docker run --rm --name "$smoke_name" --runtime=runsc --network=none --read-only \
  --user 65534:65534 --cap-drop=ALL --security-opt=no-new-privileges --pids-limit 32 \
  'python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285' \
  /usr/bin/printf 'HIVRA_GVISOR_SMOKE_V1\n' | grep -qx 'HIVRA_GVISOR_SMOKE_V1'
prepare_stage="complete"
printf 'HIVRA_GVISOR_PREPARED_V1 %s %s %s\n' "$BUNDLE_SHA256" "$runsc_sha256" "$ADAPTER_SHA256"
