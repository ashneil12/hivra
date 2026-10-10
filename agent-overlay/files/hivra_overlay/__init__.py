"""Hivra overlay for stock upstream Hermes (no fork).

Everything Hivra adds to the agent lives under this package and the add-only plugin, tool and
skill directories that sit beside it in the overlay image layer. Nothing here edits an upstream
file. The runtime wiring (metering decorators, held-lock guard) is applied by
``hivra_overlay.seams.apply_all()``, called from the ``hivra-core`` plugin at load time, and
``scripts/check-seams.py`` fails the overlay build when a seam cannot be applied to the upstream
image it is being layered on.
"""
