// Lifecycle probes must not run `uv run`: even a status check can replace a
// qualified image venv to satisfy the source checkout's .python-version.
// Validate and use the existing interpreter without syncing dependencies.
const EXISTING_GATEWAY_PYTHON = String.raw`
import os
import re
import sys
from pathlib import Path

agent_dir = Path(sys.argv[1]).absolute()
venv = agent_dir / ".venv"
try:
    if Path(sys.prefix).resolve() != venv.resolve(strict=True) or sys.prefix == sys.base_prefix:
        raise ValueError("interpreter is not the managed virtual environment")
    config = {}
    for line in (venv / "pyvenv.cfg").read_text().splitlines():
        if "=" in line:
            key, value = (part.strip() for part in line.split("=", 1))
            if key in config and config[key] != value:
                raise ValueError("contradictory virtual environment metadata")
            config[key] = value
    versions = [config[key] for key in ("version", "version_info") if key in config]
    if not config.get("home") or not versions:
        raise ValueError("missing virtual environment metadata")
    for version in versions:
        match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:\.final\.0)?", version)
        if not match or tuple(map(int, match.groups())) != sys.version_info[:3] or sys.version_info.releaselevel != "final":
            raise ValueError("virtual environment interpreter version does not match its metadata")
except (OSError, ValueError) as error:
    raise SystemExit("[gateway-runtime] Existing managed Python is invalid; refusing to rebuild it: " + str(error))

os.environ.pop("UV_PROJECT_ENVIRONMENT", None)
os.environ.pop("PYTHONHOME", None)
os.environ["VIRTUAL_ENV"] = str(venv)
os.environ["PATH"] = str(venv / "bin") + os.pathsep + os.environ.get("PATH", os.defpath)
os.chdir(agent_dir)
python = str(venv / "bin" / "python")
os.execv(python, [python, "-B", "-m", "hermes_cli.main", "gateway", *sys.argv[2:]])
`.trim();

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildExistingGatewayCommand(args: readonly string[]): string {
  const script = [
    "set -eu",
    'AGENT_DIR="${HERMES_WEBUI_AGENT_DIR:-${HERMES_HOME:?HERMES_HOME is required}/hermes-agent}"',
    'PYTHON="$AGENT_DIR/.venv/bin/python"',
    'if [ ! -f "$AGENT_DIR/.venv/pyvenv.cfg" ] || [ ! -x "$PYTHON" ]; then',
    '  echo "[gateway-runtime] Existing managed Python is missing or broken; refusing to create or rebuild it." >&2',
    "  exit 1",
    "fi",
    `exec "$PYTHON" -I -B -c ${quoteShell(EXISTING_GATEWAY_PYTHON)} "$AGENT_DIR" ${args.map(quoteShell).join(" ")}`,
  ].join("\n");
  return `sh -c ${quoteShell(script)}`;
}

export function buildManagedGatewayStatusCommand(): string {
  return buildExistingGatewayCommand(["status"]);
}

// Embedded after the legacy launcher's .env loader. Only its genuine first
// start may create a venv; a broken or dangling existing venv never falls back
// to uv. Existing runtimes use the same validation as the read-only probes.
export function buildLegacyManagedGatewayRunPython(): string {
  return `agent_dir = base_home / "hermes-agent"
os.environ.pop("UV_PROJECT_ENVIRONMENT", None)
os.environ.pop("PYTHONHOME", None)
os.environ["HERMES_WEBUI_AGENT_DIR"] = str(agent_dir)
os.chdir(agent_dir)
if not os.path.lexists(agent_dir / ".venv"):
    uv = "/usr/local/bin/uv"
    os.execv(uv, [uv, "run", "--project", str(agent_dir), "--python", "/usr/bin/python3", "--no-python-downloads", "--inexact", "--extra", "messaging", "hermes", "gateway", "run", "--replace", "--accept-hooks"])
os.execv("/bin/sh", ["sh", "-c", ${JSON.stringify(buildExistingGatewayCommand(["run", "--replace", "--accept-hooks"]))}])`;
}
