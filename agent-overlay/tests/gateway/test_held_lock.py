"""Held runtime lock keeps the identity files (split-container PID namespaces).

Ported from the fork's tests/gateway/test_status.py. Run once with the overlay seam applied (must
pass) and once with HIVRA_TEST_SEAMS_EXCLUDE=held_lock to learn whether stock upstream already
covers the case (then the seam can be deleted).
"""
import json
import os

import pytest

from gateway import status

# hermes-fork: held-lock-keeps-identity-files. Upstream's scoped dead-pid cleanup
# (test_scoped_query_still_cleans_dead_pid_record) owns the explicit-path missing/malformed
# cases, so only the unscoped queries (the dashboard probing its own home) are asserted here,
# plus the scoped live-but-unrelated pid that upstream already preserves.
@pytest.mark.parametrize(
    ("explicit_path", "record_kind"),
    [(False, "missing-pid"), (False, "unrelated-pid"), (False, "malformed"), (True, "unrelated-pid")],
    ids=["default-missing-pid", "default-unrelated-pid", "default-malformed", "other-profile-unrelated-pid"],
)
def test_unvalidated_pid_preserves_active_runtime_lock(
    tmp_path, monkeypatch, explicit_path, record_kind
):
    """A shared runtime lock can be held outside the reader's PID namespace.

    Exercise the real PID/identity probes and OS file lock: metadata that
    cannot identify a local gateway must not unlink a live lock's inode.
    """
    process_home = tmp_path / "default"
    process_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(process_home))
    gateway_home = tmp_path / "other-profile" if explicit_path else process_home
    gateway_home.mkdir(exist_ok=True)
    pid_path = gateway_home / "gateway.pid"
    lock_path = gateway_home / "gateway.lock"
    lookup_path = pid_path if explicit_path else None

    if record_kind == "malformed":
        contents = "{incomplete gateway metadata"
    else:
        pid = 2**31 - 1 if record_kind == "missing-pid" else os.getpid()
        assert status._pid_exists(pid) is (record_kind == "unrelated-pid")
        contents = json.dumps({
            "pid": pid,
            "kind": "hermes-gateway",
            "argv": ["python", "-m", "hermes_cli.main", "gateway", "run"],
        })
        if record_kind == "unrelated-pid":
            # A stale record must not make this live pytest process count
            # as the gateway merely because its PID is locally visible.
            assert status._read_process_cmdline(pid)
            assert not status._record_matches_live_gateway_pid(json.loads(contents), pid)

    pid_path.write_text(contents, encoding="utf-8")
    with lock_path.open("w+", encoding="utf-8") as handle:
        handle.write(contents)
        handle.flush()
        assert status._try_acquire_file_lock(handle)
        try:
            assert status.is_gateway_runtime_lock_active(lock_path)
            assert status.get_running_pid(lookup_path) is None
            assert pid_path.read_text(encoding="utf-8") == contents
            assert lock_path.read_text(encoding="utf-8") == contents
            assert lock_path.stat().st_ino == os.fstat(handle.fileno()).st_ino
            assert status.is_gateway_runtime_lock_active(lock_path)
        finally:
            status._release_file_lock(handle)

    # After release these same files really are stale. Read-only callers
    # retain them, while the default cleanup still removes both records.
    assert not status.is_gateway_runtime_lock_active(lock_path)
    assert status.get_running_pid(lookup_path, cleanup_stale=False) is None
    assert pid_path.exists()
    assert lock_path.exists()
    assert status.get_running_pid(lookup_path) is None
    assert not pid_path.exists()
    assert not lock_path.exists()
