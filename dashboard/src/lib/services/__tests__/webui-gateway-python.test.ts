import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebUICompose, type WebUIDeployParams } from "../webui-instance-builder";

const params: WebUIDeployParams = {
  instanceId: "runtime-python-test",
  containerName: "agent-runtime-python-test",
  fqdn: "runtime-python.invalid",
  cpuLimit: 1,
  ramLimit: 1024,
  llmApiKey: "test-only-provider-key",
  inferenceProvider: "custom",
  defaultModel: "test/model",
  baseUrl: "https://provider.invalid/v1",
  webuiPassword: "test-only-password",
};

function emittedSupervisor(): string {
  const compose = buildWebUICompose({ ...params, image: "webui:test", agentImage: "agent:test" });
  const body = compose.split("exec python3 - <<'PY'\n")[1]?.split("\n          PY")[0];
  if (!body) throw new Error("Generated gateway supervisor was not found");
  return body.split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n").replace(/\$\$/g, "$");
}

// Execute the actual generated Python, stopping before its service loop. All
// files, interpreters and optional uv subprocesses belong to this temp fixture.
const fixture = String.raw`
import ast
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

request = json.load(sys.stdin)
root = Path(request["root"]).resolve()
project = root / "project"
profile = root / "profile"
project.mkdir()
profile.mkdir()
venv = project / ".venv"
os.environ["HERMES_HOME"] = str(profile)
os.environ["HERMES_WEBUI_AGENT_DIR"] = str(project)
os.environ["UV_CACHE_DIR"] = str(root / "uv-cache")
os.environ["UV_PYTHON_INSTALL_DIR"] = str(root / "managed-python")
os.environ["UV_PYTHON_DOWNLOADS"] = "never"
os.environ["UV_OFFLINE"] = "1"
(root / "uv.toml").write_text("", encoding="utf-8")
os.environ["UV_CONFIG_FILE"] = str(root / "uv.toml")
os.environ.pop("VIRTUAL_ENV", None)
mode = request["mode"]
if mode not in ("absent", "real-uv-absent", "dangling-venv", "venv-file"):
    args = [sys.executable, "-I", "-m", "venv", "--without-pip"]
    if mode == "real-uv-copies":
        args.append("--copies")
    subprocess.run(args + [str(venv)], check=True)
    if mode == "real-uv-copies" and sys.platform == "darwin":
        # Python-build-standalone's copied macOS executable resolves its dylib
        # relative to bin/. Supply only that fixture dependency, like the
        # source distribution; otherwise --copies cannot start on this host.
        library = "libpython" + ".".join(str(part) for part in sys.version_info[:2]) + ".dylib"
        source = Path(sys.base_prefix) / "lib" / library
        if source.is_file():
            (venv / "lib" / library).symlink_to(source)
source_image_venv = root / "source-image-environment"
if mode.startswith("real-uv"):
    subprocess.run([sys.executable, "-I", "-m", "venv", "--without-pip", str(source_image_venv)], check=True)
    os.environ["VIRTUAL_ENV"] = str(source_image_venv)
    source_image_inode = source_image_venv.stat().st_ino
    source_image_config = (source_image_venv / "pyvenv.cfg").read_bytes()
python = venv / "bin" / "python"
cfg = venv / "pyvenv.cfg"
if mode in ("valid-python3-chain", "valid-no-python3", "missing-python3-target"):
    # Linux commonly creates python -> python3 -> the base interpreter,
    # while macOS can link each alias directly. Reproduce the Linux chain on
    # every host so the missing-alias fixture is truly valid, not dangling.
    base_python = python.resolve(strict=True)
    alias = venv / "bin" / "python3"
    python.unlink()
    alias.unlink()
    alias.symlink_to(base_python)
    python.symlink_to("python3")
if mode == "dangling-venv":
    venv.symlink_to(root / "missing-venv", target_is_directory=True)
elif mode == "venv-file":
    venv.write_text("not a virtual environment", encoding="utf-8")
elif mode == "missing-config":
    cfg.unlink()
elif mode == "malformed-config":
    cfg.write_text("not a pyvenv config\n", encoding="utf-8")
elif mode == "missing-version":
    cfg.write_text("\n".join(line for line in cfg.read_text(encoding="utf-8").splitlines()
                             if not line.startswith("version")) + "\n", encoding="utf-8")
elif mode == "missing-home":
    cfg.write_text("\n".join(line for line in cfg.read_text(encoding="utf-8").splitlines()
                             if not line.startswith("home")) + "\n", encoding="utf-8")
elif mode == "invalid-version-suffix":
    cfg.write_text(cfg.read_text(encoding="utf-8") + "version_info = " +
                   ".".join(str(part) for part in sys.version_info[:3]) + "garbage\n", encoding="utf-8")
elif mode == "version-mismatch":
    cfg.write_text(cfg.read_text(encoding="utf-8") + "version_info = 0.0.1.final.0\n", encoding="utf-8")
elif mode == "version-prerelease-mismatch":
    cfg.write_text(cfg.read_text(encoding="utf-8") + "version_info = " +
                   ".".join(str(part) for part in sys.version_info[:3]) + "rc1\n", encoding="utf-8")
elif mode == "valid-uv-config":
    cfg.write_text(cfg.read_text(encoding="utf-8").replace(
        "version = ", "version_info = "), encoding="utf-8")
elif mode == "valid-no-python3":
    base_python = python.resolve(strict=True)
    python.unlink()
    python.symlink_to(base_python)
    (venv / "bin" / "python3").unlink()
elif mode == "missing-python3-target":
    (venv / "bin" / "python3").unlink()
elif mode in ("missing-python", "dangling-python", "nonexecutable-python"):
    python.unlink()
    if mode == "dangling-python":
        python.symlink_to(root / "missing-python")
    elif mode == "nonexecutable-python":
        python.write_text("not executable", encoding="utf-8")
        python.chmod(0o600)
elif mode == "different-python3":
    alias = venv / "bin" / "python3"
    alias.unlink()
    alias.write_text("#!/bin/sh\nprintf '%s\\n' '" + json.dumps({
        "version": [0, 0, 1], "releaselevel": "final", "serial": 0,
        "prefix": str(venv), "base_prefix": sys.base_prefix,
    }) + "'\n", encoding="utf-8")
    alias.chmod(0o700)

# Owner .env must not redirect uv into another environment.
other_venv = root / "owner-other-environment"
(profile / ".env").write_text("UV_PROJECT_ENVIRONMENT=" + str(other_venv) + "\n", encoding="utf-8")
tree = ast.parse(request["supervisor"])
prefix = []
for node in tree.body:
    if isinstance(node, ast.While):
        break
    prefix.append(node)
scope = {"__name__": "emitted_gateway_fixture"}
exec(compile(ast.Module(body=prefix, type_ignores=[]), "<emitted-gateway>", "exec"), scope)

def command(action):
    # The fallback makes these regressions execute the previous emitted code
    # too, proving OLD RED rather than merely asserting a new symbol exists.
    if "managed_gateway_command" in scope:
        return scope["managed_gateway_command"](action)
    return scope[action + "_cmd"]

before_inode = venv.lstat().st_ino if os.path.lexists(venv) else None
before_config = cfg.read_bytes() if cfg.is_file() else None
try:
    commands = {action: command(action) for action in ("status", "run")}
except Exception as exc:
    print(json.dumps({
        "rejected": True, "error": str(exc),
        "preserved": (venv.lstat().st_ino == before_inode and
                      (cfg.read_bytes() if cfg.is_file() else None) == before_config),
    }))
    sys.exit(0)

env = scope["profile_env"](profile)
result = {
    "rejected": False, "commands": commands, "venv": str(venv),
    "project": str(project),
    "environment": env.get("UV_PROJECT_ENVIRONMENT"),
    "exists": os.path.lexists(venv),
}
if mode.startswith("real-uv"):
    uv = request["uv"]
    version = subprocess.check_output([uv, "--version"], text=True)
    assert version.startswith("uv 0.11.6 "), version
    (project / "pyproject.toml").write_text(
        '[project]\nname="managed-runtime-fixture"\nversion="0.0.0"\n'
        'requires-python=">=3.8"\ndependencies=[]\n'
        '[project.optional-dependencies]\nmessaging=[]\n', encoding="utf-8")
    (project / ".python-version").write_text("3.11\n", encoding="utf-8")
    if mode in ("real-uv", "real-uv-copies"):
        purelib = Path(subprocess.check_output([
            str(python), "-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))",
        ], text=True).strip())
        package = purelib / "owner_extra"
        package.mkdir()
        (package / "__init__.py").write_text("marker = 'owner-package-preserved'\n", encoding="utf-8")
        metadata = purelib / "owner_extra-9.9.9.dist-info"
        metadata.mkdir()
        (metadata / "METADATA").write_text("Metadata-Version: 2.1\nName: owner-extra\nVersion: 9.9.9\n", encoding="utf-8")
        (metadata / "RECORD").write_text("owner_extra/__init__.py,,\nowner_extra-9.9.9.dist-info/METADATA,,\n", encoding="utf-8")
        task_project = root / "task-project"
        task_project.mkdir()
        (task_project / "pyproject.toml").write_text(
            '[project]\nname="user-task-fixture"\nversion="0.0.0"\n'
            'requires-python=">=3.8"\ndependencies=[]\n', encoding="utf-8")
        env["HERMES_FIXTURE_TASK_PROJECT"] = str(task_project)
        env["HERMES_FIXTURE_UV"] = uv
        env["HERMES_FIXTURE_BASE_PYTHON"] = sys.executable
        entrypoint = venv / "bin" / "hermes"
        entrypoint.write_text("#!" + str(python) + '''
import json, os, subprocess, sys, owner_extra
result = {'version': list(sys.version_info[:3]), 'prefix': sys.prefix,
          'marker': owner_extra.marker, 'args': sys.argv[1:],
          'project_environment': os.environ.get('UV_PROJECT_ENVIRONMENT')}
if sys.argv[2] == 'run':
    # Match the native Local backend's virtualenv-marker scrub, using the
    # actual environment inherited by the managed Hermes payload.
    task_env = os.environ.copy()
    for key in ('VIRTUAL_ENV', 'CONDA_PREFIX', 'PYTHONHOME'):
        task_env.pop(key, None)
    child = subprocess.run([
        os.environ['HERMES_FIXTURE_UV'], 'run', '--python', os.environ['HERMES_FIXTURE_BASE_PYTHON'],
        '--no-python-downloads', 'python', '-c', 'import json,sys; print(json.dumps(sys.prefix))',
    ], cwd=os.environ['HERMES_FIXTURE_TASK_PROJECT'], env=task_env,
        text=True, capture_output=True, timeout=30, check=True)
    result['task_prefix'] = json.loads(child.stdout)
print(json.dumps(result))
''', encoding="utf-8")
        entrypoint.chmod(0o700)
        marker_hash = hashlib.sha256((package / "__init__.py").read_bytes()).hexdigest()
    outputs = []
    if mode == "real-uv-absent":
        result["expected_version"] = json.loads(subprocess.check_output([
            "/usr/bin/python3", "-I", "-c", "import json,sys; print(json.dumps(list(sys.version_info[:3])))",
        ], text=True))
    for action in ("status", "run"):
        args = command(action)
        # Map only the image uv executable to this checksum-verified test binary.
        # The emitted arguments, sync behavior and profile environment are real.
        args[0] = uv
        if mode == "real-uv-absent":
            # The dependency-free project has no Hermes entrypoint on a fresh
            # venv. Exercise its exact uv prefix with a Python payload instead.
            args = args[:args.index("hermes")] + ["python", "-c",
                    "import json,sys; print(json.dumps({'prefix':sys.prefix,'version':list(sys.version_info[:3])}))"]
        completed = subprocess.run(args, cwd=project, env=env, capture_output=True, text=True, timeout=30)
        if completed.returncode:
            raise AssertionError("uv failed: " + completed.stderr)
        outputs.append(json.loads(completed.stdout))
    result["outputs"] = outputs
    result["python_version_file_preserved"] = (project / ".python-version").read_text(encoding="utf-8") == "3.11\n"
    result["other_environment_absent"] = not os.path.lexists(other_venv)
    result["source_image_environment_preserved"] = (source_image_venv.stat().st_ino == source_image_inode and
        (source_image_venv / "pyvenv.cfg").read_bytes() == source_image_config)
    if mode in ("real-uv", "real-uv-copies"):
        result["preserved"] = (venv.stat().st_ino == before_inode and
                               cfg.read_bytes() == before_config and
                               hashlib.sha256((package / "__init__.py").read_bytes()).hexdigest() == marker_hash)
        result["expected_version"] = list(sys.version_info[:3])
        result["task_venv"] = str(task_project / ".venv")
        result["task_venv_created"] = (task_project / ".venv" / "pyvenv.cfg").is_file()
        result["copied_aliases"] = not os.path.samefile(python, venv / "bin" / "python3")
print(json.dumps(result))
`;

function runFixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "gateway-python-test-"));
  try {
    const run = spawnSync(process.env.HERMES_RUNTIME_TEST_PYTHON || "python3", ["-I", "-c", fixture], {
      encoding: "utf8",
      input: JSON.stringify({ mode, root, supervisor: emittedSupervisor(), uv: process.env.HERMES_RUNTIME_TEST_UV }),
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

describe("managed gateway Python selection", () => {
  it.each(["valid", "valid-uv-config", "valid-python3-chain", "valid-no-python3"])("pins the existing %s venv for both commands", (mode) => {
    const result = runFixture(mode);
    expect(result.rejected).toBe(false);
    const interpreter = mode === "valid-no-python3" ? "python" : "python3";
    const prefix = ["/usr/local/bin/uv", "run", "--project", result.project, "--python", `${result.venv}/bin/${interpreter}`,
      "--no-python-downloads", "--inexact", "--extra", "messaging", "hermes", "gateway"];
    expect(result.commands.status).toEqual([...prefix, "status"]);
    expect(result.commands.run).toEqual([...prefix, "run", "--replace", "--accept-hooks"]);
    expect(result.environment).toBeNull();
  });

  it("uses the qualified image Python only when the entire venv is absent", () => {
    const result = runFixture("absent");
    expect(result.rejected).toBe(false);
    expect(result.commands.status.slice(0, 7)).toEqual(["/usr/local/bin/uv", "run", "--project", result.project, "--python", "/usr/bin/python3", "--no-python-downloads"]);
    expect(result.commands.run.slice(0, 7)).toEqual(result.commands.status.slice(0, 7));
    expect(result.exists).toBe(false);
    expect(result.environment).toBeNull();
  });

  it.each(["dangling-venv", "venv-file", "missing-config", "malformed-config", "missing-version", "missing-home", "invalid-version-suffix",
    "version-mismatch", "version-prerelease-mismatch", "missing-python", "dangling-python", "missing-python3-target", "nonexecutable-python", "different-python3"])(
    "fails closed and preserves an existing %s environment", (mode) => {
      const result = runFixture(mode);
      expect(result.rejected).toBe(true);
      expect(result.error).toMatch(/managed gateway.*environment/i);
      expect(result.preserved).toBe(true);
    },
  );

  // Real uv is opt-in: tests never download a tool or Python behind the caller's
  // back. Qualification supplies a checksum-verified 0.11.6 executable.
  const realUv = process.env.HERMES_RUNTIME_TEST_UV ? it : it.skip;
  realUv.each(["real-uv", "real-uv-copies"])("preserves %s and isolates tasks through two sync-enabled uv runs", (mode) => {
    const result = runFixture(mode);
    expect(result.rejected).toBe(false);
    expect(result.preserved).toBe(true);
    expect(result.python_version_file_preserved).toBe(true);
    expect(result.other_environment_absent).toBe(true);
    expect(result.source_image_environment_preserved).toBe(true);
    expect(result.copied_aliases).toBe(mode === "real-uv-copies");
    expect(result.outputs).toHaveLength(2);
    for (const output of result.outputs) {
      expect(output.version).toEqual(result.expected_version);
      expect(output.prefix).toBe(result.venv);
      expect(output.marker).toBe("owner-package-preserved");
      expect(output.project_environment).toBeNull();
    }
    expect(result.outputs[0].args).toEqual(["gateway", "status"]);
    expect(result.outputs[1].args).toEqual(["gateway", "run", "--replace", "--accept-hooks"]);
    expect(result.outputs[1].task_prefix).toBe(result.task_venv);
    expect(result.task_venv_created).toBe(true);
  }, 60_000);

  realUv("creates only a genuinely absent venv using the qualified image Python", () => {
    const result = runFixture("real-uv-absent");
    expect(result.rejected).toBe(false);
    expect(result.python_version_file_preserved).toBe(true);
    expect(result.other_environment_absent).toBe(true);
    expect(result.source_image_environment_preserved).toBe(true);
    expect(result.outputs.map((output: { prefix: string }) => output.prefix)).toEqual([result.venv, result.venv]);
    expect(result.outputs.map((output: { version: number[] }) => output.version)).toEqual([result.expected_version, result.expected_version]);
  }, 60_000);
});
