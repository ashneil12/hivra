"""Bankr gateway provider profile.

Bankr (https://bankr.bot) exposes an OpenAI-compatible LLM gateway
(chat_completions) whose usage is funded directly from the agent's Bankr
onchain wallet rather than a prepaid API balance. From Hermes' perspective it
is a plain bring-your-own-key, OpenAI-compatible provider: the user supplies
``BANKR_API_KEY`` (the same key the Bankr wallet skill uses) and inference is
metered against the wallet.

Registering this profile auto-wires the rest of the agent:
  - ``config.py`` surfaces BANKR_API_KEY / BANKR_BASE_URL in the webchat env
    editor (category="provider").
  - ``auth.py`` extends PROVIDER_REGISTRY so credential + base-URL resolution
    works for ``--provider bankr``.
  - ``models.py`` / ``main.py`` route it through the generic api-key model
    picker, with live ``/models`` discovery falling back to ``fallback_models``.

The wallet capability itself (balances, transfers, swaps) lives in the
``optional-skills/bankr`` skill bundle; this profile only covers using the
wallet-funded gateway as an inference provider.
"""

from hivra_overlay.providers import SortedCatalogMixin
from providers import register_provider
from providers.base import ProviderProfile


class BankrProfile(SortedCatalogMixin, ProviderProfile):
    """Gateway catalog is large and unordered: family-sort it for the model picker."""


bankr = BankrProfile(
    name="bankr",
    aliases=("bankr-gateway",),
    display_name="Bankr",
    description="Bankr - wallet-funded OpenAI-compatible LLM gateway",
    signup_url="https://bankr.bot",
    env_vars=("BANKR_API_KEY", "BANKR_BASE_URL"),
    base_url="https://gateway.bankr.bot/v1",
    auth_type="api_key",
    # Live /models discovery supersedes this whenever a key is present.
    fallback_models=(),
)

register_provider(bankr)
