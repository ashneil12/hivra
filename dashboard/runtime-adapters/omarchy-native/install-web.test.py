import ast
import importlib.util
import json
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

    def test_stream_defaults_keep_cursor_local_without_stale_frame_backlog(self):
        source = SCRIPT.read_text()
        self.assertIn('SELKIES_ENABLE_CURSORS=true', source)
        self.assertIn('SELKIES_BACKPRESSURE_QUEUE_SIZE=4', source)

    def test_uses_verified_local_config_digest_when_registry_digest_is_gone(self):
        image = 'ghcr.io/example/selkies@sha256:' + 'a' * 64
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps({
            'id': 'sha256:' + 'a' * 64, 'repoDigests': [],
        }).encode())
        with patch.object(installer.subprocess, 'run', return_value=result) as run:
            installer.ensure_image(image)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][1:3], ['image', 'inspect'])

    def test_uses_verified_local_repository_manifest_digest(self):
        image = 'ghcr.io/example/selkies@sha256:' + 'a' * 64
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps({
            'id': 'sha256:' + 'b' * 64,
            'repoDigests': ['ghcr.io/example/selkies@sha256:' + 'a' * 64],
        }).encode())
        with patch.object(installer.subprocess, 'run', return_value=result) as run:
            installer.ensure_image(image)
        run.assert_called_once()

    def test_pulls_when_pinned_image_is_not_local(self):
        image = 'node@sha256:' + 'b' * 64
        missing = subprocess.CompletedProcess([], 1, stdout=b'')
        with patch.object(installer.subprocess, 'run', side_effect=[missing, None]) as run:
            installer.ensure_image(image)
        self.assertEqual(run.call_args_list[1].args[0], ['/usr/bin/docker', 'pull', image])

    def test_pins_selkies_release_with_host_wayland_cursor_delivery(self):
        source = SCRIPT.read_text()
        self.assertIn('selkies/desktop@sha256:0bfcce1fa30024a8eb34e2504a74e1fb18f4c1424d92c1b6ad6282fb3b1ae87b', source)
        self.assertIn('from selkies.websockets_mode import DataStreamingServer', source)
        self.assertIn('from selkies.display_utils import wayland_output_id', source)


class SupersededImageTests(unittest.TestCase):
    # On the Canary Omarchy computer (2026-10-20) an image from an earlier pin
    # (7.9 GB) was never removed, and with it the owner's disk sat below the
    # 10 GiB Omarchy's updater requires, so Update > Omarchy refused to run.
    PINNED = 'sha256:' + 'a' * 64
    OLD = 'sha256:' + 'b' * 64

    def fake_docker(self, listed, rm_ok=True):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if argv[1:3] == ['image', 'inspect']:
                return SimpleNamespace(returncode=0, stdout=(self.PINNED + '\n').encode())
            if argv[1:3] == ['image', 'ls']:
                return SimpleNamespace(returncode=0, stdout=('\n'.join(listed) + '\n').encode())
            if argv[1:3] == ['image', 'rm']:
                return SimpleNamespace(returncode=0 if rm_ok else 1, stdout=b'')
            raise AssertionError(argv)
        return run, calls

    def test_removes_only_superseded_streamer_images_without_force(self):
        run, calls = self.fake_docker([self.PINNED, self.OLD, self.OLD])
        with patch.object(installer.subprocess, 'run', side_effect=run):
            removed = installer.prune_superseded_streamer_images()
        self.assertEqual(removed, [self.OLD])
        listed = [argv for argv in calls if argv[1:3] == ['image', 'ls']][0]
        self.assertEqual(listed[-1], 'ghcr.io/selkies-project/selkies/desktop')
        removals = [argv for argv in calls if argv[1:3] == ['image', 'rm']]
        self.assertEqual(removals, [['/usr/bin/docker', 'image', 'rm', self.OLD]])
        self.assertTrue(all('-f' not in argv and '--force' not in argv for argv in calls))

    def test_keeps_an_image_a_container_still_uses(self):
        run, _ = self.fake_docker([self.PINNED, self.OLD], rm_ok=False)
        with patch.object(installer.subprocess, 'run', side_effect=run):
            self.assertEqual(installer.prune_superseded_streamer_images(), [])

    def test_does_nothing_without_the_pinned_image(self):
        def run(argv, **kwargs):
            return SimpleNamespace(returncode=1, stdout=b'')
        with patch.object(installer.subprocess, 'run', side_effect=run) as mocked:
            self.assertEqual(installer.prune_superseded_streamer_images(), [])
        self.assertEqual(mocked.call_count, 1)

    def test_prunes_only_after_the_stream_serves(self):
        source = SCRIPT.read_text()
        self.assertLess(source.index('raise RuntimeError("broker_unready")'),
                        source.index('    prune_superseded_streamer_images()'))


if __name__ == '__main__':
    unittest.main()
