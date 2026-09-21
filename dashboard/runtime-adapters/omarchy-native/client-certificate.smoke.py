"""Actual Sunshine client trust semantics; isolated disposable Linux only.

This intentionally demonstrates an unsafe CA pairing as a negative control,
then checks the guardian's non-CA certificate prerequisite. It does not implement
session grants, pairing exchange, guardian supervision or native desktop access.
"""

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
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('admin_smoke', Path(__file__).with_name('admin-auth.smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
guardian = smoke.guardian


def run(args):
    subprocess.run(['/usr/bin/openssl', *args], check=True, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)


def make_clients(base):
    for name, constraint in [('A', 'TRUE'), ('B', 'FALSE'), ('C', None), ('D', 'legacy-v1'), ('E', 'legacy-netscape')]:
        args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
                '-config', '/dev/null', '-subj', '/CN=' + name,
                '-keyout', str(base / (name + '.key')), '-out', str(base / (name + '.pem'))]
        if constraint == 'legacy-v1':
            args += ['-x509v1']
        elif constraint == 'legacy-netscape':
            args += ['-addext', 'nsCertType=sslCA']
        elif constraint:
            args += ['-addext', 'basicConstraints=critical,CA:' + constraint]
        run(args)
        delegated = name + '-child'
        run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + delegated,
             '-keyout', str(base / (delegated + '.key')), '-out', str(base / (delegated + '.csr'))])
        run(['x509', '-req', '-in', str(base / (delegated + '.csr')), '-CA', str(base / (name + '.pem')),
             '-CAkey', str(base / (name + '.key')), '-set_serial', '2', '-days', '1',
             '-out', str(base / (delegated + '.pem'))])


def client_status(base, root, name):
    context = ssl.create_default_context(cafile=str(root / 'credentials/cert.pem'))
    context.check_hostname = False
    context.load_cert_chain(str(base / (name + '.pem')), str(base / (name + '.key')))
    connection = http.client.HTTPSConnection('127.0.0.1', 47984, timeout=3, context=context)
    try:
        connection.request('GET', '/applist')
        response = connection.getresponse()
        # Sunshine returns HTTP200 for protocol-level authentication rejection.
        # Check its XML status, not HTTP success alone.
        return {'http': response.status,
                'protocol': ET.fromstring(response.read(1024 * 1024)).attrib.get('status_code')}
    finally:
        connection.close()


def main():
    smoke.require(Path('/.dockerenv').is_file() and os.geteuid() == 0, 'requires_disposable_container')
    smoke.require(all(name == 'lo' or not int(Path('/sys/class/net', name, 'flags').read_text(), 16) & 1
                      for _, name in socket.if_nameindex()), 'requires_network_none')
    smoke.require(len(Path('/proc/net/route').read_text().splitlines()) == 1, 'requires_no_routes')
    smoke.require(hashlib.sha256(Path('/usr/bin/sunshine').read_bytes()).hexdigest()
                  == smoke.SUNSHINE_BINARY_SHA256, 'wrong_sunshine_binary')
    smoke.require(smoke.closed(), 'preexisting_listener')
    results = []
    with tempfile.TemporaryDirectory(prefix='hivra-client-trust-') as temporary:
        base = Path(temporary)
        base.chmod(0o711)
        make_clients(base)
        identity = pwd.getpwnam('hermes')
        binding = {'computerId': str(uuid.uuid4()), 'operationId': str(uuid.uuid4()),
                   'vmid': 2099, 'ownerUid': identity.pw_uid,
                   'guestPrivateIpv4': '10.240.20.99', 'waylandDisplay': 'wayland-1'}
        guardian.prepare(binding, base)
        root = base / binding['computerId']
        originals = {name: (root / name).read_bytes() for name in guardian.FILES}
        secret = json.loads((root / 'admin-secret.json').read_bytes())
        home = base / 'service-home'
        home.mkdir(mode=0o700)
        os.chown(home, identity.pw_uid, identity.pw_gid)
        admin_context = ssl.create_default_context(cafile=str(root / 'credentials/cert.pem'))
        admin_context.check_hostname = False
        for paired in ['A', 'B', 'C', 'D', 'E']:
            pem = (base / (paired + '.pem')).read_text()
            digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
            if paired != 'B':
                try:
                    guardian.client_certificate(pem, digest)
                except guardian.ownership.Refused as error:
                    expected = 'client_certificate_can_sign' if paired == 'A' else 'client_certificate_non_ca_required'
                    smoke.require(str(error) == expected, 'wrong_ca_refusal')
                else:
                    raise RuntimeError('unsupported_certificate_admitted')
            else:
                smoke.require(guardian.client_certificate(pem, digest) == pem, 'non_ca_not_accepted')
            # Test-owned state only. Unsupported certificates are deliberately
            # loaded despite policy rejection to establish their semantics.
            state = root / 'state/sunshine_state.json'
            state.write_text(json.dumps({'root': {'uniqueid': binding['computerId'], 'named_devices': [
                {'name': paired, 'uuid': str(uuid.uuid4()), 'cert': pem, 'enabled': True}]}}))
            state.chmod(0o600)
            os.chown(state, identity.pw_uid, identity.pw_gid)
            smoke.require(smoke.closed(), 'previous_launch_listener_remains')
            with open(base / ('sunshine-' + paired + '.log'), 'wb') as log:
                process = subprocess.Popen(['/usr/bin/sunshine', str(root / 'sunshine.conf')],
                    user=identity.pw_uid, group=identity.pw_gid, extra_groups=[], start_new_session=True,
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': str(home),
                         'XDG_CONFIG_HOME': str(home), 'XDG_RUNTIME_DIR': str(home)})
                try:
                    deadline = time.monotonic() + 30
                    while True:
                        smoke.require(process.poll() is None, 'sunshine_exited')
                        smoke.require(time.monotonic() < deadline, 'startup_timeout')
                        try:
                            if smoke.request(admin_context, '/api/config', secret)[0] == 200:
                                break
                        except (OSError, http.client.HTTPException):
                            pass
                        time.sleep(0.1)
                    statuses = {name: client_status(base, root, name)
                                for name in ['A', 'A-child', 'B', 'B-child', 'C', 'C-child',
                                             'D', 'D-child', 'E', 'E-child']}
                    accepted = {paired, paired + '-child'} if paired in ('A', 'D', 'E') else {paired}
                    for name, status in statuses.items():
                        smoke.require(status == {'http': 200, 'protocol': '200' if name in accepted else '401'},
                                      'unexpected_client_trust_' + paired + '_' + name)
                    smoke.require(all((root / name).read_bytes() == data for name, data in originals.items()),
                                  'prepared_resources_changed')
                    results.append({'paired': paired, 'guardianPolicy': 'accepted' if paired == 'B' else 'rejected',
                                    'statuses': statuses})
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                    smoke.require(smoke.closed(), 'owned_listener_cleanup_failed')
    print(json.dumps({'sunshineSource': guardian.PIN, 'results': results,
                      'temporaryStateRemoved': not base.exists(), 'tcpListenersClosed': smoke.closed(),
                      'desktopOrGuardianAcceptance': False}, sort_keys=True))


if __name__ == '__main__':
    main()
