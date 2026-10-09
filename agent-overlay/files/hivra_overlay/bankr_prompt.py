"""Hivra fork: Bankr wallet bridge and prompt guidance (fork-only module).

The Hivra dashboard provisions a Bankr-managed wallet by writing a ``bankr:``
section into ``config.yaml``. The Bankr provider plugin, the ``optional-skills/bankr``
bundle and the wallet prompt all read the wallet from ``BANKR_*`` process env vars, so
this module bridges config -> env. Everything is inert unless that section exists, so a
box with no provisioned wallet behaves exactly like upstream.

Wiring (the only edits to upstream files): ``hermes_cli/config.py`` runs
:func:`bridge_config` on the result of ``load_config()`` / ``load_config_readonly()``
(seam ``bankr-env-bridge``); ``plugins/hivra-core`` registers :func:`build_bankr_wallet_prompt`
as a system-prompt section.
"""

from __future__ import annotations

import os
from typing import Any, Dict

_ENV_MAPPING_KEYS = {
    "BANKR_AGENT_WALLET_ADDRESS": "walletAddress",
    "BANKR_WALLET_ADDRESS": "walletAddress",
    "BANKR_AGENT_API_KEY": "apiKey",
    "BANKR_API_KEY": "apiKey",
    "BANKR_AGENT_WALLET_ID": "walletId",
    "BANKR_AGENT_WITHDRAWAL_DESTINATION": "withdrawalDestination",
}


def apply_bankr_env_from_config(config: Dict[str, Any]) -> None:
    """Expose dashboard-provisioned Bankr wallet config as process env vars.

    No ``bankr`` section (or a non-dict one) is a no-op. Blank / non-string values are skipped.
    """
    bankr = config.get("bankr") if isinstance(config, dict) else None
    if not isinstance(bankr, dict):
        return
    for env_name, config_key in _ENV_MAPPING_KEYS.items():
        value = bankr.get(config_key)
        if isinstance(value, str) and value.strip():
            os.environ[env_name] = value.strip()


def bridge_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Apply the Bankr env bridge to ``config`` and return it unchanged (never raises)."""
    try:
        apply_bankr_env_from_config(config)
    except Exception:  # an env nicety must never break config loading
        pass
    return config


def build_bankr_wallet_prompt() -> str:
    """Bankr wallet guidance when dashboard-provisioned wallet env exists, else ``""``."""
    api_key_present = bool((os.getenv("BANKR_API_KEY") or os.getenv("BANKR_AGENT_API_KEY") or "").strip())
    wallet_address = (os.getenv("BANKR_WALLET_ADDRESS") or os.getenv("BANKR_AGENT_WALLET_ADDRESS") or "").strip()

    if not api_key_present and not wallet_address:
        return ""

    address_line = f" Address: {wallet_address}." if wallet_address else ""
    return (
        "# Bankr wallet\n"
        "This agent has a Bankr-managed wallet on Base "
        "when BANKR_API_KEY/BANKR_AGENT_API_KEY and "
        "BANKR_WALLET_ADDRESS/BANKR_AGENT_WALLET_ADDRESS are present."
        f"{address_line}\n"
        "Use the installed Bankr skills selectively. For wallet, crypto, x402, "
        "token, deposit, transfer, or Base questions, load the relevant wallet "
        "or Bankr skill with skill_view and follow it. "
        "Do not load wallet skills unless they are relevant.\n"
        "Do not include API key values in responses. V1 wallet support is Base-only."
    )
