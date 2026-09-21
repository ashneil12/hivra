import { spawnSync } from "node:child_process";
import { FOLDER_RECOVERY_GUEST_PYTHON } from "../folder-recovery-guest";
import { buildFolderRecoveryHostScript } from "../folder-recovery-host";

function python(assertions: string) {
  const code = `${FOLDER_RECOVERY_GUEST_PYTHON}\nimport tempfile, shutil\nwith tempfile.TemporaryDirectory(prefix='hivra-folder-test-') as temporary:\n${assertions.split("\n").map((line) => `    ${line}`).join("\n")}\n`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8", timeout: 30_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
}
const setup = `
source = temporary + '/source'
dest = temporary + '/dest'
receipts = temporary + '/receipts'
for home in (source, dest):
    os.mkdir(home, 0o700)
    os.mkdir(home + '/Hivra', 0o700)
    os.mkdir(home + '/.hivra', 0o700)
    open(home + '/.hivra/api-token', 'wb').write(b'fresh-destination-token')
def invoke(action, home):
    return run(action, home, receipts, os.getuid(), os.getgid(), False)
def request(entries):
    return {'action':'restore', 'operationId':'11111111-1111-4111-8111-111111111111',
            'artifactSha256':'a'*64, 'tokenSha256':hashlib.sha256(b'fresh-destination-token').hexdigest(), 'entries':entries}
`;

describe("actual guest folder implementation on disposable directories", () => {
  it("copies exact binary bytes and empty folders to a new inode, preserving source and outside files", () => python(`${setup}
os.mkdir(source + '/Hivra/sub')
open(source + '/Hivra/sub/binary', 'wb').write(bytes(range(256)))
os.mkdir(source + '/Hivra/empty')
open(source + '/outside', 'wb').write(b'preserve me')
entries = invoke({'action':'export'}, source)['entries']
before = os.stat(dest + '/Hivra').st_ino
restored = invoke(request(entries), dest)
assert restored['verified'] and restored['files'] == 1 and restored['bytes'] == 256
assert os.stat(dest + '/Hivra').st_ino != before
assert invoke({'action':'export'}, source)['entries'] == entries
assert invoke({'action':'export'}, dest)['entries'] == entries
assert open(source + '/outside','rb').read() == b'preserve me'
# A second call verifies the installed inode, never overwrites it.
assert invoke(request(entries), dest) == restored
assert not os.path.exists(dest + '/.hivra-folder-stage-' + request(entries)['operationId'])
`));
  it("refuses a nonempty destination and preserves its bytes", () => python(`${setup}
open(dest + '/Hivra/existing', 'wb').write(b'keep')
try:
    invoke(request([]), dest)
    raise AssertionError('must reject nonempty destination')
except RecoveryError as error:
    assert str(error) == 'destination_must_be_empty'
assert open(dest + '/Hivra/existing','rb').read() == b'keep'
`));
  it("rejects symlinks, hardlinks and special files without reading outside the selected folder", () => python(`${setup}
open(source + '/outside','wb').write(b'secret')
for kind in ('symlink','hardlink','fifo'):
    path = source + '/Hivra/link'
    if kind == 'symlink': os.symlink(source + '/outside', path)
    elif kind == 'hardlink': os.link(source + '/outside', path)
    else: os.mkfifo(path)
    try:
        invoke({'action':'export'}, source)
        raise AssertionError('must reject ' + kind)
    except RecoveryError:
        pass
    os.unlink(path)
assert open(source + '/outside','rb').read() == b'secret'
`));
  it("rejects traversal, hash mismatch and archives exceeding the exact file/byte bounds", () => python(`${setup}
bad = [
    [{'kind':'directory','path':'../escape'}],
    [{'kind':'file','path':'file','content':'eA==','sha256':'b'*64,'executable':False}],
    [{'kind':'directory','path':str(i)} for i in range(513)]
]
for entries in bad:
    try:
        invoke(request(entries), dest)
        raise AssertionError('must reject invalid entries')
    except RecoveryError:
        pass
open(source + '/Hivra/too-big','wb').write(b'x'*(MAX_BYTES+1))
try:
    invoke({'action':'export'},source)
    raise AssertionError('must reject byte limit')
except RecoveryError:
    pass
assert os.listdir(dest + '/Hivra') == []
`));
  it("does not overwrite changed destination bytes when verifying a lost response", () => python(`${setup}
open(source + '/Hivra/file','wb').write(b'original')
entries = invoke({'action':'export'},source)['entries']
invoke(request(entries),dest)
open(dest + '/Hivra/file','wb').write(b'user changed this')
try:
    invoke(request(entries),dest)
    raise AssertionError('must not reapply')
except RecoveryError as error:
    assert str(error) == 'restored_bytes_changed'
assert open(dest + '/Hivra/file','rb').read() == b'user changed this'
`));
  it("rejects a different artifact on the same durable operation", () => python(`${setup}
invoke(request([]),dest)
other = request([])
other['artifactSha256'] = 'b'*64
try:
    invoke(other,dest)
    raise AssertionError('must reject substituted artifact')
except RecoveryError as error:
    assert str(error) == 'recovery_artifact_conflict'
`));
  it("resumes an interrupted staged file without replacing any destination content", () => python(`${setup}
open(source + '/Hivra/file','wb').write(b'full-file-content')
entries = invoke({'action':'export'},source)['entries']
original_write = os.write
def interrupted_write(fd, data):
    if data == b'full-file-content':
        original_write(fd, data[:4])
        raise RuntimeError('simulated process interruption')
    return original_write(fd, data)
os.write = interrupted_write
try:
    invoke(request(entries),dest)
    raise AssertionError('must simulate interruption')
except RuntimeError:
    pass
finally:
    os.write = original_write
assert os.listdir(dest + '/Hivra') == []
assert invoke(request(entries),dest)['verified']
assert open(dest + '/Hivra/file','rb').read() == b'full-file-content'
`));
  it("reconciles the exact installed inode after interruption between rename and terminal receipt", () => python(`${setup}
open(source + '/Hivra/file','wb').write(b'copied')
entries = invoke({'action':'export'},source)['entries']
original_save = write_json_at
def interrupted_save(parent, name, value):
    if value.get('state') == 'verified': raise RuntimeError('lost response')
    return original_save(parent,name,value)
write_json_at = interrupted_save
try:
    invoke(request(entries),dest)
    raise AssertionError('must simulate lost response')
except RuntimeError:
    pass
finally:
    write_json_at = original_save
inode = os.stat(dest + '/Hivra').st_ino
assert invoke(request(entries),dest)['verified']
assert os.stat(dest + '/Hivra').st_ino == inode
`));
  it("fails an atomic install if a file appears after the empty-folder check", () => python(`${setup}
original_rename = os.rename
def concurrent_rename(src, dst, **kwargs):
    if src == 'tree': open(dest + '/Hivra/concurrent','wb').write(b'preserve concurrent bytes')
    return original_rename(src,dst,**kwargs)
os.rename = concurrent_rename
try:
    invoke(request([]),dest)
    raise AssertionError('must not overwrite concurrent bytes')
except OSError:
    pass
finally:
    os.rename = original_rename
assert open(dest + '/Hivra/concurrent','rb').read() == b'preserve concurrent bytes'
`));
  it("rejects a destination gateway token that is not its newly enrolled identity", () => python(`${setup}
open(dest + '/.hivra/api-token','wb').write(b'copied-old-source-token')
try:
    invoke(request([]),dest)
    raise AssertionError('must reject copied identity')
except RecoveryError as error:
    assert str(error) == 'destination_token_identity_mismatch'
assert os.listdir(dest + '/Hivra') == []
`));
  it("attempts to restart the destination desktop after a no-overwrite conflict without reporting success", () => python(`${setup}
original_rename = os.rename
calls = []
def service(command, **kwargs):
    calls.append(command)
    return subprocess.CompletedProcess(command,0)
subprocess.run = service
def concurrent_rename(src, dst, **kwargs):
    if src == 'tree': open(dest + '/Hivra/concurrent','wb').write(b'preserved')
    return original_rename(src,dst,**kwargs)
os.rename = concurrent_rename
try:
    run(request([]),dest,receipts,os.getuid(),os.getgid(),True)
    raise AssertionError('must not claim a completed restore')
except OSError:
    pass
finally:
    os.rename = original_rename
assert WORKSPACE_SERVICES == ['hivra-selkies-desktop.service','hivra-remote-desktop-broker.service','bux-ttyd.service','bux-box-ttyd.service','bux-hivra-chat.service']
assert calls == [['systemctl','stop'] + list(reversed(WORKSPACE_SERVICES)), ['systemctl','start'] + WORKSPACE_SERVICES]
assert open(dest + '/Hivra/concurrent','rb').read() == b'preserved'
`));
  it("revalidates a prepared tree before installing after a crash", () => python(`${setup}
open(source + '/Hivra/file','wb').write(b'original')
entries = invoke({'action':'export'},source)['entries']
original_rename = os.rename
def interrupted_rename(src, dst, **kwargs):
    if src == 'tree': raise RuntimeError('interrupted before install')
    return original_rename(src,dst,**kwargs)
os.rename = interrupted_rename
try:
    invoke(request(entries),dest)
except RuntimeError:
    pass
finally:
    os.rename = original_rename
stage = dest + '/.hivra-folder-stage-' + request(entries)['operationId']
open(stage + '/tree/file','wb').write(b'changed')
try:
    invoke(request(entries),dest)
    raise AssertionError('must reject changed prepared bytes')
except RecoveryError as error:
    assert str(error) == 'prepared_tree_mismatch'
assert os.listdir(dest + '/Hivra') == []
`));
  it("finishes empty-stage cleanup after interruption following marker removal", () => python(`${setup}
original_rmdir = os.rmdir
def interrupted_rmdir(path, **kwargs):
    if str(path).startswith('.hivra-folder-stage-'): raise RuntimeError('cleanup interrupted')
    return original_rmdir(path,**kwargs)
os.rmdir = interrupted_rmdir
try:
    invoke(request([]),dest)
except RuntimeError:
    pass
finally:
    os.rmdir = original_rmdir
assert invoke(request([]),dest)['verified']
assert not os.path.exists(dest + '/.hivra-folder-stage-' + request([])['operationId'])
`));
});

describe("folder recovery host authority", () => {
  const target = { vmid: 1234, ip: "10.242.10.12", bindingTag: `hivra-bind-${"a".repeat(32)}`, vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator" };
  it("takes the shared lifecycle lock and pins SSH to the exact VM after binding/IP checks", () => {
    const script = buildFolderRecoveryHostScript(target, { action: "export" });
    expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"')).toBeLessThan(script.indexOf('qm guest exec "$VMID"'));
    expect(script.indexOf('[ "$CONFIGURED_IP" = "$GUEST_IP" ]')).toBeLessThan(script.indexOf('qm guest exec "$VMID"'));
    expect(script).toContain("flock -w 45 8");
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).not.toContain("qm clone");
    expect(script).not.toContain("qm destroy");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });
  it("refuses unbound, missing, or injected guest targets", () => {
    for (const changed of [{ vmid: 0 }, { bindingTag: "" }, { ip: "10.242.1.1;false" }, { vmSshKeyPath: "relative" }]) {
      expect(() => buildFolderRecoveryHostScript({ ...target, ...changed }, { action: "export" })).toThrow();
    }
  });
});
