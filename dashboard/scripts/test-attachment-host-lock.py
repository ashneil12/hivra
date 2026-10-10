#!/usr/bin/env python3
"""Exact lock program in an owned root Linux container only; no host mounts.

Run from dashboard/: docker run --rm --network none -v "$PWD/src/lib/agent-computers/attachment-host-observation.ts":/tmp/attachment-host-observation.ts:ro \\
  -v "$PWD/scripts":/scripts:ro node:22-bookworm python3 -I -B /scripts/test-attachment-host-lock.py
"""
import os
from pathlib import Path
import stat
import subprocess

if os.geteuid() != 0 or not Path('/.dockerenv').exists():
    raise SystemExit('owned root Docker fixture required')
source = Path('/tmp/attachment-host-observation.ts').read_text()
delimiter = 'export const ATTACHMENT_HOST_LOCK_PROGRAM = String.raw`'
assert source.count(delimiter) == 1
program = source.split(delimiter, 1)[1].split('`;', 1)[0]
directory = Path('/run/lock')
directory.mkdir(exist_ok=True)
directory.chmod(0o1777)  # Owned container fixture, not a real host directory.
lock = directory / 'hivra-allocation.lock'
assert not os.path.lexists(lock), 'fixture collision'
lock.write_bytes(b'preserve lock bytes\n')
lock.chmod(0o644)
before = (directory.stat().st_mode, lock.stat().st_ino, lock.stat().st_mode, lock.read_bytes())

def run():
    return subprocess.run(['/usr/bin/python3', '-I', '-B', '-c', program, 'printf locked'],
                          capture_output=True, timeout=15, check=False)

assert run().stdout == b'locked'
# The step gets the lock on fd 9 and can release it before its long wait.
TRY = ('/usr/bin/python3 -I -c "import fcntl,os;fd=os.open(\'/run/lock/hivra-allocation.lock\',os.O_RDONLY);'
       'fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)"')
released = subprocess.run(['/usr/bin/python3', '-I', '-B', '-c', program,
                           f'if {TRY} 2>/dev/null; then exit 9; fi; flock -u 9; exec 9>&-; {TRY} && printf released'],
                          capture_output=True, timeout=15, check=False)
assert released.stdout == b'released', released
assert before == (directory.stat().st_mode, lock.stat().st_ino, lock.stat().st_mode, lock.read_bytes())
lock.chmod(0o666)
assert run().returncode != 0
assert lock.read_bytes() == before[3]
lock.chmod(0o644)
os.chown(lock, 65534, 65534)
assert run().returncode != 0
os.chown(lock, 0, 0)
victim = directory / 'hivra-fixture-victim'
assert not os.path.lexists(victim)
lock.rename(victim)
lock.symlink_to(victim)
assert run().returncode != 0
assert lock.is_symlink() and victim.read_bytes() == before[3]
assert stat.S_IMODE(directory.stat().st_mode) == 0o1777
print('PASS exact lock program preserves directory/file bytes, hands the lock to the step on fd 9, and rejects writable, foreign-owned and symlink locks')
