"""Native probe envelope/control tests; actual socket tests are in Linux fixture."""
import base64
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'provisioner'
SPEC = importlib.util.spec_from_file_location('probe', ROOT / 'probe-attached-codex-native.py')
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


class ProbeTests(unittest.TestCase):
    def packet(self):
        return {'version': 1, 'packet': {}, 'observer': base64.b64encode(
            (ROOT / 'observe-attached-codex-activation.py').read_bytes()).decode(),
            'protocol': base64.b64encode((ROOT / 'attached-codex-protocol.py').read_bytes()).decode()}
    def test_pins_match_exact_sources(self):
        for name in ('observer', 'protocol'):
            self.assertIn('__name__', P.load(name, self.packet()[name]))
            with self.assertRaises(ValueError):
                P.load(name, base64.b64encode(b'changed').decode())
    def test_invalid_envelopes_refuse_before_loading(self):
        with patch.object(P, 'load', side_effect=AssertionError('no loading')):
            for raw in (b'x' * 262145, b'[]', b'{"version":1,"version":1}',
                        json.dumps(dict(self.packet(), version=True)).encode(),
                        json.dumps(dict(self.packet(), extra=1)).encode()):
                with self.assertRaises(ValueError):
                    P.probe(raw)
    def test_no_callback_or_inactive_never_reports_protocol(self):
        for state in ('process_running', 'service_inactive', 'activation_unresolved'):
            def observe(raw, callback):
                return {'state': state}
            with patch.object(P, 'load', return_value={'observe': observe}), self.assertRaises(ValueError):
                P.probe(json.dumps(self.packet()).encode())
    def test_callback_and_final_observation_required(self):
        observation = {'state': 'process_running', 'operationId': 'owned-operation'}
        def observe(raw, callback):
            callback('verifier', 'request', 'service', 1234)
            return observation
        with patch.object(P, 'load', return_value={'observe': observe}), patch.object(P, 'check_native') as check:
            self.assertEqual(P.probe(json.dumps(self.packet()).encode()),
                             dict(observation, state='native_protocol_available'))
            self.assertEqual(check.call_count, 1)
        def changed(raw, callback):
            callback('verifier', 'request', 'service', 1234)
            raise ValueError('activation changed after protocol')
        with patch.object(P, 'load', return_value={'observe': changed}), patch.object(P, 'check_native'), self.assertRaises(ValueError):
            P.probe(json.dumps(self.packet()).encode())
    def test_native_handles_survive_final_activation_validation(self):
        state = {'held': False, 'changed': False}
        @contextmanager
        def native(*args):
            state['held'] = True
            yield
            if state['changed']:
                raise ValueError('socket changed during final activation validation')
        def observe(raw, callback):
            callback('verifier', 'request', 'service', 1234)
            self.assertTrue(state['held'])
            state['changed'] = True
            return {'state': 'process_running'}
        with patch.object(P, 'load', return_value={'observe': observe}), patch.object(P, 'check_native', side_effect=native), self.assertRaises(ValueError):
            P.probe(json.dumps(self.packet()).encode())


if __name__ == '__main__':
    unittest.main()
