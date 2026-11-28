ln -s "$NODE_ROOT/bin/node" /usr/bin/node
ln -s "$NODE_ROOT/bin/npm" /usr/bin/npm
python3 -I -B - "$BASE_IMAGE_SHA256" <<'PY'
import importlib.util
import json
from pathlib import Path
import sys

source = Path("/root/hivra-image-bake")
spec = importlib.util.spec_from_file_location("deepseek_native", source / "install-native.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
receipt = native.install_package(source)
Path("/etc/hivra/deepseek-harness-bake.json").write_text(json.dumps({
    "schema": 1,
    "kind": "deepseek-harness",
    "baseImageSha256": sys.argv[1],
    "nativePackage": receipt,
}, sort_keys=True) + "\n")
PY
timeout 30 runuser -u nobody -- env -i HOME=/nonexistent PATH=/usr/bin:/bin /usr/bin/node <<'JS'
const pty = require('/opt/hivra/deepseek-runtime/node_modules/node-pty');
const terminal = pty.spawn('/bin/sh', ['-c', 'printf hivra-pty-ok'], { cwd: '/' });
let output = '';
terminal.onData(data => { output += data; });
terminal.onExit(({ exitCode }) => {
  if (exitCode || output !== 'hivra-pty-ok') process.exitCode = 1;
});
JS
rm -- /usr/bin/node /usr/bin/npm
rm -rf -- "$NODE_ROOT"
