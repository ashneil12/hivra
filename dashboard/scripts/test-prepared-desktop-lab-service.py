#!/usr/bin/env python3
"""Contract check for the retained Windows and Omarchy Canary DHCP unit."""

from pathlib import Path


UNIT = (
    Path(__file__).resolve().parents[1]
    / "provisioner"
    / "prepared-desktop-lab"
    / "hivra-desktop-lab-dhcp-dnsfix.service"
)


def main() -> None:
    text = UNIT.read_text(encoding="utf-8")
    required = (
        "After=network-online.target",
        "Before=pve-guests.service",
        "--interface=vmbr1",
        # The published unit uses the 198.51.100.0/24 documentation range. The
        # pool must hold exactly the two reserved desktop addresses.
        "--dhcp-range=198.51.100.98,198.51.100.99,255.255.255.0,12h",
        "--dhcp-host=BC:24:11:74:68:7B,198.51.100.99,hivra-omarchy,12h",
        "--dhcp-host=BC:24:11:57:49:98,198.51.100.98,hivra-windows,12h",
        "--dhcp-option=3,198.51.100.1",
        "--dhcp-option=6,185.12.64.2,185.12.64.1",
        "Restart=always",
        "WantedBy=multi-user.target",
    )
    lines = text.splitlines()
    missing = [entry for entry in required if entry not in lines and entry not in text]
    if missing:
        raise SystemExit(f"missing persistent DHCP contract: {missing}")
    if any(line.startswith("+") for line in lines):
        raise SystemExit("patch marker leaked into the systemd unit")
    if "1.1.1.1" in text or "8.8.8.8" in text:
        raise SystemExit("unreachable public DNS resolver returned to the desktop lab")
    print("PASS prepared desktop lab DHCP unit: reserved desktop leases, gateway, resolvers and restart policy")


if __name__ == "__main__":
    main()
