#!/usr/bin/env python3
"""Execute generated probe on real private files/locks; OS observations replaced.

Root uid metadata is substituted on Darwin. No service, Docker or HTTP commands
run. The shared inspection body is replaced; its existing suite tests that body.
"""
import ast
import base64
import contextlib
import fcntl
import hashlib
import io
import json
import os
import stat
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

fixture = json.load(sys.stdin)
script = fixture["script"]
# Compile the complete, unmodified generated Python before fixture substitution.
compile(script, "actual-provider-probe", "exec")
identity = fixture["identity"]
intent = {"version": 1, "computerId": identity["agentId"], "operationId": identity["operationId"]}
units = ("hivra-remote-desktop-broker.service", "bux-hivra-chat.service", "hivra-selkies-desktop.service")
ownership = {**intent, "units": {name: "a"*64 for name in units}, "container": {"id": "b"*64, "imageId": "sha256:"+"c"*64}}
network = {**intent, "networkId": "d"*64}
capability = {"fixture": "capability"}
encode = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")
preparation = {**intent, "controlOrigin": "https://canary.hermesos.cloud", "publicOrigin": fixture["origin"]}
ready = {**preparation, "ownership": ownership, "capabilitySha256": hashlib.sha256(encode(capability)).hexdigest()}
capture_boot = fixture.get("captureBootId", False)
workspace = fixture.get("workspace", False)
faults = ("clean", "reboot_missing_install_lock", "busy_install_lock", "symlink_install_lock", "unsafe_install_lock", "cancel", "wrong_identity", "owner_drift", "controller_drift", "missing_lock", "symlink_lock", "late_stop", "network_drift", "capability_drift", "late_detach")
if capture_boot: faults += ("boot_drift", "invalid_boot")
if workspace: faults += ("workspace_missing", "workspace_hash", "workspace_writable", "workspace_symlink", "workspace_origin", "workspace_flag", "workspace_duplicate", "workspace_preload", "workspace_cgroup", "workspace_restart", "workspace_user", "workspace_control", "workspace_ld_preload", "workspace_ld_audit", "workspace_ld_path")
for fault in faults:
    with tempfile.TemporaryDirectory(prefix="hivra-desktop-probe-") as temporary:
        base = Path(temporary)
        boot_file = base/"boot-id"
        boot_file.write_text("invalid" if fault == "invalid_boot" else "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        root = base/"journal"
        root.mkdir(mode=0o700)
        (root/"desktop-cleanup").mkdir(mode=0o700)
        def write(path, raw):
            path.write_bytes(raw)
            path.chmod(0o600)
        for name, value in {"identity.json": identity, "started.json": identity,
            "result.json": {"identity": identity, "exitCode": 0},
            "stopped-outcome.json": {"identity": identity, "state": "succeeded"},
            "desktop-ownership.json": ownership, "desktop-network.json": network,
            "desktop-network-intent.json": intent, "desktop-preparation-intent.json": preparation,
            "desktop-ready.json": ready, "manifest.json": fixture["manifest"]}.items():
            write(root/name, encode(value))
        write(root/"controller.py", base64.b64decode(fixture["worker"]))
        write(root/"desktop-cleanup/provider-service-owner.py", base64.b64decode(fixture["owner"]))
        write(base/"capability.json", encode(capability))
        process_inodes = set()
        if workspace:
            gateway = base/"gateway"
            gateway.mkdir(mode=0o755)
            for name, raw in fixture["workspaceFiles"].items():
                write(gateway/name, base64.b64decode(raw))
                (gateway/name).chmod(0o644)
            if fault == "workspace_missing": (gateway/"workspace-router.cjs").unlink()
            if fault == "workspace_hash": (gateway/"workspace-router.cjs").write_bytes(b"changed")
            if fault == "workspace_writable": (gateway/"workspace-router.cjs").chmod(0o666)
            if fault == "workspace_symlink":
                (gateway/"workspace-router.cjs").unlink()
                (gateway/"workspace-router.cjs").symlink_to(gateway/"workspace-policy.cjs")
            executable = base/"node"
            write(executable, b"fake node; never executed")
            executable.chmod(0o755)
            process = base/"proc"/"123"
            process.mkdir(parents=True, mode=0o755)
            environment = {"HIVRA_WORKSPACE_PROTOCOL": "hivra-workspace-v1", "HIVRA_AGENT_KIND": "linux-desktop",
                "HIVRA_WORKSPACE_ROOT": "/home/bux/Hivra", "HIVRA_CHAT_PORT": "8080", "HOME": "/home/bux",
                "HIVRA_REMOTE_DESKTOP_COMPUTER_ID": identity["agentId"], "HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN": fixture["origin"],
                "HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN": preparation["controlOrigin"], "PRIVATE_FIXTURE": "must-not-escape"}
            if fault == "workspace_origin": environment["HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN"] = "https://wrong.example.test"
            if fault == "workspace_flag": environment["HIVRA_WORKSPACE_PROTOCOL"] = "disabled"
            if fault == "workspace_control": environment["HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN"] = "https://wrong.example.test"
            if fault == "workspace_preload": environment["NODE_OPTIONS"] = "--require=/tmp/untrusted.cjs"
            if fault == "workspace_ld_preload": environment["LD_PRELOAD"] = "/tmp/untrusted.so"
            if fault == "workspace_ld_audit": environment["LD_AUDIT"] = "/tmp/untrusted.so"
            if fault == "workspace_ld_path": environment["LD_LIBRARY_PATH"] = "/tmp"
            env = b"".join(k.encode()+b"="+v.encode()+b"\0" for k,v in environment.items())
            if fault == "workspace_duplicate": env += b"HOME=/home/bux\0"
            write(process/"environ", env)
            write(process/"cmdline", str(executable).encode()+b"\0"+str(gateway/"server.js").encode()+b"\0")
            write(process/"cgroup", b"0::/system.slice/foreign.service\n" if fault == "workspace_cgroup" else b"0::/system.slice/bux-hivra-chat.service\n")
            write(process/"stat", b"123 (node) S "+b"0 "*18+b"987\n")
            (process/"exe").symlink_to(executable)
            process_inodes = {p.lstat().st_ino for p in (process,*(process.iterdir()))}
        for path in (root/"manager.lock", root/"run.lock", base/"install.lock"):
            write(path, b"")
        if fault == "cancel": write(root/"cancel.json", encode(identity))
        if fault == "wrong_identity": write(root/"identity.json", encode({**identity, "agentId": identity["operationId"]}))
        if fault == "owner_drift": write(root/"desktop-cleanup/provider-service-owner.py", b"wrong")
        if fault == "controller_drift": write(root/"controller.py", b"wrong")
        if fault == "missing_lock": (root/"run.lock").unlink()
        held_lock = None
        if fault == "reboot_missing_install_lock": (base/"install.lock").unlink()
        if fault == "busy_install_lock":
            held_lock = os.open(base/"install.lock", os.O_RDONLY)
            fcntl.flock(held_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if fault == "symlink_install_lock":
            (base/"install.lock").unlink()
            (base/"install.lock").symlink_to(root/"run.lock")
        if fault == "unsafe_install_lock": (base/"install.lock").chmod(0o666)
        if fault == "symlink_lock":
            (root/"run.lock").unlink()
            (root/"run.lock").symlink_to(base/"install.lock")
        if fault == "capability_drift": write(base/"capability.json", b"{}")
        observed_calls = []
        def observed(plan):
            assert plan == ownership
            observed_calls.append(True)
            if fault == "boot_drift" and len(observed_calls) == 2:
                boot_file.write_text("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
            if fault == "workspace_restart" and len(observed_calls) == 2:
                write(process/"stat", b"123 (node) S "+b"0 "*18+b"988\n")
            return {name: {"LoadState": "loaded", "ActiveState": "active", "SubState": "running",
                "MainPID": "123", "ControlPID": "0", "UnitFileState": "enabled"} for name in units}, {
                "Running": not (fault == "late_stop" and len(observed_calls) == 2), "Paused": False, "Restarting": False, "Dead": False}
        def command(argv):
            if argv[0] == "/usr/bin/systemctl":
                state = {"LoadState": "not-found", "ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "ControlPID": "0", "ControlGroup": "", "Transient": "no", "Job": ""}
                return "".join(k+"="+v+"\n" for k,v in state.items()).encode()
            if argv[:3] == ["/usr/bin/docker", "container", "inspect"]:
                assert argv[-1] == ownership["container"]["id"]
                endpoints={} if fault=="late_detach" and len(observed_calls)==2 else {"hivra-remote-desktop":{"NetworkID":network["networkId"]}}
                return encode([ownership["container"]["id"],network["networkId"],endpoints,
                    [{"Type":"bind","Source":"/home/bux/Hivra","Destination":"/home/ubuntu/Hivra","Mode":"","RW":True,"Propagation":"rprivate"}]])
            assert argv == ["/usr/bin/docker", "network", "inspect", network["networkId"]]
            return encode([{"Id": "e"*64 if fault == "network_drift" else network["networkId"], "Name": "hivra-remote-desktop", "Driver": "bridge", "Scope": "local",
                "Internal": False, "Attachable": False, "Ingress": False, "EnableIPv6": False,
                "ConfigOnly": False, "ConfigFrom": {"Network": ""}, "Options": {},
                "Labels": {"io.hivra.computer-id": intent["computerId"], "io.hivra.operation-id": intent["operationId"],
                    "io.hivra.desktop-network-intent": hashlib.sha256(encode(intent)).hexdigest()}}])
        local = script
        if fault in ("clean", "reboot_missing_install_lock"):
            local = local.replace("except BaseException:\n print('Provider desktop runtime", "except BaseException:\n raise\n print('Provider desktop runtime")
        for old,new in (("/proc/sys/kernel/random/boot_id",str(boot_file)),("/var/lib/hivra/provider-install",str(root)),("/run/hivra-agent-install.lock",str(base/"install.lock")),
            ("/opt/hivra/remote-desktop/capability.json",str(base/"capability.json")),("/sys/fs/cgroup/system.slice/hivra-provider-install.service",str(base/"absent-cgroup"))):
            local = local.replace(old,new)
        local = local.replace("identity=EXPECTED['identity'];", "owner.observed=fixture_observed\n owner.command=fixture_command\n identity=EXPECTED['identity'];")
        if workspace:
            local = local.replace("pathlib.Path('/opt/bux')/entry['path']", "pathlib.Path("+repr(str(gateway))+")/entry['path'].split('/')[-1]")
            local = local.replace("/opt/bux/hivra-chat/server.js",str(gateway/"server.js"))
            local = local.replace("pathlib.Path('/proc')", "pathlib.Path("+repr(str(base/"proc"))+")")
        tree = ast.parse(local)
        # Replace only the shared body, leaving the actual outer ownership,
        # lock, journal, hash and final-publication program executable.
        for node in tree.body:
            if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=="PROGRAM" for t in node.targets):
                node.value = ast.Constant("assert HIVRA_PROVIDER_DESKTOP_INSPECTION['containerId']=='"+ownership["container"]["id"]+"'\nprint('fixture-capability')")
        real_lstat,real_fstat = os.lstat,os.fstat
        def root_metadata(info, mode=None):
            uid = (43 if fault == "workspace_user" else 42) if info.st_ino in process_inodes else 0
            return SimpleNamespace(st_mode=info.st_mode if mode is None else mode,st_uid=uid,st_nlink=info.st_nlink,st_size=info.st_size)
        def fixture_lstat(path,*args,**kwargs):
            info=real_lstat(path,*args,**kwargs)
            # Linux's protected system ancestors are not Darwin's /var symlink
            # or writable temporary parent. Actual task-owned entries stay real.
            ancestor=Path(path) in base.parents
            return root_metadata(info,stat.S_IFDIR|0o755 if ancestor else None)
        output,errors = io.StringIO(),io.StringIO()
        with patch.object(os,"geteuid",return_value=0), patch.object(os,"lstat",side_effect=fixture_lstat), \
            patch("pwd.getpwnam",return_value=SimpleNamespace(pw_uid=42)), \
            patch.object(os,"fstat",side_effect=lambda *a,**k:root_metadata(real_fstat(*a,**k))), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            try:
                exec(compile(ast.fix_missing_locations(tree),"provider-probe-fixture","exec"),{"fixture_observed":observed,"fixture_command":command})
                code=0
            except SystemExit as error:
                code=error.code
        if held_lock is not None: os.close(held_lock)
        if fault in ("clean", "reboot_missing_install_lock"):
            assert stat.S_IMODE((base/"install.lock").stat().st_mode) == 0o600
            assert code==0, (fault,errors.getvalue())
            if workspace:
                assert output.getvalue().startswith("HIVRA_PROVIDER_WORKSPACE_V1 ")
                assert json.loads(output.getvalue().split(" ",1)[1]) == {"protocol":"hivra-workspace-v1",
                    "computerId":identity["agentId"],"operationId":identity["operationId"],"publicOrigin":fixture["origin"],
                    "controlOrigin":preparation["controlOrigin"],"capabilityOutput":"fixture-capability\n"}
                assert "must-not-escape" not in output.getvalue()
            elif capture_boot:
                assert output.getvalue().startswith("HIVRA_PROVIDER_DESKTOP_POWER_V1 ")
                assert json.loads(output.getvalue().split(" ",1)[1]) == {"bootId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","capabilityOutput":"fixture-capability\n"}
            else: assert output.getvalue()=="fixture-capability\n", (fault,errors.getvalue())
            assert len(observed_calls)==2
        else:
            assert code==1 and output.getvalue()=="", (fault,code,output.getvalue())
            assert errors.getvalue()=="Provider desktop runtime could not be verified\n"
print(f"PASS provider desktop runtime: {len(faults)} generated-probe cases; retained files, locks and output suppression")
