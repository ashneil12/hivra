# A stand-in for a fresh Ubuntu 24.04 cloud VM, booted with systemd, for the
# per-agent install-and-reply check (run.sh). Packages a cloud image already
# has are added so the real guest installer runs unchanged. The guest agent's
# unit is replaced: a container has no virtio port for it to bind to, and a
# drop-in cannot remove a dependency.
FROM ubuntu:24.04
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus udev kmod cron iproute2 \
      openssh-server ca-certificates curl sudo python3 \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && printf '[Unit]\nDescription=QEMU Guest Agent (container stand-in: there is no virtio port)\n[Service]\nExecStart=/bin/sleep infinity\n' \
      > /etc/systemd/system/qemu-guest-agent.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
