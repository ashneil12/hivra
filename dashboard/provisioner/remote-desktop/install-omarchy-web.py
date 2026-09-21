#!/usr/bin/env python3
"""Install Hivra's browser stream beside an existing Omarchy Hyprland session."""

import base64
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time

SELKIES_IMAGE = "ghcr.io/selkies-project/selkies/desktop@sha256:0bfcce1fa30024a8eb34e2504a74e1fb18f4c1424d92c1b6ad6282fb3b1ae87b"
NODE_IMAGE = "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
ROOT = Path("/opt/hivra/omarchy-web")
STATE = ROOT / "state"
SOURCE = Path("/usr/local/libexec/hivra")
NETWORK = "hivra-omarchy-web"
SELKIES = "hivra-omarchy-web"
BROKER = "hivra-omarchy-web-broker"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.I)

# Derived, sealed runtime files: the installed source receipt pins this installer.
LAYOUT_SERVICE = r'''import json, os, re, signal, socket, stat, struct, subprocess, sys
from pathlib import Path

def command(signature, *args):
    return json.loads(subprocess.check_output(['/usr/bin/hyprctl', '--instance', signature, '-j', *args], timeout=2))

def validate(payload):
    if type(payload) is not dict or set(payload) != {'width', 'height', 'scale'}:
        raise ValueError('layout_shape')
    w, h, scale = payload['width'], payload['height'], payload['scale']
    if scale != 1 or type(scale) not in (int, float):
        raise ValueError('layout_density')
    if w is None and h is None:
        return None
    if type(w) is not int or type(h) is not int or not 320 <= w <= 4080 or not 240 <= h <= 4080 or w*h > 9_000_000:
        raise ValueError('layout_dimensions')
    return w, h

def apply(payload, signature):
    dimensions = validate(payload)
    monitors = command(signature, 'monitors')
    if len(monitors) != 1 or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', monitors[0]['name']):
        raise ValueError('layout_monitor')
    monitor = monitors[0]
    if monitor.get('disabled') is not False or monitor.get('mirrorOf') != 'none' or monitor.get('transform') != 0 or monitor.get('physicalWidth', 0) <= 0 or monitor.get('physicalHeight', 0) <= 0:
        raise ValueError('layout_monitor_ambiguous')
    if dimensions and (monitor['width'], monitor['height'], monitor['scale']) != (*dimensions, 1):
        w, h = dimensions
        # Current Omarchy uses Hyprland's Lua parser: keyword is legacy-only.
        # Never accept Lua from the client; these are fixed syntax, a sealed
        # monitor token, and validated integer dimensions.
        expression = f'hl.monitor({{output="{monitor["name"]}",mode="{w}x{h}@60",position="0x0",scale=1}})'
        result = subprocess.check_output(['/usr/bin/hyprctl', '--instance', signature, 'eval', expression], timeout=2)
        if result.strip() != b'ok':
            raise ValueError('layout_refused')
        monitor = command(signature, 'monitors')[0]
        if (monitor['width'], monitor['height'], monitor['scale']) != (w, h, 1):
            raise ValueError('layout_unrealized')
    return True

def set_frame_policy(signature, enabled):
    if type(enabled) is not bool:
        raise ValueError('layout_frame_policy')
    expression = 'hl.config({debug={vfr=' + ('true' if enabled else 'false') + '}})'
    result = subprocess.check_output(['/usr/bin/hyprctl', '--instance', signature, '-r', 'eval', expression], timeout=2)
    if result.strip() != b'ok' or command(signature, 'getoption', 'debug:vfr').get('bool') is not enabled:
        raise ValueError('layout_frame_policy_unverified')

def serve(path, signature):
    if Path(path).exists():
        info = os.lstat(path)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('layout_socket')
        os.unlink(path)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(path); os.chmod(path, 0o600); server.listen(4)
        while True:
            client, _ = server.accept()
            with client:
                client.settimeout(3)
                try:
                    _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != os.getuid(): raise ValueError('layout_owner')
                    data = b''
                    while not data.endswith(b'\n') and len(data) <= 512:
                        chunk = client.recv(513-len(data))
                        if not chunk: raise ValueError('layout_truncated')
                        data += chunk
                    if len(data) > 512: raise ValueError('layout_size')
                    apply(json.loads(data), signature)
                    client.sendall(b'{"applied":true}\n')
                except Exception as error:
                    code = str(error) if re.fullmatch(r'layout_[a-z_]+', str(error)) else type(error).__name__
                    print('omarchy_layout_failure ' + code, file=sys.stderr, flush=True)
                    client.sendall(b'{"applied":false}\n')

def main():
    display, path = sys.argv[1:]
    instances = json.loads(subprocess.check_output(['/usr/bin/hyprctl', '-j', 'instances'], timeout=2))
    matches = [i['instance'] for i in instances if i.get('wl_socket') == display]
    if len(matches) != 1 or not re.fullmatch(r'[A-Za-z0-9_.-]{1,160}', matches[0]):
        raise ValueError('layout_session')
    signature = matches[0]
    prior = command(signature, 'getoption', 'debug:vfr').get('bool')
    if type(prior) is not bool:
        raise ValueError('layout_frame_policy_unknown')
    def stop(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    try:
        # Native output-management completion is delivered at render preChecks.
        # Keep frame scheduling alive in a headless static desktop; -r starts
        # the first frame. No retry timer, and no user configuration file edit.
        set_frame_policy(signature, False)
        serve(path, signature)
    finally:
        set_frame_policy(signature, prior)

if __name__ == '__main__': main()
'''

LAYOUT_ADAPTER = r'''import asyncio, json, math, os, socket
from selkies.input_handler import WebRTCInput
try:
    # Selkies 2.0 keeps the WebSocket server and display helpers in explicit
    # modules. This release's pixelflux host-Wayland cursor callback is what
    # carries guest shapes separately from video.
    from selkies.websockets_mode import DataStreamingServer
    from selkies.display_utils import wayland_output_id
except ModuleNotFoundError:
    # Retain import compatibility only for inspecting an older sealed image;
    # the pinned release above must take the 2.0 branch in production.
    from selkies.selkies import DataStreamingServer, wayland_output_id

def apply_layout(width=None, height=None):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(3)
        client.connect('/opt/hivra-layout/hivra-layout.sock')
        client.sendall((json.dumps({'width': width, 'height': height, 'scale': 1})+'\n').encode())
        answer = b''
        while not answer.endswith(b'\n') and len(answer) < 128:
            chunk = client.recv(128-len(answer))
            if not chunk: raise RuntimeError('omarchy_layout_truncated')
            answer += chunk
        if json.loads(answer).get('applied') is not True:
            raise RuntimeError('omarchy_layout_refused')
    return True

def size_session(self, display, index, scale, size):
    if index != 0 or scale != 1:
        raise RuntimeError('omarchy_layout_policy')
    return apply_layout(*(size or (None, None)))

original_size = DataStreamingServer._size_wayland_screen
original_sync = DataStreamingServer._sync_wayland_realized_geometry
original_parse = DataStreamingServer._parse_settings_payload
original_native_cursor = DataStreamingServer.set_native_cursor_rendering

async def client_cursor_only(self, enabled):
    # Keep the video cursor-free so pointer motion is rendered immediately by
    # the browser. Selkies still forwards guest cursor metadata, allowing the
    # local pointer to follow hand, text, resize and hidden cursor states.
    # Delegate disabling upstream so an already-enabled capture is rebuilt.
    return await original_native_cursor(self, False)

def parse_settings(self, payload):
    parsed = original_parse(self, payload)
    raw = json.loads(payload)
    # The pinned client sends its first SETTINGS before server_settings delivers
    # locked CSS scaling. Those initial physical dimensions include device DPR.
    # Normalize only that explicit pre-policy dynamic payload, never manual modes.
    if (os.environ.get('SELKIES_USE_CSS_SCALING') == 'true|locked'
            and raw.get('useCssScaling') is False
            and parsed.get('manual_resolution') is False
            and parsed.get('displayId') == 'primary'):
        scale = raw.get('displayScale')
        if type(scale) not in (int, float) or not math.isfinite(scale) or not 1 <= scale <= 4:
            raise RuntimeError('omarchy_initial_density_invalid')
        for key in ('initialClientWidth', 'initialClientHeight'):
            value = raw.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                raise RuntimeError('omarchy_initial_geometry_invalid')
            parsed[key] = int(value / scale) & ~1
        parsed['displayScale'] = 1
    return parsed

async def size_capture(self, width, height, *args, **kwargs):
    displays = self.display_clients
    if set(displays) != {'primary'}:
        raise RuntimeError('omarchy_layout_single_display_required')
    # Selkies pads the union width to an alignment boundary. HostCapture waits
    # for the actual primary region, not that padded union.
    primary = displays['primary']
    requested = (int(primary['width']), int(primary['height']))
    self._hivra_requested_layout = requested
    module = self._wayland_control_module()
    # A retained ScreenCapture owns the shared Wayland backend, including its
    # committed wlr override while capture is stopped. is_capturing does not
    # describe output-manager ownership. Lua monitor
    # rules cannot override it: let the existing in-place capture restart
    # update its own manager, then verify the host before publishing geometry.
    if module is None:
        await asyncio.to_thread(apply_layout, *requested)
    return await original_size(self, width, height, *args, **kwargs)

async def sync_geometry(self, display_id, broadcast=True):
    requested = getattr(self, '_hivra_requested_layout', None)
    if display_id == 'primary' and requested is not None:
        instance = self.capture_instances.get('primary')
        module = instance.get('module') if instance else None
        geometry = await asyncio.to_thread(module.get_realized_geometry, wayland_output_id(display_id)) if module else None
        if geometry is None or tuple(geometry[:2]) != requested or geometry[2] != 1:
            # Retain the actual upstream state on a known refused resize, not
            # the requested dimensions (which otherwise make retries redundant).
            # Do not broadcast the unsupported requested geometry.
            if geometry is not None:
                await original_sync(self, display_id, False)
                self._hivra_requested_layout = None
            raise RuntimeError('omarchy_capture_geometry_unverified')
        await asyncio.to_thread(apply_layout, *requested)
        self._hivra_requested_layout = None
    return await original_sync(self, display_id, broadcast)

WebRTCInput._size_session_screen = size_session
DataStreamingServer._size_wayland_screen = size_capture
DataStreamingServer._sync_wayland_realized_geometry = sync_geometry
DataStreamingServer._parse_settings_payload = parse_settings
DataStreamingServer.set_native_cursor_rendering = client_cursor_only
'''
LAYOUT_BOOT = "import sys\nif sys.argv[0].endswith('/selkies'):\n    try:\n        import hivra_layout_policy\n    except Exception:\n        raise SystemExit('omarchy_layout_policy_unavailable')\n"


def run(argv, *, input_data=None, timeout=180, capture=False):
    return subprocess.run(argv, input=input_data, check=True, timeout=timeout,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})


def ensure_image(image):
    """Accept an exact local config or repository digest, otherwise pull it."""
    expected = "sha256:" + image.rsplit("@sha256:", 1)[1]
    probe = subprocess.run(["/usr/bin/docker", "image", "inspect", image, "--format",
                            '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    if probe.returncode == 0:
        try:
            observed = json.loads(probe.stdout)
            repository_digests = observed.get("repoDigests") or []
        except (json.JSONDecodeError, AttributeError):
            raise RuntimeError("image_digest_mismatch")
        if observed.get("id") != expected and not any(
                isinstance(value, str) and value.endswith("@" + expected)
                for value in repository_digests):
            raise RuntimeError("image_digest_mismatch")
        return
    run(["/usr/bin/docker", "pull", image], timeout=300)


def write(path, data, mode, uid=0, gid=0):
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    try:
        os.write(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chown(temporary, uid, gid)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def main():
    if os.geteuid() != 0:
        raise RuntimeError("root_required")
    request = json.loads(sys.stdin.buffer.read(32768))
    if set(request) != {"computerId", "guestPrivateIpv4", "ownerUid", "waylandDisplay", "controlOrigin", "publicOrigin"}:
        raise RuntimeError("input_shape")
    if not UUID.fullmatch(str(request["computerId"])) or not isinstance(request["ownerUid"], int) or request["ownerUid"] < 1000:
        raise RuntimeError("input_identity")
    if not re.fullmatch(r"10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}", str(request["guestPrivateIpv4"])):
        raise RuntimeError("input_network")
    if not re.fullmatch(r"wayland-[0-9]{1,3}", str(request["waylandDisplay"])):
        raise RuntimeError("input_wayland")
    if request["controlOrigin"] != "https://canary.hermesos.cloud" or request["publicOrigin"] != "https://omarchy-canary.hermesos.cloud":
        raise RuntimeError("input_origin")
    owner = pwd.getpwuid(request["ownerUid"])
    socket_path = Path("/run/user") / str(owner.pw_uid) / request["waylandDisplay"]
    info = os.stat(socket_path, follow_symlinks=False)
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != owner.pw_uid:
        raise RuntimeError("wayland_socket_unavailable")
    for source in (SOURCE / "broker.cjs", SOURCE / "omarchy-web-broker.cjs", SOURCE / "omarchy-web-server.cjs"):
        if not source.is_file() or source.is_symlink():
            raise RuntimeError("source_unavailable")

    ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    os.chown(ROOT, 0, 0)
    os.chmod(ROOT, 0o755)
    layout_runtime = ROOT / 'layout-runtime'
    layout_runtime.mkdir(exist_ok=True, mode=0o700)
    os.chown(layout_runtime, owner.pw_uid, owner.pw_gid)
    os.chmod(layout_runtime, 0o700)
    adapter_root = ROOT / 'python-policy'
    adapter_root.mkdir(exist_ok=True, mode=0o755)
    write(ROOT / 'layout-service.py', LAYOUT_SERVICE.encode(), 0o644)
    write(adapter_root / 'hivra_layout_policy.py', LAYOUT_ADAPTER.encode(), 0o644)
    write(adapter_root / 'sitecustomize.py', LAYOUT_BOOT.encode(), 0o644)
    STATE.mkdir(exist_ok=True, mode=0o700)
    os.chown(STATE, 65532, 65532)
    os.chmod(STATE, 0o700)
    username = "hivra-" + secrets.token_urlsafe(12)
    password = secrets.token_urlsafe(32)
    basic = base64.b64encode(f"{username}:{password}".encode()).decode()
    write(STATE / "basic-auth.b64", (basic + "\n").encode(), 0o600, 65532, 65532)
    write(ROOT / "input-isolation", b"selkies-container-no-agent-input-v1\n", 0o644)
    write(STATE / "selkies.env", "\n".join([
        f"SELKIES_BASIC_AUTH_USER={username}", f"SELKIES_BASIC_AUTH_PASSWORD={password}",
        "SELKIES_ENABLE_BASIC_AUTH=true", "SELKIES_ENABLE_HTTPS=false", "SELKIES_MODE=websockets",
        "SELKIES_WAYLAND=true", f"SELKIES_WAYLAND_HOST_DISPLAY=/tmp/runtime-ubuntu/{request['waylandDisplay']}",
        f"SELKIES_APP_WAYLAND_DISPLAY=/tmp/runtime-ubuntu/{request['waylandDisplay']}",
        "SELKIES_AUTO_GPU=false", "SELKIES_USE_CPU=true", "SELKIES_FRAMERATE=60", "SELKIES_VIDEO_BITRATE=25000",
        "SELKIES_USE_CSS_SCALING=true|locked", "SELKIES_SCALING_DPI=96", "PYTHONPATH=/opt/hivra-python-policy",
        # Keep cursor metadata enabled for local guest shapes. The layout policy
        # above independently forces native video cursor capture off.
        "SELKIES_ENABLE_CURSORS=true", "SELKIES_BACKPRESSURE_QUEUE_SIZE=4",
        "SELKIES_COMMAND_ENABLED=false", "SELKIES_ENABLE_CLIPBOARD=false", "SELKIES_ENABLE_BINARY_CLIPBOARD=false",
        "SELKIES_AUDIO_ENABLED=false", "SELKIES_MICROPHONE_ENABLED=false", "SELKIES_GAMEPAD_ENABLED=false",
        "SELKIES_WEBCAM_ENABLED=false", "SELKIES_FILE_TRANSFERS=none", "START_LXQT=false", "XDG_RUNTIME_DIR=/tmp/runtime-ubuntu",
    ]) .encode() + b"\n", 0o600)
    write(STATE / "broker.env", "\n".join([
        f"HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN={request['controlOrigin']}",
        f"HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN={request['publicOrigin']}",
        "HIVRA_REMOTE_DESKTOP_COMPUTER_KIND=hivra-agent", f"HIVRA_REMOTE_DESKTOP_COMPUTER_ID={request['computerId']}",
        "HIVRA_REMOTE_DESKTOP_TRANSPORT=selkies-websocket", "HIVRA_REMOTE_DESKTOP_BASIC_AUTH_FILE=/state/basic-auth.b64",
        "HIVRA_REMOTE_DESKTOP_STATE_FILE=/state/sessions.json", "HIVRA_REMOTE_DESKTOP_INPUT_ISOLATION_FILE=/opt/input-isolation",
    ]).encode() + b"\n", 0o600)

    ensure_image(SELKIES_IMAGE)
    ensure_image(NODE_IMAGE)
    if subprocess.run(["/usr/bin/docker", "network", "inspect", NETWORK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        run(["/usr/bin/docker", "network", "create", "--label", "hivra.omarchy-web=v1", NETWORK])
    runtime = str(socket_path.parent)
    layout_unit = f"""[Unit]\nDescription=Hivra owner-scoped Omarchy display policy\nAfter=graphical.target\n\n[Service]\nUser={owner.pw_uid}\nGroup={owner.pw_gid}\nEnvironment=XDG_RUNTIME_DIR={runtime}\nExecStart=/usr/bin/python3 {ROOT / 'layout-service.py'} {request['waylandDisplay']} {layout_runtime / 'hivra-layout.sock'}\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths={layout_runtime}\n\n[Install]\nWantedBy=multi-user.target\n"""
    selkies_unit = f"""[Unit]\nDescription=Hivra Omarchy browser stream\nAfter=docker.service graphical.target\nRequires=docker.service\n\n[Service]\nRestart=always\nRestartSec=2\nExecStartPre=-/usr/bin/docker rm -f {SELKIES}\nExecStart=/usr/bin/docker run --rm --name {SELKIES} --network {NETWORK} --user {owner.pw_uid}:{owner.pw_gid} --env-file {STATE / 'selkies.env'} --tmpfs /tmp/runtime-ubuntu:rw,uid={owner.pw_uid},gid={owner.pw_gid},mode=700 --mount type=bind,src={socket_path},dst=/tmp/runtime-ubuntu/{request['waylandDisplay']} {SELKIES_IMAGE}\nExecStop=/usr/bin/docker stop -t 10 {SELKIES}\n\n[Install]\nWantedBy=multi-user.target\n"""
    broker_unit = f"""[Unit]\nDescription=Hivra Omarchy authenticated browser broker\nAfter=docker.service hivra-omarchy-web.service\nRequires=docker.service hivra-omarchy-web.service\n\n[Service]\nRestart=always\nRestartSec=2\nExecStartPre=-/usr/bin/docker rm -f {BROKER}\nExecStart=/usr/bin/docker run --rm --name {BROKER} --network {NETWORK} --user 65532:65532 --env-file {STATE / 'broker.env'} -p {request['guestPrivateIpv4']}:8090:8090 --mount type=bind,src={SOURCE},dst=/app,readonly --mount type=bind,src={STATE},dst=/state --mount type=bind,src={ROOT / 'input-isolation'},dst=/opt/input-isolation,readonly -w /app {NODE_IMAGE} node omarchy-web-server.cjs\nExecStop=/usr/bin/docker stop -t 10 {BROKER}\n\n[Install]\nWantedBy=multi-user.target\n"""
    # multi-user.target orders its enabled services before itself; ordering these
    # services after graphical.target (which follows multi-user) creates a cycle.
    layout_unit = layout_unit.replace('After=graphical.target\n', '')
    selkies_unit = selkies_unit.replace('After=docker.service graphical.target', 'After=docker.service hivra-omarchy-layout.service').replace('Requires=docker.service', 'Requires=docker.service hivra-omarchy-layout.service')
    selkies_unit = selkies_unit.replace(f' {SELKIES_IMAGE}\n', f' --mount type=bind,src={layout_runtime},dst=/opt/hivra-layout,readonly --mount type=bind,src={adapter_root},dst=/opt/hivra-python-policy,readonly {SELKIES_IMAGE}\n')
    write(Path("/etc/systemd/system/hivra-omarchy-layout.service"), layout_unit.encode(), 0o644)
    write(Path("/etc/systemd/system/hivra-omarchy-web.service"), selkies_unit.encode(), 0o644)
    write(Path("/etc/systemd/system/hivra-omarchy-web-broker.service"), broker_unit.encode(), 0o644)
    run(["/usr/bin/systemctl", "daemon-reload"])
    run(["/usr/bin/systemctl", "restart", "hivra-omarchy-layout.service"])
    run(["/usr/bin/systemctl", "enable", "--now", "hivra-omarchy-layout.service", "hivra-omarchy-web.service", "hivra-omarchy-web-broker.service"])
    run(["/usr/bin/systemctl", "restart", "hivra-omarchy-web.service", "hivra-omarchy-web-broker.service"])
    for _ in range(45):
        probe = subprocess.run(["/usr/bin/curl", "-fsS", "-H", "Host: omarchy-canary.hermesos.cloud", "-o", "/dev/null", "-w", "%{http_code}",
                                f"http://{request['guestPrivateIpv4']}:8090/desktop/health"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if probe.stdout in (b"200", b"401", b"404"):
            break
        time.sleep(1)
    else:
        raise RuntimeError("broker_unready")
    print(json.dumps({"protocol": "hivra-omarchy-web-prepared-v1", "browserReady": True,
                      "brokerOrigin": request["publicOrigin"], "selkiesImage": SELKIES_IMAGE,
                      "nodeImage": NODE_IMAGE}, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
