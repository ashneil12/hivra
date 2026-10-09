"""Venice provider profile.

Venice (https://venice.ai) is a privacy-first, OpenAI-compatible inference
endpoint (chat_completions). Users bring their own ``VENICE_API_KEY``; from
Hermes' perspective it is a plain bring-your-own-key provider, so registering
this profile is all that is needed.

Registering this profile auto-wires the rest of the agent:
  - ``config.py`` surfaces VENICE_API_KEY / VENICE_BASE_URL in the webchat env
    editor (category="provider").
  - ``auth.py`` extends PROVIDER_REGISTRY so credential + base-URL resolution
    works for ``--provider venice``.
  - ``models.py`` / ``main.py`` route it through the generic api-key model
    picker, with live ``/models`` discovery (Venice serves /api/v1/models).

Venice's image / audio / TTS generation is exposed separately through the
Venice media tools and the image_gen/video_gen/web plugins; this profile only
covers chat-completions inference.
"""

from hivra_overlay.providers import VeniceProfile
from providers import register_provider

# Hivra overlay: VeniceProfile (hivra_overlay/providers.py) adds the cross-vendor model-slug remap,
# the optional venice.character_slug injection and a family-sorted live catalog on top of the stock
# profile, via upstream's public ProviderProfile hooks.
venice = VeniceProfile(
    name="venice",
    aliases=("venice-ai", "veniceai"),
    display_name="Venice",
    description="Venice - privacy-first, uncensored OpenAI-compatible inference",
    signup_url="https://venice.ai/settings/api",
    env_vars=("VENICE_API_KEY", "VENICE_BASE_URL"),
    base_url="https://api.venice.ai/api/v1",
    auth_type="api_key",
    supports_vision=True,
    # Live /models discovery supersedes this whenever a key is present; the
    # list is only the picker fallback when the live fetch is unavailable.
    fallback_models=(),
)

register_provider(venice)
