"""Overlay test setup: apply the runtime seams once, like the hivra-core plugin does at gateway start.

Run these tests inside the overlay image with the upstream test tree mounted at tests/ (so the
upstream conftest fixtures apply) and this directory mounted at tests/hivra/. See scripts/run-tests.sh.
"""

import os

import pytest


@pytest.fixture(scope="session", autouse=True)
def _apply_hivra_seams():
    from hivra_overlay import seams

    exclude = {n for n in os.environ.get("HIVRA_TEST_SEAMS_EXCLUDE", "").split(",") if n}
    result = seams.apply_all(only=[n for n in seams.SEAMS if n not in exclude])
    missing = [name for name, status in result.items() if status == "missing"]
    assert not missing, f"overlay seams missing on this upstream image: {missing}"
    return result
