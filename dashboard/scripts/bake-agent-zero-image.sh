bake_agent_zero_preload() {
  cat > "$WORK/preload-meta-data" <<'CLOUD'
instance-id: hivra-agent-zero-build
CLOUD
  cat > "$WORK/preload-user-data" <<'CLOUD'
#cloud-config
ssh_pwauth: false
preserve_hostname: true
users: []
network: {config: disabled}
runcmd:
  - [bash, -c, 'env -i HOME=/root LANG=C.UTF-8 PATH=/usr/sbin:/usr/bin:/sbin:/bin bash /root/hivra-image-bake/bake-agent-zero-preload.sh; result=$?; sync; systemctl --no-block poweroff; exit "$result"']
CLOUD
  cloud-localds "$WORK/preload-seed.iso" "$WORK/preload-user-data" "$WORK/preload-meta-data"
  timeout --kill-after=15s 45m qemu-system-x86_64 \
    -machine pc,accel=kvm:tcg -m "$MEMORY_MB" -smp 4 -nic none \
    -display none -monitor none -serial "file:$WORK/preload-serial.log" -no-reboot \
    -drive "file=$WORK/build.qcow2,format=qcow2,if=virtio" \
    -drive "file=$WORK/preload-seed.iso,format=raw,media=cdrom,readonly=on" \
    || { tail -n 80 "$WORK/preload-serial.log" >&2; return 1; }
  [ -n "$(virt-cat --format=qcow2 -a "$WORK/build.qcow2" /etc/hivra/agent-zero-bake.json)" ] \
    || { tail -n 80 "$WORK/preload-serial.log" >&2; return 1; }
}
