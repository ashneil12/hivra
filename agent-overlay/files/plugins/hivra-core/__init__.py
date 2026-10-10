"""Hivra overlay plugin: managed-hosting prompt guidance, runtime seams (metering) and Venice remap.

Replaces the two fork edits that used to live in ``agent/prompt_builder.py`` /
``agent/system_prompt.py`` / ``run_agent.py``. Upstream's plugin system-prompt-section API
renders each callable once per new session and skips a section whose text is empty, so both
sections are no-ops on a box without a provisioned Bankr wallet or hosted media tools.
"""

from __future__ import annotations

# Steers media requests to the hosted cloud-generation tools instead of local synthesis
# (torch / audiocraft / ffmpeg), which is slower, lower quality and usually fails on managed boxes.
MEDIA_GENERATION_GUIDANCE = (
    "# Media generation\n"
    "To create images, video, music, audio, songs, jingles, ambient tracks, or "
    "sound effects, you MUST use the dedicated cloud generation tools in your "
    "toolset - image_generate, video_generate, and audio_generate. They are "
    "hosted (no local setup) and return a ready media file. Do NOT write code, "
    "run the terminal, install packages (torch, audiocraft, MusicGen, ffmpeg, "
    "scipy, soundfile, …), or open the audiocraft / heartmula / songwriting "
    "skills to synthesize media yourself - that path is slower, lower quality, "
    "and usually fails here. Example: for \"generate some background music\" or "
    "\"make a 10s track\", call audio_generate directly with the prompt."
)

_MEDIA_TOOLS = ("image_generate", "video_generate", "audio_generate")


def _media_guidance(_session_info) -> str:
    """The guidance only when at least one hosted media tool is registered AND available
    (its check_fn passes, e.g. the Venice key is set); otherwise empty, which core skips."""
    try:
        from tools.registry import registry

        if registry.get_definitions(set(_MEDIA_TOOLS), quiet=True):
            return MEDIA_GENERATION_GUIDANCE
    except Exception:
        pass
    return ""


def _bankr_wallet_guidance(_session_info) -> str:
    from hivra_overlay.bankr_prompt import build_bankr_wallet_prompt

    return build_bankr_wallet_prompt()


# Stock `hermes update` inside a container prints `docker pull nousresearch/hermes-agent` steps that
# do not apply to a Hivra computer (the image is managed by Hivra, and rolled from the dashboard).
MANAGED_UPDATE_GUIDANCE = (
    "# Updating this computer\n"
    "Hermes on this computer is installed and updated by Hivra. `hermes update` does not work here, "
    "and the `docker pull` steps it prints do not apply. Never try to update Hermes, the image or "
    "its source yourself. When the owner asks about updates, tell them the agent page in the Hivra "
    "dashboard shows \"Update available\" and its Update button applies it safely when the "
    "computer is idle."
)


def _managed_update_guidance(_session_info) -> str:
    import os

    return MANAGED_UPDATE_GUIDANCE if (os.environ.get("HERMES_INSTANCE_ID") or "").strip() else ""


def _install_venice_overlay() -> None:
    """Managed Venice runs as provider ``custom`` + a Venice base URL, so the slug-keyed VeniceProfile
    never fires there; wrap the chat-completions transport to apply the same remap / character slug
    by base URL."""
    try:
        from agent.transports.chat_completions import ChatCompletionsTransport
        from hivra_overlay.providers import install_venice_base_url_overlay

        install_venice_base_url_overlay(ChatCompletionsTransport)
    except Exception:  # an overlay failure must never stop the plugin loading
        import logging

        logging.getLogger(__name__).warning("hivra-core: venice base-url overlay not installed", exc_info=True)


def _apply_runtime_seams() -> None:
    """Metering decorators and the held-lock guard, wrapped onto stock upstream callables."""
    try:
        from hivra_overlay.seams import apply_all

        apply_all()
    except Exception:  # never stop the plugin loading; check-seams.py is the build-time guard
        import logging

        logging.getLogger(__name__).warning("hivra-core: runtime seams not applied", exc_info=True)


def register(ctx) -> None:
    _apply_runtime_seams()
    _install_venice_overlay()
    ctx.register_system_prompt_section("hivra-bankr-wallet", _bankr_wallet_guidance)
    ctx.register_system_prompt_section("hivra-media-generation", _media_guidance)
    ctx.register_system_prompt_section("hivra-managed-updates", _managed_update_guidance)
