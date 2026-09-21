import ast
import importlib.util
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'provisioner/remote-desktop/install-omarchy-web.py'
spec = importlib.util.spec_from_file_location('installer', SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ImagePreparationTests(unittest.TestCase):
    def generated_units(self):
        # Evaluate the actual installer expressions, never a copied unit fixture.
        names = {'layout_unit', 'selkies_unit', 'broker_unit'}
        assignments = [node for node in ast.walk(ast.parse(SCRIPT.read_text()))
                       if isinstance(node, ast.Assign) and any(
                           isinstance(target, ast.Name) and target.id in names
                           for target in node.targets)]
        scope = dict(vars(installer), owner=SimpleNamespace(pw_uid=1000, pw_gid=1000),
                     runtime='/run/user/1000', socket_path=Path('/run/user/1000/wayland-1'),
                     layout_runtime=Path('/run/hivra-layout'), adapter_root=Path('/opt/hivra-python-policy'),
                     request={'waylandDisplay': 'wayland-1', 'guestPrivateIpv4': '10.240.20.99'})
        exec(compile(ast.Module(body=assignments, type_ignores=[]), str(SCRIPT), 'exec'), scope)
        return {'hivra-omarchy-layout.service': scope['layout_unit'],
                'hivra-omarchy-web.service': scope['selkies_unit'],
                'hivra-omarchy-web-broker.service': scope['broker_unit']}

    def test_generated_boot_units_have_no_target_ordering_cycle(self):
        units = self.generated_units()
        for unit in units.values():
            self.assertIn('WantedBy=multi-user.target\n', unit)
            self.assertNotIn('graphical.target', unit)
        self.assertIn('After=docker.service hivra-omarchy-layout.service\n', units['hivra-omarchy-web.service'])
        self.assertIn('Requires=docker.service hivra-omarchy-layout.service\n', units['hivra-omarchy-web.service'])
        self.assertIn('After=docker.service hivra-omarchy-web.service\n', units['hivra-omarchy-web-broker.service'])
        self.assertIn('Restart=on-failure\nRestartSec=2\n', units['hivra-omarchy-layout.service'])

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze is unavailable')
    def test_systemd_verifies_generated_boot_graph(self):
        with tempfile.TemporaryDirectory(prefix='hivra-web-unit-') as temporary:
            root = Path(temporary)
            units = self.generated_units()
            units['docker.service'] = '[Service]\nExecStart=/bin/true\n'
            units['multi-user.target'] = '[Unit]\nWants=' + ' '.join(self.generated_units()) + '\n'
            units['graphical.target'] = '[Unit]\nRequires=multi-user.target\nAfter=multi-user.target\n'
            for name, unit in units.items():
                (root / name).write_text(unit)
            result = subprocess.run(['systemd-analyze', 'verify', '--recursive-errors=yes',
                                     *[str(root / name) for name in units]], capture_output=True, text=True,
                                    env={**os.environ, 'SYSTEMD_UNIT_PATH': str(root) + ':'})
            self.assertEqual(result.returncode, 0, result.stderr)
            layout = root / 'hivra-omarchy-layout.service'
            layout.write_text(units[layout.name].replace('[Unit]\n', '[Unit]\nAfter=graphical.target\n'))
            broken = subprocess.run(['systemd-analyze', 'verify', '--recursive-errors=yes',
                                     *[str(root / name) for name in units]], capture_output=True, text=True,
                                    env={**os.environ, 'SYSTEMD_UNIT_PATH': str(root) + ':'})
            self.assertNotEqual(broken.returncode, 0)
            self.assertIn('ordering cycle', broken.stderr.lower())

    def test_stream_defaults_capture_guest_cursor_without_stale_frame_backlog(self):
        source = SCRIPT.read_text()
        self.assertIn('SELKIES_ENABLE_CURSORS=true', source)
        self.assertIn('SELKIES_BACKPRESSURE_QUEUE_SIZE=4', source)

    def test_uses_verified_local_pinned_image_when_registry_digest_is_gone(self):
        image = 'ghcr.io/example/selkies@sha256:' + 'a' * 64
        result = subprocess.CompletedProcess([], 0, stdout=('sha256:' + 'a' * 64 + '\n').encode())
        with patch.object(installer.subprocess, 'run', return_value=result) as run:
            installer.ensure_image(image)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][1:3], ['image', 'inspect'])

    def test_pulls_when_pinned_image_is_not_local(self):
        image = 'node@sha256:' + 'b' * 64
        missing = subprocess.CompletedProcess([], 1, stdout=b'')
        with patch.object(installer.subprocess, 'run', side_effect=[missing, None]) as run:
            installer.ensure_image(image)
        self.assertEqual(run.call_args_list[1].args[0], ['/usr/bin/docker', 'pull', image])


if __name__ == '__main__':
    unittest.main()
