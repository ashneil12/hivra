"""The overlay's guard against upstream drift: every seam must resolve and be applied."""

import pytest

from hivra_overlay import seams


@pytest.mark.parametrize("name", sorted(seams.SEAMS))
def test_seam_applies_to_upstream(name):
    assert seams.STATUS.get(name) in {"applied", "already"}, seams.STATUS


@pytest.mark.parametrize("name", sorted(seams.SEAMS))
def test_seam_is_idempotent(name):
    before = seams._resolve(seams.SEAMS[name][0])
    owner, attr = before
    first = getattr(owner, attr)
    assert seams.apply_seam(name) == "already"
    assert getattr(owner, attr) is first


def test_governor_seam_table_matches_module():
    """The module's own GOVERNED_SEAMS table (used by its tests) must name the same targets."""
    from gateway.runtime_governor import GOVERNED_SEAMS

    for seam, target in GOVERNED_SEAMS.items():
        assert seams.SEAMS[seam][0].split(":")[1].split(".")[-1] == target.split(":")[1].split(".")[-1]


def test_governor_seams_stay_off_by_default(monkeypatch):
    monkeypatch.delenv("HERMES_RUNTIME_GOVERNOR_ENABLED", raising=False)
    monkeypatch.delenv("HERMES_RUNTIME_GOVERNOR_REQUIRED", raising=False)
    assert seams.governor_enabled() is False
    monkeypatch.setenv("HERMES_RUNTIME_GOVERNOR_ENABLED", "1")
    assert seams.governor_enabled() is True
