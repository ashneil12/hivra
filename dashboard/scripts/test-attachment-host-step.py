#!/usr/bin/env python3
"""The exact attach host scripts, as root in an owned disposable container (T3, T25).

The fleet-safety property: launch, start, restart, snapshots and bundle sync
wait at most 60 s for /run/lock/hivra-allocation.lock. An attach step checks
the VM and starts its guest program under that lock, then releases it before
it waits for the answer (up to 540 s for an activation).

A fake `qm` stands in for Proxmox: it answers status and config from fixture
files, runs `guest exec` programs in the container as the "guest", and records
at each call whether the host lock is held. The scripts are the ones Hivra
generates (written by src/lib/agent-computers/__tests__/attachment-host-step.test.ts).
A step is a script plus the separate stdin its transport carries: `run` sends
them the way runProxmoxHostScriptWithStdin does, over a root login (the script
is one `bash -c` argument, the data is stdin) or the sudo loader (both on
stdin behind a length prefix).

Run from dashboard/:
  HIVRA_HOST_STEP_FIXTURE_DIR="$PWD/.host-step-fixture" npx jest attachment-host-step
  docker run --rm --network none -v "$PWD/scripts":/scripts:ro -v "$PWD/.host-step-fixture":/fixture:ro \
    node:22-bookworm python3 -I -B /scripts/test-attachment-host-step.py
(any Debian image with python3, perl and util-linux; Proxmox VE 8 is Debian 12)
Never run it on a real Proxmox host: it replaces /usr/sbin/qm.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

if os.geteuid() != 0 or not Path('/.dockerenv').exists():
    raise SystemExit('owned root Docker fixture required')
FIXTURE = Path('/fixture')
STATE = Path('/run/fake-qm')
QM = Path('/usr/sbin/qm')
LOCK = Path('/run/lock/hivra-allocation.lock')
assert not QM.exists(), 'a real qm is installed here'
target = json.loads((FIXTURE / 'target.json').read_text())

FAKE_QM = r'''#!/usr/bin/python3 -I
import fcntl, json, os, subprocess, sys, time
from pathlib import Path
STATE = Path('/run/fake-qm')

def lock_state():
    fd = os.open('/run/lock/hivra-allocation.lock', os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return 'free'
    except BlockingIOError:
        return 'held'
    finally:
        os.close(fd)

def record(event):
    with open(STATE / 'events', 'a') as stream:
        stream.write(f'{event} {lock_state()} {time.monotonic():.2f}\n')

def pretty(document):
    print(json.dumps(document, indent=3))

args = sys.argv[1:]
if args[:1] == ['__run']:
    job = STATE / 'jobs' / args[1]
    command = json.loads((job.with_suffix('.cmd')).read_text())
    done = subprocess.run(command, input=job.with_suffix('.in').read_bytes(), capture_output=True)
    document = {'exitcode': done.returncode, 'exited': 1, 'out-data': done.stdout.decode(), 'err-data': done.stderr.decode()}
    job.with_suffix('.json').write_text(json.dumps(document))
    sys.exit(0)
if args[0] == 'status':
    record('status')
    print('status: ' + (STATE / 'status').read_text().strip())
elif args[0] == 'config':
    print((STATE / 'config').read_text(), end='')
elif args[:2] == ['guest', 'exec-status']:
    record('poll')
    if (STATE / 'exec-status-fails').exists():
        print('QEMU guest agent is not running', file=sys.stderr)
        sys.exit(255)
    job = STATE / 'jobs' / args[3]
    pretty(json.loads(job.with_suffix('.json').read_text()) if job.with_suffix('.json').exists() else {'exited': 0})
elif args[:2] == ['guest', 'exec']:
    split = args.index('--')
    options, command = args[3:split], args[split + 1:]
    stdin = sys.stdin.buffer.read() if '--pass-stdin' in options else b''
    record('dispatch')
    if options[:2] == ['--synchronous', '0']:
        assert '--timeout' not in options, 'PVE refuses --timeout without synchronous'
        jobs = STATE / 'jobs'
        jobs.mkdir(exist_ok=True)
        pid = str(1000 + len(list(jobs.glob('*.cmd'))))
        (jobs / (pid + '.cmd')).write_text(json.dumps(command))
        (jobs / (pid + '.in')).write_bytes(stdin)
        subprocess.Popen(['/usr/bin/python3', '-I', __file__, '__run', pid], start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        pretty({'pid': int(pid)})
    else:
        assert options == ['--timeout', '0'], options
        done = subprocess.run(command, input=stdin, capture_output=True)
        pretty({'exitcode': done.returncode, 'exited': 1, 'out-data': done.stdout.decode(), 'err-data': done.stderr.decode()})
else:
    sys.exit(f'fake qm: unsupported {args}')
'''


def reset(status='running', ipconfig=f"ip={target['guestIp']}/24,gw=10.241.0.1", tags=f"hivra;{target['bindingTag']}"):
    shutil.rmtree(STATE, ignore_errors=True)
    STATE.mkdir(mode=0o700)
    (STATE / 'status').write_text(status + '\n')
    (STATE / 'config').write_text(f"name: fixture\ntags: {tags}\nipconfig0: {ipconfig}\n")
    (STATE / 'events').write_text('')


def events():
    return [line.split() for line in (STATE / 'events').read_text().splitlines()]


def transport(name, via):
    """The command and stdin runProxmoxHostScriptWithStdin sends for a step."""
    script = (FIXTURE / f'{name}.sh').read_bytes()
    data = (FIXTURE / f'{name}.in').read_bytes()
    if via == 'login':
        encoded = base64.b64encode(script).decode()
        return ['/bin/sh', '-c', f"/bin/bash -c \"$(printf '%s' '{encoded}' | /usr/bin/base64 --decode)\""], data
    loader = (FIXTURE / 'sudo-loader.sh').read_text()
    return ['/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL=C', 'HOME=/root',
            '/bin/bash', '--noprofile', '--norc', '-c', loader], str(len(script)).encode() + b'\n' + script + data


def run(name, timeout=120, via='login'):
    if name.startswith('observation-'):
        # Observations carry no stdin: runProxmoxHostScript, `bash -s`.
        return subprocess.run(['/bin/bash', '-s'], input=(FIXTURE / name).read_bytes(), capture_output=True, timeout=timeout)
    command, data = transport(name, via)
    return subprocess.run(command, input=data, capture_output=True, timeout=timeout)


def lock_free_within(seconds):
    fd = os.open(LOCK, os.O_RDONLY)
    try:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fd, fcntl.LOCK_UN)
                return True
            except BlockingIOError:
                time.sleep(0.2)
        return False
    finally:
        os.close(fd)


Path('/run/lock').mkdir(exist_ok=True)
Path('/run/lock').chmod(0o1777)
assert not LOCK.exists(), 'fixture collision'
LOCK.write_bytes(b'')
LOCK.chmod(0o644)
QM.write_text(FAKE_QM)
QM.chmod(0o755)
try:
    # 1. A long step: the lock is held for the checks and the start, and free
    #    while the guest program works. Another host operation gets the lock
    #    at once instead of waiting behind the attach.
    reset()
    started = time.monotonic()
    command, data = transport('step-ok', 'login')
    stdin_read, stdin_write = os.pipe()
    os.write(stdin_write, data)
    os.close(stdin_write)
    step = subprocess.Popen(command, stdin=stdin_read, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.close(stdin_read)
    time.sleep(2)
    assert lock_free_within(2), 'another host operation must get the lock while the guest works'
    other_waited = time.monotonic() - started
    stdout, stderr = step.communicate(timeout=90)
    assert step.returncode == 0, (step.returncode, stderr)
    assert stdout.decode().strip() == 'HIVRA_FIXTURE_RESULT {"marker":"ok"}', stdout
    seen = events()
    assert [e[:2] for e in seen if e[0] in ('status', 'dispatch')] == [['status', 'held'], ['dispatch', 'held']], seen
    polls = [e for e in seen if e[0] == 'poll']
    assert len(polls) >= 2 and all(e[1] == 'free' for e in polls), polls
    assert other_waited < 6, other_waited
    assert not list(Path('/run').glob('hivra-qga-result.*')), 'result file left behind'
    print('PASS the step holds the host lock for the check and the start only; the guest runs 6 s with the lock free')

    # 1a. A real attached agent bundle is over the host's 128 KiB limit for
    #     one argument. It reaches the guest program byte for byte over both
    #     transports (live on Canary it failed as "Argument list too long").
    large = (FIXTURE / 'step-large.in').read_bytes()
    assert len(large) > 128 * 1024, len(large)
    for via in ('login', 'sudo'):
        reset()
        done = run('step-large', via=via)
        assert done.returncode == 0, (via, done.returncode, done.stderr[-2000:])
        assert done.stdout.decode() == f'HIVRA_FIXTURE_STDIN {len(large)} {hashlib.sha256(large).hexdigest()}\n', (via, done.stdout)
        assert [e[:2] for e in events() if e[0] in ('status', 'dispatch')] == [['status', 'held'], ['dispatch', 'held']], events()
    print(f'PASS a {len(large)}-byte attached agent bundle reaches the guest intact over the login and sudo transports')

    # 1b. A guest program that raised ends the step with its one named refusal
    #    line, carried through the guest exec and the host script (T3).
    #    Before 2: its late guest job would answer a reused fake pid.
    for name, line in (('step-refused', 'HIVRA_GUEST_STEP_REFUSED step_refused\n'),
                       ('stage-refused', 'HIVRA_GUEST_STEP_REFUSED bundle_invalid\n')):
        reset()
        done = run(name)
        assert done.returncode == 1, (name, done)
        assert done.stdout.decode() == line, (name, done.stdout)
        assert b'HIVRA_QGA_FAILURE guest_exit_1' in done.stderr, (name, done.stderr)
    print('PASS a guest program that raised ends the step with its named refusal')

    # 2. The step's deadline ends the wait (the guest keeps its own deadline).
    reset()
    done = run('step-deadline')
    assert done.returncode == 124 and b'HIVRA_QGA_FAILURE await_timeout' in done.stderr, done
    print('PASS the wait ends at the step deadline')

    # 3. A guest agent that stops answering (the VM is gone) ends the wait.
    reset()
    (STATE / 'exec-status-fails').write_text('')
    started = time.monotonic()
    done = run('step-ok')
    assert done.returncode == 125 and b'HIVRA_QGA_FAILURE status_unavailable' in done.stderr, done
    assert time.monotonic() - started < 40
    print('PASS a guest agent that stops answering ends the wait, and no other VM is asked')

    # 4. Refusals before anything runs in the guest, one reason each.
    for change, reason in [({'status': 'stopped'}, 'computer_not_running'),
                           ({'tags': 'hivra;hivra-bind-' + 'b' * 32}, 'binding_mismatch'),
                           ({'ipconfig': 'ip=10.241.0.45/24,gw=10.241.0.1'}, 'address_mismatch'),
                           ({'ipconfig': f"ip={target['guestIp']}/33"}, 'address_mismatch'),
                           ({'ipconfig': f"ip={target['guestIp']}"}, 'address_mismatch')]:
        reset(**change)
        done = run('step-ok')
        assert done.returncode == 3, (change, done)
        assert done.stdout.decode() == f'HIVRA_ATTACHMENT_TARGET_REFUSED {reason}\n', (change, done.stdout)
        assert not any(e[0] == 'dispatch' for e in events()), 'nothing may run in a refused VM'
    print('PASS a stopped VM, another binding tag and another address are refused by name before dispatch')

    # 5. A My server guest on another prefix length is the same guest.
    reset(ipconfig=f"ip={target['guestIp']}/26,gw=10.241.0.1")
    done = run('step-ok')
    assert done.returncode == 0 and b'"marker":"ok"' in done.stdout, done
    print('PASS the guest address is accepted with a /26 prefix')

    # 6. The short boot observation keeps the lock for its bounded run.
    reset()
    arch = platform.machine()
    done = run(f'observation-{arch}.sh')
    assert done.returncode == 0, done
    observed = json.loads(done.stdout)
    assert observed['target']['architecture'] == arch and observed['version'] == 1, observed
    assert [e[:2] for e in events()] == [['status', 'held'], ['dispatch', 'held']], events()
    print('PASS the boot observation runs inside the lock and reads the guest boot id')

    assert LOCK.read_bytes() == b'' and LOCK.stat().st_mode & 0o777 == 0o644
finally:
    QM.unlink()
print('PASS attach host steps')
