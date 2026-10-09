"""Surplus Intelligence provider profile.

Surplus Intelligence (https://www.surplusintelligence.ai) is an open
marketplace for AI inference: an OpenAI-compatible endpoint that routes each
request to the cheapest available seller for the requested model. Buyers
authenticate with an ``inf_`` API key and settle usage in USDC on Base
directly from their own wallet, so from Hermes' perspective it is a plain
bring-your-own-key, OpenAI-compatible (chat_completions) provider.

Registering this profile auto-wires the rest of the agent:
  - ``config.py`` surfaces SURPLUS_API_KEY / SURPLUS_BASE_URL in the webchat
    env editor (category="provider").
  - ``auth.py`` extends PROVIDER_REGISTRY so credential + base-URL resolution
    works for ``--provider surplus``.
  - ``models.py`` / ``main.py`` route it through the generic api-key model
    picker, with live ``/models`` discovery falling back to ``fallback_models``.
"""

from hermes_cli import __version__ as _HERMES_VERSION
from hivra_overlay.providers import SortedCatalogMixin
from providers import register_provider
from providers.base import ProviderProfile


class SurplusProfile(SortedCatalogMixin, ProviderProfile):
    """Marketplace-scale live catalog: family-sort it so the model picker stays navigable."""


surplus = SurplusProfile(
    name="surplus",
    aliases=("surplus-intelligence", "surplusintelligence"),
    display_name="Surplus Intelligence",
    description="Surplus Intelligence - open market for AI inference (routes to the cheapest seller)",
    signup_url="https://www.surplusintelligence.ai/buy",
    env_vars=("SURPLUS_API_KEY", "SURPLUS_BASE_URL"),
    base_url="https://www.surplusintelligence.ai/api/inference/v1",
    auth_type="api_key",
    # Attribution so Surplus can identify traffic originating from Hermes.
    default_headers={"User-Agent": f"HermesAgent/{_HERMES_VERSION}"},
    # Marketplace availability varies by seller; these are the documented,
    # broadly-available tool-calling chat models shown in the /model picker
    # when the live /models fetch is unavailable. Live discovery supersedes
    # this list whenever a key is present.
    fallback_models=(
        "claude-opus-4.6",
        "llama-3.3-70b",
    ),
    # default_aux_model intentionally left unset: a marketplace can't guarantee
    # any single cheap model is always listed, so auxiliary tasks (compression,
    # vision) fall back to the user's selected main model rather than a model
    # that may have no active seller.
)

register_provider(surplus)
