"""Exact new transport against pinned Codex in an owned offline Linux fixture."""
import importlib.util
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import time
from unittest.mock import patch
import uuid


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, '/tmp/' + filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def signal_group(process, sig):
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass  # An exit between poll and signal is already stopped, not failure.


def main():
    assert os.geteuid() == 0 and Path('/.dockerenv').exists(), 'owned root Docker fixture required'
    fixture = module('preflight_fixture', 'test-attached-codex-activation-preflight.py')
    protocol = module('native_protocol', 'attached-codex-protocol.py')
    native = module('native_probe', 'probe-attached-codex-native.py')
    fixture.PreflightTests.setUpClass()
    receipt = fixture.PreflightTests.request['staged']['receipt']
    uid, gid = receipt['uid'], receipt['gid']
    home = receipt['home']
    runtime = Path('/run') / ('protocol-fixture-' + uuid.uuid4().hex)
    runtime.mkdir(mode=0o700)
    os.chown(runtime, uid, gid)
    endpoint = runtime / 'app.sock'
    process = None
    try:
        subprocess.run(['/usr/bin/mkdir', '-p', home + '/.codex'], check=True,
            timeout=5, user=uid, group=gid, extra_groups=[], umask=0o077)
        process = subprocess.Popen([receipt['executable'], '-c', 'analytics.enabled=false',
            'app-server', '--listen', 'unix://' + str(endpoint)],
            env={'HOME': home, 'CODEX_HOME': home + '/.codex', 'PATH': '/usr/bin:/bin'},
            cwd=home, user=uid, group=gid, extra_groups=[], umask=0o077,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        # This harness owns the unreaped child. Popen.poll observes that exact
        # child rather than guessing liveness from a potentially reused PID.
        # Docker's amd64 emulation here does not implement pidfd_open.
        deadline = time.monotonic() + 20
        while not endpoint.exists():
            assert process.poll() is None, 'native runtime exited before socket'
            assert time.monotonic() < deadline, 'native startup deadline'
            time.sleep(0.05)
        before = endpoint.lstat()
        assert before.st_uid == uid and before.st_gid == gid and before.st_mode & 0o777 == 0o600
        for _ in range(2):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(str(endpoint))
                peer = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                assert peer == (process.pid, uid, gid), 'peer differs from owned runtime'
                protocol.initialize(client, home + '/.codex', time.monotonic() + 5)
                assert process.poll() is None, 'native runtime exited during initialize'
            with native.check_native(fixture.preflight.__dict__, fixture.PreflightTests.request,
                    {'socketPath': str(endpoint)}, process.pid, protocol.__dict__):
                pass
        def refused(callback):
            try:
                callback()
            except (ValueError, OSError):
                return
            raise AssertionError('unsafe native probe accepted')
        def check(pid=process.pid):
            with native.check_native(fixture.preflight.__dict__, fixture.PreflightTests.request,
                    {'socketPath': str(endpoint)}, pid, protocol.__dict__):
                pass
        refused(lambda: check(os.getpid()))  # A real but wrong process is not the peer.
        endpoint.chmod(0o666)
        try:
            refused(check)
        finally:
            endpoint.chmod(0o600)
        original_initialize = protocol.initialize
        def changed_directory(*args):
            original_initialize(*args)
            runtime.chmod(0o755)
        try:
            with patch.object(protocol, 'initialize', side_effect=changed_directory):
                refused(check)
        finally:
            runtime.chmod(0o700)
        def late_change():
            with native.check_native(fixture.preflight.__dict__, fixture.PreflightTests.request,
                    {'socketPath': str(endpoint)}, process.pid, protocol.__dict__):
                endpoint.chmod(0o666)  # Simulate drift during final activation checks.
        try:
            refused(late_change)
        finally:
            endpoint.chmod(0o600)
        after = endpoint.lstat()
        assert (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode) == (
            after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode)
        print('PASS pinned Codex 0.149.1: bound probe, reconnect, wrong-peer/mode/namespace refusal')
    finally:
        if process is not None:
            if process.poll() is None:
                signal_group(process, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    signal_group(process, signal.SIGKILL)
                    process.wait(timeout=5)
        remaining = []
        for entry in Path('/proc').iterdir():
            if entry.name.isdecimal():
                try:
                    if entry.stat().st_uid == uid:
                        remaining.append(entry.name)
                except FileNotFoundError:
                    pass
        assert not remaining, 'owned runtime account still has processes'
        endpoint.unlink(missing_ok=True)
        runtime.rmdir()
        print('PASS owned account processes and runtime directory released')


if __name__ == '__main__':
    main()
