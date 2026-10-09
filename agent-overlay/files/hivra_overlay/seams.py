"""Runtime seams: wrap upstream functions in place instead of editing upstream files.

Each seam names an upstream callable (``module:Qualified.name``), the Hivra decorator that wraps
it, and a marker attribute so applying twice is a no-op. Applying is done at plugin load time
(``plugins/hivra-core``), before the first agent turn. A seam whose upstream target has moved is
REPORTED (status ``missing``), never silently skipped: ``scripts/check-seams.py`` turns that into
a failed overlay build, which is the guard against upstream drift.
"""

from __future__ import annotations

import importlib
import logging
import os
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

# seam -> (upstream target, decorator module, decorator name, marker attribute)
SEAMS: Dict[str, tuple] = {
    "gateway_turn": ("gateway.run:GatewayRunner._handle_message_with_agent",
                     "gateway.runtime_governor", "governed_gateway_turn", "__hermes_runtime_governor__"),
    "gateway_run": ("gateway.run:GatewayRunner._run_agent",
                    "gateway.runtime_governor", "governed_gateway_run", "__hermes_runtime_governor__"),
    "api_run": ("gateway.platforms.api_server:APIServerAdapter._run_agent",
                "gateway.runtime_governor", "governed_api_run", "__hermes_runtime_governor__"),
    "api_runs_sync": ("gateway.platforms.api_server_runs:_run_agent_sync",
                      "gateway.runtime_governor", "governed_run_sync", "__hermes_runtime_governor__"),
    "cron_run": ("cron.scheduler:_run_agent_with_watchdog",
                 "gateway.runtime_governor", "governed_cron_run", "__hermes_runtime_governor__"),
    "held_lock": ("gateway.status:_cleanup_invalid_pid_path",
                  "gateway.fork_status_guard", "keep_held_lock_files", "__hermes_fork_held_lock_guard__"),
}

# The metering seams only matter when the managed runtime governor is switched on. They stay
# unapplied (zero patching, zero drift risk) on boxes where HERMES_RUNTIME_GOVERNOR_ENABLED and
# HERMES_RUNTIME_GOVERNOR_REQUIRED are unset, which is every box today: no control-plane code sets
# them or serves the sidecar /admit API (checked 2026-10-08).
GOVERNOR_SEAMS = ("gateway_turn", "gateway_run", "api_run", "api_runs_sync", "cron_run")

STATUS: Dict[str, str] = {}


def governor_enabled() -> bool:
    truthy = {"1", "true", "yes", "on"}
    return any(
        os.environ.get(name, "").strip().lower() in truthy
        for name in ("HERMES_RUNTIME_GOVERNOR_ENABLED", "HERMES_RUNTIME_GOVERNOR_REQUIRED")
    )


def _resolve(target: str):
    """Return (owner, attribute name) for ``module:Qual.name`` (owner is a module or a class)."""
    module_name, _, qual = target.partition(":")
    owner: Any = importlib.import_module(module_name)
    *path, attr = qual.split(".")
    for part in path:
        owner = getattr(owner, part)
    return owner, attr


def apply_seam(name: str) -> str:
    target, deco_mod, deco_name, marker = SEAMS[name]
    try:
        owner, attr = _resolve(target)
        current = getattr(owner, attr)
    except Exception as exc:  # module or symbol moved upstream
        logger.warning("hivra-overlay: seam %s target %s not found (%s)", name, target, exc)
        STATUS[name] = "missing"
        return "missing"
    if getattr(current, marker, None):
        STATUS[name] = "already"
        return "already"
    decorator: Callable = getattr(importlib.import_module(deco_mod), deco_name)
    setattr(owner, attr, decorator(current))
    STATUS[name] = "applied"
    return "applied"


def apply_all(only: Optional[list] = None) -> Dict[str, str]:
    """Apply seams. ``only`` forces an explicit list (tests, check-seams); default skips the
    governor seams unless the governor is enabled in the environment."""
    if only is None:
        only = [n for n in SEAMS if n not in GOVERNOR_SEAMS or governor_enabled()]
        for skipped in (n for n in SEAMS if n not in only):
            STATUS.setdefault(skipped, "skipped (governor off)")
    for name in only:
        apply_seam(name)
    logger.info("hivra-overlay seams: %s", STATUS)
    return dict(STATUS)
