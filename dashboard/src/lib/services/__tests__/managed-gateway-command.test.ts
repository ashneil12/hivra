import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLegacyManagedGatewayRunPython, buildManagedGatewayStatusCommand } from "../managed-gateway-command";

// Execute the emitted shell/Python against real, disposable virtualenvs. The
// dependency-free Hermes stand-in reports the interpreter and argv that the
// actual lifecycle command used; no server, model or customer files are used.
const fixture = String.raw`
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

request = json.load(sys.stdin)
root = Path(request["root"]).resolve()
base = root / "managed home's files"
project = base / "hermes-agent"
project.mkdir(parents=True)
profile = root / "profiles" / "named profile" if request["mode"] == "named-profile" else base
profile.mkdir(parents=True, exist_ok=True)
(profile / "config.yaml").write_text("owner: preserved\n")
(project / ".python-version").write_text("3.11\n")
(project / "pyproject.toml").write_text('[project]\nname="gateway-readonly-test"\nversion="0.0.0"\nrequires-python=">=3.9"\n[project.optional-dependencies]\nmessaging=[]\n[tool.uv]\npackage=false\n')
venv = project / ".venv"
mode = request["mode"]
if mode not in ("absent", "dangling-venv", "venv-file", "first-start"):
    subprocess.run([sys.executable, "-I", "-m", "venv", "--without-pip", str(venv)], check=True)
    site = Path(subprocess.check_output([str(venv / "bin" / "python"), "-I", "-c", "import site; print(site.getsitepackages()[0])"], text=True).strip())
    (site / "owner_kept.py").write_text('VALUE = "owner-package-preserved"\n')
    (site / "owner_kept-1.0.dist-info").mkdir()
    (site / "owner_kept-1.0.dist-info" / "METADATA").write_text("Metadata-Version: 2.1\nName: owner-kept\nVersion: 1.0\n")
cfg = venv / "pyvenv.cfg"
python = venv / "bin" / "python"
if mode == "dangling-venv":
    venv.symlink_to(root / "missing-venv", target_is_directory=True)
elif mode == "venv-file":
    venv.write_text("not a venv\n")
elif mode == "missing-config":
    cfg.unlink()
elif mode == "malformed-config":
    cfg.write_text("not a config\n")
elif mode == "missing-version":
    cfg.write_text("\n".join(line for line in cfg.read_text().splitlines() if not line.startswith("version")) + "\n")
elif mode == "version-mismatch":
    cfg.write_text(cfg.read_text().replace("version = ", "version = 0."))
elif mode == "prerelease-mismatch":
    cfg.write_text("\n".join(line + "rc1" if line.startswith("version = ") else line for line in cfg.read_text().splitlines()) + "\n")
elif mode == "missing-python":
    python.unlink()
elif mode == "dangling-python":
    python.unlink()
    python.symlink_to(root / "missing-python")
elif mode == "nonexecutable-python":
    python.unlink()
    python.write_text("not executable\n")
elif mode == "different-prefix":
    other = root / "other-venv"
    subprocess.run([sys.executable, "-I", "-m", "venv", "--without-pip", str(other)], check=True)
    python.unlink()
    # A shim is executable but dispatches to an unrelated venv. The prefix
    # check must reject it instead of importing/running that environment.
    python.write_text('#!/bin/sh\nexec "' + str(other / "bin" / "python") + '" "$@"\n')
    python.chmod(0o700)

module = project / "hermes_cli"
module.mkdir()
(module / "__init__.py").write_text("")
(module / "main.py").write_text('''import importlib.util, json, os, subprocess, sys
from pathlib import Path
found = importlib.util.find_spec("owner_kept")
marker = None
if found:
    import owner_kept
    marker = owner_kept.VALUE
child_prefix = subprocess.check_output(["python", "-B", "-c", "import sys; print(sys.prefix)"], text=True).strip()
print(json.dumps({"prefix": sys.prefix, "child_prefix": child_prefix, "version": list(sys.version_info[:3]), "args": sys.argv[1:], "cwd": os.getcwd(), "home": os.environ.get("HERMES_HOME"), "uv_environment": os.environ.get("UV_PROJECT_ENVIRONMENT"), "pythonhome": os.environ.get("PYTHONHOME"), "no_bytecode": bool(sys.flags.dont_write_bytecode), "marker": marker}))
''')
bin_dir = root / "bin"
bin_dir.mkdir()
uv_trace = root / "unexpected-uv"
(bin_dir / "uv").write_text('#!/bin/sh\ntouch "' + str(uv_trace) + '"\nexit 99\n')
(bin_dir / "uv").chmod(0o700)
# The fresh dependency-free fixture needs an entrypoint; uv still resolves,
# creates and synchronizes the real project environment before invoking it.
(bin_dir / "hermes").write_text('#!/bin/sh\nexec python -B -m hermes_cli.main "$@"\n')
(bin_dir / "hermes").chmod(0o700)
(root / "uv.toml").write_text("")
env = dict(os.environ, HERMES_HOME=str(profile), HERMES_WEBUI_AGENT_DIR=str(project),
           UV_PROJECT_ENVIRONMENT=str(root / "must-not-create"), PYTHONHOME=str(root / "bogus-python-home"),
           VIRTUAL_ENV=str(root / "source-image-env"), PATH=str(bin_dir) + ":/usr/bin:/bin",
           UV_OFFLINE="1", UV_PYTHON_DOWNLOADS="never", UV_CACHE_DIR=str(root / "uv-cache"),
           UV_PYTHON_INSTALL_DIR=str(root / "python-downloads"), UV_CONFIG_FILE=str(root / "uv.toml"))

def snapshot():
    files = {}
    for path in sorted(project.rglob("*")):
        if path.is_symlink():
            files[str(path.relative_to(project))] = ("symlink", os.readlink(path))
        elif path.is_file():
            files[str(path.relative_to(project))] = ("file", hashlib.sha256(path.read_bytes()).hexdigest())
        elif path.is_dir():
            files[str(path.relative_to(project))] = ("dir", path.stat().st_ino)
    return files

before = snapshot()
results = []
for _ in range(2):
    if request["action"] == "status":
        completed = subprocess.run(["/bin/sh", "-c", request["status"]], env=env, capture_output=True, text=True, timeout=20)
    else:
        # Map only the two qualified image executable paths to the explicitly
        # supplied fixture tools. All emitted uv arguments and sync are real.
        prelude = 'import os\nfrom pathlib import Path\nbase_home = Path(os.environ["HERMES_HOME"])\n'
        if mode == "first-start":
            prelude += '''real_execv = os.execv
def fixture_execv(path, args):
    if path == "/usr/local/bin/uv":
        assert args[1:5] == ["run", "--project", str(base_home / "hermes-agent"), "--python"]
        assert args[5] == "/usr/bin/python3"
        args = list(args)
        args[0] = ''' + repr(request["uv"]) + '''
        args[5] = ''' + repr(sys.executable) + '''
        return real_execv(args[0], args)
    return real_execv(path, args)
os.execv = fixture_execv
'''
        completed = subprocess.run([sys.executable, "-I", "-B", "-c", prelude + request["run"]], env=env, capture_output=True, text=True, timeout=30)
    results.append({"code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr})

print(json.dumps({"results": results, "preserved": before == snapshot(), "venv_exists": os.path.lexists(venv),
                  "uv_called": uv_trace.exists(), "unwanted_environment": os.path.lexists(root / "must-not-create"),
                  "config_preserved": (profile / "config.yaml").read_text() == "owner: preserved\n",
                  "python_version_preserved": (project / ".python-version").read_text() == "3.11\n",
                  "bytecode_created": bool(list(project.rglob("*.pyc"))),
                  "project": str(project), "venv": str(venv), "profile": str(profile), "version": list(sys.version_info[:3])}))
`;

function runFixture(mode: string, action: "status" | "run" = "status") {
  const root = mkdtempSync(join(tmpdir(), "gateway-readonly-test-"));
  try {
    const run = spawnSync(process.env.HERMES_RUNTIME_TEST_PYTHON || "python3", ["-I", "-B", "-c", fixture], {
      encoding: "utf8",
      input: JSON.stringify({ mode, action, root, status: buildManagedGatewayStatusCommand(), run: buildLegacyManagedGatewayRunPython(), uv: process.env.HERMES_RUNTIME_TEST_UV }),
      timeout: 60_000,
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, NODE_ENV: "test" },
    });
    expect(run.error).toBeUndefined();
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("non-syncing managed gateway lifecycle commands", () => {
  it.each(["valid", "named-profile"])("runs %s status twice without changing runtime/config/owner packages", (mode) => {
    const result = runFixture(mode);
    expect(result.preserved).toBe(true);
    expect(result.uv_called).toBe(false);
    expect(result.unwanted_environment).toBe(false);
    expect(result.config_preserved).toBe(true);
    expect(result.python_version_preserved).toBe(true);
    expect(result.bytecode_created).toBe(false);
    for (const run of result.results) {
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        prefix: result.venv, child_prefix: result.venv, version: result.version, args: ["gateway", "status"], cwd: result.project,
        home: result.profile, uv_environment: null, pythonhome: null, no_bytecode: true, marker: "owner-package-preserved",
      });
    }
  });

  it.each(["absent", "dangling-venv", "venv-file", "missing-config", "malformed-config", "missing-version", "version-mismatch", "prerelease-mismatch", "missing-python", "dangling-python", "nonexecutable-python", "different-prefix"])(
    "fails status closed on %s without creating or changing the environment", (mode) => {
      const result = runFixture(mode);
      expect(result.preserved).toBe(true);
      expect(result.uv_called).toBe(false);
      expect(result.unwanted_environment).toBe(false);
      expect(result.config_preserved).toBe(true);
      if (mode === "absent") expect(result.venv_exists).toBe(false);
      for (const run of result.results) expect(run.code).not.toBe(0);
    },
  );

  it("uses the existing interpreter for legacy run without syncing away owner packages", () => {
    const result = runFixture("valid", "run");
    expect(result.preserved).toBe(true);
    expect(result.uv_called).toBe(false);
    for (const run of result.results) {
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        prefix: result.venv, child_prefix: result.venv, args: ["gateway", "run", "--replace", "--accept-hooks"], marker: "owner-package-preserved",
        uv_environment: null, no_bytecode: true,
      });
    }
  });

  it.each(["dangling-venv", "missing-config", "version-mismatch"])("does not recreate a %s venv when legacy run is requested", (mode) => {
    const result = runFixture(mode, "run");
    expect(result.preserved).toBe(true);
    expect(result.uv_called).toBe(false);
    for (const run of result.results) expect(run.code).not.toBe(0);
  });

  const realUv = process.env.HERMES_RUNTIME_TEST_UV ? it : it.skip;
  realUv("preserves legacy first-start creation with qualified Python and real sync-enabled uv", () => {
    const result = runFixture("first-start", "run");
    expect(result.venv_exists).toBe(true);
    expect(result.config_preserved).toBe(true);
    expect(result.python_version_preserved).toBe(true);
    expect(result.unwanted_environment).toBe(false);
    for (const run of result.results) {
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        prefix: result.venv, child_prefix: result.venv, version: result.version, args: ["gateway", "run", "--replace", "--accept-hooks"], uv_environment: null,
      });
    }
  }, 60_000);
});
