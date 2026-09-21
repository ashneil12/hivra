"""Sealed installer-derived policy against the pinned Selkies method contract."""
import ast
import asyncio
import json
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[2] / 'provisioner/remote-desktop/install-omarchy-web.py'
TREE = ast.parse(SOURCE.read_text())
DERIVED = {n.targets[0].id: ast.literal_eval(n.value) for n in TREE.body
           if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
           and n.targets[0].id in ('LAYOUT_SERVICE', 'LAYOUT_ADAPTER', 'LAYOUT_BOOT')}


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.service = {'__name__': 'fixture'}
        exec(DERIVED['LAYOUT_SERVICE'], self.service)

    def test_rejects_untrusted_shape_density_and_dimensions(self):
        for payload in [{}, {'width': 1920, 'height': 1080, 'scale': 1, 'command': 'x'},
                        *[{'width': w, 'height': 1080, 'scale': 1} for w in ['1920', True, 319, 4081, float('nan')]],
                        *[{'width': 1920, 'height': 1080, 'scale': s} for s in [True, '1', 2, float('inf')]],
                        {'width': 4080, 'height': 4080, 'scale': 1}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.service['validate'](payload)

    def test_fixed_argv_and_actual_geometry_confirmation(self):
        old = dict(name='Virtual-1', width=4080, height=2008, scale=2, disabled=False,
                   mirrorOf='none', transform=0, physicalWidth=310, physicalHeight=180)
        new = dict(old, width=1920, height=1080, scale=1)
        command = Mock(side_effect=[[old], [new]])
        self.service['command'] = command
        with patch('subprocess.check_output', return_value=b'ok\n') as execute:
            self.assertTrue(self.service['apply']({'width': 1920, 'height': 1080, 'scale': 1}, 'fixed-instance'))
            self.assertEqual(execute.call_args.args[0], ['/usr/bin/hyprctl', '--instance', 'fixed-instance',
                                                       'eval', 'hl.monitor({output="Virtual-1",mode="1920x1080@60",position="0x0",scale=1})'])
            self.assertNotIn('shell', execute.call_args.kwargs)

    def test_rejects_legacy_parser_error_and_unrealized_geometry(self):
        old = dict(name='Virtual-1', width=4080, height=2008, scale=2, disabled=False,
                   mirrorOf='none', transform=0, physicalWidth=310, physicalHeight=180)
        payload = {'width': 1920, 'height': 1080, 'scale': 1}
        self.service['command'] = Mock(return_value=[old])
        with patch('subprocess.check_output', return_value=b"keyword can't work with non-legacy parsers. Use eval.\n"):
            with self.assertRaisesRegex(ValueError, 'layout_refused'):
                self.service['apply'](payload, 'fixed')
        with patch('subprocess.check_output', return_value=b'ok\n'):
            with self.assertRaisesRegex(ValueError, 'layout_unrealized'):
                self.service['apply'](payload, 'fixed')

    def test_no_geometry_means_no_mode_mutation(self):
        monitor = dict(name='Virtual-1', disabled=False, mirrorOf='none', transform=0,
                       physicalWidth=310, physicalHeight=180)
        self.service['command'] = Mock(return_value=[monitor])
        with patch('subprocess.check_output') as execute:
            self.assertTrue(self.service['apply']({'width': None, 'height': None, 'scale': 1}, 'fixed'))
            execute.assert_not_called()

    def test_fixed_frame_policy_is_verified_and_restored_on_shutdown(self):
        self.service['command'] = Mock(return_value={'bool': False})
        with patch('subprocess.check_output', return_value=b'ok\n') as execute:
            self.service['set_frame_policy']('fixed', False)
            self.assertEqual(execute.call_args.args[0], ['/usr/bin/hyprctl', '--instance', 'fixed', '-r',
                                                       'eval', 'hl.config({debug={vfr=false}})'])
        self.service['command'] = Mock(return_value={'bool': True})
        with patch('subprocess.check_output', return_value=b'ok\n'):
            with self.assertRaisesRegex(ValueError, 'layout_frame_policy_unverified'):
                self.service['set_frame_policy']('fixed', False)
        self.service['set_frame_policy'] = Mock()
        self.service['serve'] = Mock(side_effect=SystemExit(0))
        with patch('sys.argv', ['service', 'wayland-1', '/private/socket']), \
             patch('signal.signal'), \
             patch('subprocess.check_output', return_value=b'[{"wl_socket":"wayland-1","instance":"fixed"}]'):
            with self.assertRaises(SystemExit): self.service['main']()
        self.assertEqual(self.service['set_frame_policy'].call_args_list, [unittest.mock.call('fixed', False),
                                                                          unittest.mock.call('fixed', True)])

    def test_adapter_avoids_unsupported_geometry_and_orders_host_before_capture(self):
        class Input:
            def _size_session_screen(self, display, index, scale, size):
                raise AssertionError('unsupported pixelflux geometry')
        order = []
        class Server:
            async def set_native_cursor_rendering(self, enabled):
                raise AssertionError('unexpected cursor control')
            def _parse_settings_payload(self, payload):
                return json.loads(payload)
            display_clients = {'primary': {'width': 1920, 'height': 1080}}
            capture_instances = {'primary': {'module': types.SimpleNamespace(get_realized_geometry=lambda output: (1920, 1080, 1))}}
            def _wayland_control_module(self):
                return None
            async def _size_wayland_screen(self, width, height, grow_only=False):
                order.append(('capture', width, height, grow_only))
            async def _sync_wayland_realized_geometry(self, display_id, broadcast=True):
                order.append(('publish', display_id, broadcast))
        modules = {'selkies.input_handler': types.SimpleNamespace(WebRTCInput=Input),
                   'selkies.websockets_mode': types.SimpleNamespace(DataStreamingServer=Server),
                   'selkies.display_utils': types.SimpleNamespace(wayland_output_id=lambda display: 1)}
        adapter = {}
        with patch.dict('sys.modules', modules):
            exec(DERIVED['LAYOUT_ADAPTER'], adapter)
        adapter['apply_layout'] = lambda w=None, h=None: order.append(('host', w, h)) or True
        self.assertTrue(Input()._size_session_screen('attested-display', 0, 1, None))
        with self.assertRaises(RuntimeError): Input()._size_session_screen('display', 1, 1, None)
        server = Server()
        asyncio.run(server._size_wayland_screen(1928, 1080, grow_only=True))
        asyncio.run(server._sync_wayland_realized_geometry('primary'))
        self.assertEqual(order, [('host', None, None), ('host', 1920, 1080), ('capture', 1928, 1080, True),
                                 ('host', 1920, 1080), ('publish', 'primary', True)])
        order.clear()
        # A stopped persistent capture still owns the native output manager.
        server._wayland_control_module = lambda: types.SimpleNamespace(is_capturing=False)
        asyncio.run(server._size_wayland_screen(1928, 1080, grow_only=True))
        self.assertEqual(order, [('capture', 1928, 1080, True)])
        asyncio.run(server._sync_wayland_realized_geometry('primary'))
        self.assertEqual(order, [('capture', 1928, 1080, True), ('host', 1920, 1080), ('publish', 'primary', True)])
        # Failed post-capture proof must not publish an unsupported geometry.
        asyncio.run(server._size_wayland_screen(1928, 1080))
        adapter['apply_layout'] = Mock(side_effect=RuntimeError('omarchy_layout_refused'))
        order.clear()
        with self.assertRaises(RuntimeError): asyncio.run(server._sync_wayland_realized_geometry('primary'))
        self.assertEqual(order, [])
        adapter['apply_layout'] = Mock(return_value=True)
        server.capture_instances = {'primary': {'module': types.SimpleNamespace(get_realized_geometry=lambda output: (4080, 2008, 1))}}
        with self.assertRaisesRegex(RuntimeError, 'omarchy_capture_geometry_unverified'):
            asyncio.run(server._sync_wayland_realized_geometry('primary'))
        adapter['apply_layout'].assert_not_called()
        self.assertEqual(order, [('publish', 'primary', False)])
        self.assertIsNone(server._hivra_requested_layout)
        with patch.dict('os.environ', {'SELKIES_USE_CSS_SCALING': 'true|locked'}):
            for w, h in [(1976, 1048), (2636, 1398)]:
                raw = dict(useCssScaling=False, manual_resolution=False, displayId='primary',
                           displayScale=2, initialClientWidth=w*2, initialClientHeight=h*2)
                parsed = server._parse_settings_payload(json.dumps(raw))
                self.assertEqual((parsed['initialClientWidth'], parsed['initialClientHeight'], parsed['displayScale']), (w, h, 1))
                raw['manual_resolution'] = True
                self.assertEqual(server._parse_settings_payload(json.dumps(raw)), raw)
            raw['manual_resolution'] = False
            for scale in [None, '2', True, float('inf'), 0, 5]:
                raw['displayScale'] = scale
                with self.assertRaisesRegex(RuntimeError, 'omarchy_initial_density_invalid'):
                    server._parse_settings_payload(json.dumps(raw))

    def test_native_cursor_control_keeps_video_cursor_free_and_preserves_input(self):
        class Input:
            def _size_session_screen(self, display, index, scale, size):
                pass
            def send_key(self, key):
                self.on_key(key)
            def send_cursor(self, metadata):
                self.on_cursor(metadata)
        class Server:
            def __init__(self):
                self.capture_cursor = False
                self.reconfigure_displays = Mock()
                self.input_handler = Input()
                self.input_handler.on_mouse_pointer_visible = self.set_native_cursor_rendering
                self.input_handler.on_key = Mock()
                self.input_handler.on_cursor = Mock()
            async def set_native_cursor_rendering(self, enabled: bool) -> None:
                # Installed pinned Selkies contract: unchanged values are no-op;
                # changed values rebuild live display captures.
                if self.capture_cursor == enabled:
                    return
                self.capture_cursor = enabled
                self.reconfigure_displays()
            def _parse_settings_payload(self, payload):
                return json.loads(payload)
            async def _size_wayland_screen(self, width, height):
                pass
            async def _sync_wayland_realized_geometry(self, display_id, broadcast=True):
                pass
        original_key = Input.send_key
        original_cursor = Input.send_cursor
        modules = {'selkies.input_handler': types.SimpleNamespace(WebRTCInput=Input),
                   'selkies.websockets_mode': types.SimpleNamespace(DataStreamingServer=Server),
                   'selkies.display_utils': types.SimpleNamespace(wayland_output_id=lambda display: 1)}
        with patch.dict('sys.modules', modules):
            exec(DERIVED['LAYOUT_ADAPTER'], {})
        server = Server()
        # Both direct websocket control and the shared pointer callback keep
        # capture cursor-free while leaving cursor metadata and input intact.
        for control in (server.set_native_cursor_rendering, server.input_handler.on_mouse_pointer_visible):
            asyncio.run(control(True))
            self.assertFalse(server.capture_cursor)
            server.reconfigure_displays.assert_not_called()
        # Disable a previously enabled capture through upstream reconfiguration.
        server.capture_cursor = True
        asyncio.run(server.input_handler.on_mouse_pointer_visible(True))
        self.assertFalse(server.capture_cursor)
        server.reconfigure_displays.assert_called_once_with()
        asyncio.run(server.set_native_cursor_rendering(False))
        server.reconfigure_displays.assert_called_once_with()
        self.assertIs(Input.send_key, original_key)
        self.assertIs(Input.send_cursor, original_cursor)
        server.input_handler.send_key('KEY_A')
        server.input_handler.on_key.assert_called_once_with('KEY_A')
        metadata = {'hotspot': [4, 2], 'image': 'cursor-fixture'}
        server.input_handler.send_cursor(metadata)
        server.input_handler.on_cursor.assert_called_once_with(metadata)

    def test_boot_is_scoped_and_fail_closed(self):
        for name in ('probe.py', '-c'):
            with patch('sys.argv', [name]): exec(DERIVED['LAYOUT_BOOT'], {})
        with patch('sys.argv', ['/usr/local/bin/selkies']), patch.dict('sys.modules', {'hivra_layout_policy': None}):
            with self.assertRaises(SystemExit): exec(DERIVED['LAYOUT_BOOT'], {})

    def test_installation_seals_policy_and_private_owner_bridge(self):
        source = SOURCE.read_text()
        for contract in ('SELKIES_USE_CSS_SCALING=true|locked', 'SELKIES_SCALING_DPI=96',
                         'socket.SO_PEERCRED', 'uid != os.getuid()', 'os.chmod(path, 0o600)',
                         'os.chmod(layout_runtime, 0o700)', 'dst=/opt/hivra-layout,readonly',
                         'dst=/opt/hivra-python-policy,readonly', 'User={owner.pw_uid}',
                         'ProtectSystem=strict', 'NoNewPrivileges=true'):
            self.assertIn(contract, source)
        # ProtectHome=true hides /run/user, breaking exact Hyprland discovery.
        self.assertIn('ProtectHome=read-only', source)
        self.assertNotIn('ProtectHome=true', source)


if __name__ == '__main__': unittest.main()
