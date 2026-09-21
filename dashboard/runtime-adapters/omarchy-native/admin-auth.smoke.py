"""Actual pinned Sunshine authentication smoke; disposable network-none Linux only.

Not a desktop/guardian acceptance test. Never run against an existing service.
The container must contain the official Sunshine binary and a non-root hermes
account. The repository is mounted read-only; all test state lives in /tmp.
"""

import base64
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid

SCRIPT = Path(__file__).resolve().parents[2] / 'provisioner/remote-desktop/omarchy-native-supervisor.py'
spec = importlib.util.spec_from_file_location('guardian', SCRIPT)
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)
SUNSHINE_BINARY_SHA256 = 'd1cd30c8aa06824801b074de6aadc7ff3f75f9d63a0b69e2cddfb1a15b3f633c'


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def closed():
    for port in (47984, 47989, 47990, 48010):
        with socket.socket() as probe:
            probe.settimeout(0.2)
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                return False
    return True


def request(context, path, secret=None, body=None):
    headers = {'Content-Type': 'application/json'}
    if secret is not None:
        auth = (secret['username'] + ':' + secret['password']).encode()
        headers['Authorization'] = 'Basic ' + base64.b64encode(auth).decode()
    connection = http.client.HTTPSConnection('127.0.0.1', 47990, timeout=2, context=context)
    try:
        connection.request('GET' if body is None else 'POST', path,
                           body=None if body is None else json.dumps(body), headers=headers)
        response = connection.getresponse()
        return response.status, response.read(1024 * 1024)
    finally:
        connection.close()


def main():
    require(sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').is_file(),
            'requires_disposable_linux_container_root')
    # Docker Desktop may expose dormant kernel tunnel devices even with
    # --network none. No non-loopback device may be up, and no IPv4 route may
    # exist. This test never enables devices or configures routes.
    require(all(name == 'lo' or not int(Path('/sys/class/net', name, 'flags').read_text(), 16) & 1
                for _, name in socket.if_nameindex()), 'requires_network_none')
    require(len(Path('/proc/net/route').read_text().splitlines()) == 1, 'requires_no_external_routes')
    require(closed(), 'preexisting_listener')
    binary_sha256 = hashlib.sha256(Path('/usr/bin/sunshine').read_bytes()).hexdigest()
    require(binary_sha256 == SUNSHINE_BINARY_SHA256, 'wrong_sunshine_binary')
    version = subprocess.check_output(['/usr/bin/sunshine', '--version'], timeout=5).decode()
    require(guardian.PIN in version and '2026.516.143833' in version, 'wrong_sunshine_revision')
    identity = pwd.getpwnam('hermes')
    require(identity.pw_uid >= 100 and identity.pw_gid != 0, 'requires_unprivileged_service_identity')
    results = []
    with tempfile.TemporaryDirectory(prefix='hivra-sunshine-auth-') as temporary:
        base = Path(temporary)
        base.chmod(0o711)
        binding = {'computerId': str(uuid.uuid4()), 'operationId': str(uuid.uuid4()),
                   'vmid': 2099, 'ownerUid': identity.pw_uid,
                   'guestPrivateIpv4': '10.240.20.99', 'waylandDisplay': 'wayland-1'}
        guardian.prepare(binding, base)
        root = base / binding['computerId']
        secret = json.loads((root / 'admin-secret.json').read_bytes())
        originals = {name: (root / name).read_bytes() for name in guardian.FILES}
        home = base / 'service-home'
        home.mkdir(mode=0o700)
        os.chown(home, identity.pw_uid, identity.pw_gid)
        # Trust the generated server certificate, without weakening certificate
        # verification. It names the computer, not loopback, so hostname matching
        # is inapplicable to this contained protocol test.
        context = ssl.create_default_context(cafile=str(root / 'credentials/cert.pem'))
        context.check_hostname = False
        for launch in (1, 2):
            require(closed(), 'previous_launch_listener_remains')
            with open(base / ('process-' + str(launch) + '.log'), 'wb') as log:
                process = subprocess.Popen(['/usr/bin/sunshine', str(root / 'sunshine.conf')],
                    user=identity.pw_uid, group=identity.pw_gid, extra_groups=[],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': str(home),
                         'XDG_CONFIG_HOME': str(home), 'XDG_RUNTIME_DIR': str(home)})
                try:
                    deadline = time.monotonic() + 30
                    while True:
                        require(process.poll() is None, 'sunshine_exited_before_authentication')
                        try:
                            anonymous, _ = request(context, '/api/config')
                            break
                        except (OSError, http.client.HTTPException):
                            require(time.monotonic() < deadline, 'sunshine_startup_timeout')
                            time.sleep(0.1)
                    require(anonymous == 401, 'anonymous_configuration_not_rejected')
                    wrong, _ = request(context, '/api/config', {**secret, 'password': 'incorrect-fixture'})
                    require(wrong == 401, 'incorrect_password_not_rejected')
                    accepted, payload = request(context, '/api/config', secret)
                    require(accepted == 200, 'prepared_credentials_not_accepted')
                    require(json.loads(payload).get('version') == '2026.516.143833', 'wrong_api_version')
                    reset, _ = request(context, '/api/password', body={
                        'newUsername': 'untrusted-fixture', 'newPassword': 'untrusted-fixture',
                        'confirmNewPassword': 'untrusted-fixture'})
                    require(reset == 401, 'unauthenticated_password_bootstrap_open')
                    clients_status, clients = request(context, '/api/clients/list', secret)
                    require(clients_status == 200 and json.loads(clients).get('named_certs') == [],
                            'unexpected_pairing_state')
                    require(all((root / name).read_bytes() == data for name, data in originals.items()),
                            'prepared_resources_changed')
                    results.append({'launch': launch, 'anonymous': anonymous, 'wrongPassword': wrong,
                                    'preparedCredentials': accepted, 'unauthenticatedReset': reset,
                                    'pairedClients': 0, 'preparedResourcesUnchanged': True})
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                    require(closed(), 'owned_listener_cleanup_failed')
    print(json.dumps({'sunshineSource': guardian.PIN, 'binarySha256': binary_sha256, 'results': results,
        'temporaryStateRemoved': not base.exists(), 'tcpListenersClosed': closed(),
        'desktopOrGuardianAcceptance': False}, sort_keys=True))


if __name__ == '__main__':
    main()
