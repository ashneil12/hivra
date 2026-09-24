#!/usr/bin/env python3
"""Consume one bounded attached-agent bundle from the VMID-scoped channel.

The attach worker sends it through `qm guest exec` with this runner as the
program and the bundle on stdin. It carries the pinned lifecycle program and
the three pinned helpers and one packet. Every source is checked against its
reviewed digest before anything runs. No caller command, URL, destination or
extra asset. Activate, access and remove are dispatched at most once by the
database; observe is read-only.
"""
import base64
import hashlib
import json
import os
import platform
import sys

PINS = {
    'agent': 'ea761a6df567b033b7ae83158d845777f024c0b7a27843f311db71bebeb54551',
    'workspace': '4f74a959fea741862fa0525693c0e1965f612fbd7fb2e574af5ee0e0b90576ea',
    'network': '0cc2470b6135da76894d035637d0bee314935fe4901467b241a800db41810219',
    'relay': '5fd6b334ffe66d9ecdaed1011f9f9f659cf6be1498a8c36b66b5723ff67d5bdf',
}
MAX_BUNDLE_BYTES = 512 * 1024
ACTIONS = ('activate', 'observe', 'access', 'remove', 'state')


def decode_bundle(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BUNDLE_BYTES:
        raise ValueError('oversized attached agent bundle')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'version', 'packet', 'assets'}
            or type(value['version']) is not int or value['version'] != 1
            or not isinstance(value['packet'], dict) or value['packet'].get('action') not in ACTIONS
            or not isinstance(value['assets'], dict) or set(value['assets']) != set(PINS)):
        raise ValueError('invalid attached agent bundle')
    sources = {}
    for name, digest in PINS.items():
        encoded = value['assets'][name]
        if not isinstance(encoded, str):
            raise ValueError('invalid attached agent asset')
        source = base64.b64decode(encoded, validate=True)
        if hashlib.sha256(source).hexdigest() != digest:
            raise ValueError('unreviewed attached agent asset')
        sources[name] = source
    return value['packet'], sources


def execute_bundle(raw):
    packet, sources = decode_bundle(raw)  # Verify every asset before loading any.
    if os.geteuid() != 0 or platform.system() != 'Linux':
        raise ValueError('requires the bound Linux guest')
    namespace = {'__name__': 'hivra_attached_agent'}
    exec(compile(sources['agent'], '<pinned-attached-agent>', 'exec'), namespace)
    helpers = {name: sources[name] for name in ('workspace', 'network', 'relay')}
    return namespace['main'](packet, helpers)


if __name__ == '__main__':
    try:
        print('HIVRA_ATTACHED_AGENT_V1 ' + json.dumps(execute_bundle(sys.stdin.buffer.read(MAX_BUNDLE_BYTES + 1)),
                                                    separators=(',', ':'), sort_keys=True))
    except Exception as error:
        # Name the refusal only; never echo paths or bytes an agent could plant.
        code = str(error) if str(error) in ('computer_update_required', 'workspace_path_not_plain', 'detach_mount_found') \
            else type(error).__name__
        raise SystemExit('Attached agent step refused (' + code + '); retain the operation for reconciliation.')
