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
        "--dhcp-host=BC:24:11:74:68:7B,10.240.20.99,hivra-omarchy,12h",
        "--dhcp-host=BC:24:11:57:49:98,10.240.20.98,hivra-windows,12h",
        "--dhcp-option=3,10.240.20.1",
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


if __name__ == "__main__":
    main()
