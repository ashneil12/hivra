// Sent over the existing VMID/QGA-attested SSH channel; no provisioner release
// or remote install is needed. The production entrypoint fixes all filesystem
// roots. Tests invoke run() with disposable roots, never real guest data.
export const FOLDER_RECOVERY_GUEST_PYTHON = String.raw`
import base64, fcntl, hashlib, json, os, pwd, stat, subprocess, sys, uuid

MAX_BYTES = 2 * 1024 * 1024
MAX_ENTRIES = 512
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
WORKSPACE_SERVICES = ['hivra-selkies-desktop.service', 'hivra-remote-desktop-broker.service', 'bux-ttyd.service',
                      'bux-box-ttyd.service', 'bux-hivra-chat.service']

class RecoveryError(Exception):
    pass

def require(condition, message):
    if not condition:
        raise RecoveryError(message)

def directory(path):
    return os.open(path, FLAGS | os.O_DIRECTORY)


def snapshot(fd, uid):
    result = []
    total = 0
    def walk(parent, prefix):
        nonlocal total
        before = os.fstat(parent)
        require(before.st_uid == uid, 'workspace_owner_mismatch')
        for name in sorted(os.listdir(parent)):
            path = prefix + name
            require(len(result) < MAX_ENTRIES, 'folder_entry_limit_512')
            require(len(path.encode('utf-8')) <= 1024 and '\\' not in path
                    and all(ord(c) >= 32 and ord(c) != 127 for c in path), 'unsupported_filename')
            item = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(item.st_uid == uid, 'workspace_owner_mismatch')
            if stat.S_ISDIR(item.st_mode):
                result.append({'path': path, 'kind': 'directory'})
                child = os.open(name, FLAGS | os.O_DIRECTORY, dir_fd=parent)
                try:
                    require(os.fstat(child).st_ino == item.st_ino, 'folder_changed_during_export')
                    walk(child, path + '/')
                finally:
                    os.close(child)
            else:
                require(stat.S_ISREG(item.st_mode) and item.st_nlink == 1, 'links_and_special_files_not_supported')
                require(total + item.st_size <= MAX_BYTES, 'folder_byte_limit_2_mib')
                child = os.open(name, FLAGS | os.O_NONBLOCK, dir_fd=parent)
                try:
                    opened = os.fstat(child)
                    require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1
                            and opened.st_uid == uid and opened.st_ino == item.st_ino, 'folder_changed_during_export')
                    chunks = []
                    count = 0
                    while True:
                        chunk = os.read(child, min(65536, MAX_BYTES - total - count + 1))
                        if not chunk:
                            break
                        count += len(chunk)
                        require(total + count <= MAX_BYTES, 'folder_byte_limit_2_mib')
                        chunks.append(chunk)
                    after = os.fstat(child)
                    require((opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                            == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'folder_changed_during_export')
                    content = b''.join(chunks)
                    total += len(content)
                    result.append({'path': path, 'kind': 'file', 'content': base64.b64encode(content).decode(),
                                   'sha256': hashlib.sha256(content).hexdigest(), 'executable': bool(after.st_mode & 0o100)})
                finally:
                    os.close(child)
        after = os.fstat(parent)
        require((before.st_mtime_ns, before.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns),
                'folder_changed_during_export')
    walk(fd, '')
    return sorted(result, key=lambda entry: entry['path'])

def validate_entries(entries):
    require(isinstance(entries, list) and len(entries) <= MAX_ENTRIES, 'invalid_archive_entries')
    known = {}
    total = 0
    for entry in entries:
        path = entry.get('path', '')
        require(isinstance(path, str) and path and len(path.encode('utf-8')) <= 1024
                and '\\' not in path and all(ord(c) >= 32 and ord(c) != 127 for c in path)
                and all(part not in ('', '.', '..') for part in path.split('/'))
                and path not in known, 'invalid_archive_path')
        require(entry.get('kind') in ('file', 'directory'), 'invalid_archive_kind')
        known[path] = entry['kind']
        if entry['kind'] == 'file':
            raw = base64.b64decode(entry.get('content', ''), validate=True)
            require(hashlib.sha256(raw).hexdigest() == entry.get('sha256')
                    and isinstance(entry.get('executable'), bool), 'invalid_archive_hash')
            total += len(raw)
            require(total <= MAX_BYTES, 'folder_byte_limit_2_mib')
    for path in known:
        parts = path.split('/')
        require(all(known.get('/'.join(parts[:i])) == 'directory' for i in range(1, len(parts))), 'invalid_archive_parent')
    return sorted(entries, key=lambda entry: entry['path'])

def write_json_at(parent, name, value):
    temporary = name + '.tmp-' + str(uuid.uuid4())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        data = json.dumps(value).encode()
        while data:
            data = data[os.write(fd, data):]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    os.fsync(parent)

def read_json_at(parent, name):
    fd = os.open(name, FLAGS, dir_fd=parent)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_uid == os.getuid(), 'invalid_recovery_receipt')
        return json.loads(os.read(fd, 65536))
    finally:
        os.close(fd)

def run(request, home='/home/bux', receipt_root='/var/lib/hivra/folder-recovery', uid=None, gid=None, services=True):
    if uid is None:
        account = pwd.getpwnam('bux')
        uid, gid = account.pw_uid, account.pw_gid
    homefd = directory(home)
    try:
        require(os.fstat(homefd).st_uid == uid, 'home_owner_mismatch')
        if request['action'] == 'export':
            workspace = os.open('Hivra', FLAGS | os.O_DIRECTORY, dir_fd=homefd)
            try:
                first = snapshot(workspace, uid)
                require(first == snapshot(workspace, uid), 'folder_changed_during_export')
                require(os.stat('Hivra', dir_fd=homefd, follow_symlinks=False).st_ino == os.fstat(workspace).st_ino,
                        'folder_changed_during_export')
                return {'entries': first}
            finally:
                os.close(workspace)
        require(request['action'] == 'restore', 'invalid_recovery_action')
        # Fresh launch credentials stay outside the archive and must match the
        # controller's destination identity, not a cloned/source gateway token.
        token_dir = os.open('.hivra', FLAGS | os.O_DIRECTORY, dir_fd=homefd)
        try:
            token_fd = os.open('api-token', FLAGS, dir_fd=token_dir)
            try:
                token_stat = os.fstat(token_fd)
                require(stat.S_ISREG(token_stat.st_mode) and token_stat.st_uid == uid
                        and token_stat.st_nlink == 1 and token_stat.st_size <= 1024, 'destination_token_identity_mismatch')
                token = os.read(token_fd, 1025).strip()
                require(token and hashlib.sha256(token).hexdigest() == request.get('tokenSha256'), 'destination_token_identity_mismatch')
            finally:
                os.close(token_fd)
        finally:
            os.close(token_dir)
        operation = str(uuid.UUID(request['operationId']))
        artifact = request['artifactSha256']
        require(isinstance(artifact, str) and len(artifact) == 64 and all(c in '0123456789abcdef' for c in artifact), 'invalid_artifact_identity')
        entries = validate_entries(request['entries'])
        os.makedirs(receipt_root, mode=0o700, exist_ok=True)
        receipts = directory(receipt_root)
        try:
            require(os.fstat(receipts).st_uid == os.getuid() and os.fstat(receipts).st_mode & 0o077 == 0, 'invalid_receipt_directory')
            lockfd = os.open('lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=receipts)
            desktop_stop_attempted = False
            try:
                fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                name = operation + '.json'
                try:
                    receipt = read_json_at(receipts, name)
                except FileNotFoundError:
                    receipt = None
                if receipt:
                    require(receipt['artifactSha256'] == artifact, 'recovery_artifact_conflict')
                    workspace = os.open('Hivra', FLAGS | os.O_DIRECTORY, dir_fd=homefd)
                    try:
                        installed = os.fstat(workspace).st_ino == receipt['inode'] and os.fstat(workspace).st_dev == receipt['device']
                        if installed:
                            require(snapshot(workspace, uid) == entries, 'restored_bytes_changed')
                    finally:
                        os.close(workspace)
                else:
                    installed = False
                if not installed:
                    workspace = os.open('Hivra', FLAGS | os.O_DIRECTORY, dir_fd=homefd)
                    try:
                        require(os.fstat(workspace).st_uid == uid and not os.listdir(workspace), 'destination_must_be_empty')
                    finally:
                        os.close(workspace)
                    # A root-only staging parent prevents guest writes before the
                    # atomic directory replacement. Existing nonempty content can
                    # never be replaced by rename, including a concurrent write.
                    stage_name = '.hivra-folder-stage-' + operation
                    try:
                        os.mkdir(stage_name, 0o700, dir_fd=homefd)
                    except FileExistsError:
                        pass
                    stage = os.open(stage_name, FLAGS | os.O_DIRECTORY, dir_fd=homefd)
                    try:
                        require(os.fstat(stage).st_uid == os.getuid() and os.fstat(stage).st_mode & 0o077 == 0, 'invalid_staging_directory')
                        expected_stage = {'operationId':operation, 'artifactSha256':artifact}
                        try:
                            require(read_json_at(stage, 'identity.json') == expected_stage, 'staging_identity_mismatch')
                        except FileNotFoundError:
                            require(not os.listdir(stage), 'staging_identity_missing')
                            write_json_at(stage, 'identity.json', expected_stage)
                        if not receipt:
                            try:
                                os.mkdir('tree', 0o700, dir_fd=stage)
                            except FileExistsError:
                                pass
                            tree = os.open('tree', FLAGS | os.O_DIRECTORY, dir_fd=stage)
                            try:
                                require(os.fstat(tree).st_uid in (os.getuid(), uid), 'invalid_staging_directory')
                                for entry in sorted(entries, key=lambda item: (item['path'].count('/'), item['path'])):
                                    if entry['kind'] == 'directory':
                                        try:
                                            os.mkdir(entry['path'], 0o700, dir_fd=tree)
                                        except FileExistsError:
                                            existing = os.stat(entry['path'], dir_fd=tree, follow_symlinks=False)
                                            require(stat.S_ISDIR(existing.st_mode) and existing.st_uid in (os.getuid(), uid), 'invalid_staged_directory')
                                    else:
                                        fd = os.open(entry['path'], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                                                     0o700 if entry['executable'] else 0o600, dir_fd=tree)
                                        try:
                                            raw = base64.b64decode(entry['content'], validate=True)
                                            metadata = os.fstat(fd)
                                            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                                                    and metadata.st_uid in (os.getuid(), uid) and metadata.st_size <= len(raw), 'invalid_staged_file')
                                            # Resume only an exact prefix written by this same
                                            # operation; never replace changed staged content.
                                            prior = os.read(fd, len(raw) + 1)
                                            require(prior == raw[:len(prior)], 'staged_hash_mismatch')
                                            raw = raw[len(prior):]
                                            while raw:
                                                raw = raw[os.write(fd, raw):]
                                            os.fchown(fd, uid, gid)
                                            os.fchmod(fd, 0o700 if entry['executable'] else 0o600)
                                            os.fsync(fd)
                                        finally:
                                            os.close(fd)
                                for entry in reversed(sorted(entries, key=lambda item: item['path'].count('/'))):
                                    if entry['kind'] == 'directory':
                                        os.chown(entry['path'], uid, gid, dir_fd=tree, follow_symlinks=False)
                                os.fchown(tree, uid, gid)
                                require(snapshot(tree, uid) == entries, 'staged_hash_mismatch')
                                os.fsync(tree)
                                receipt = {'artifactSha256': artifact, 'inode': os.fstat(tree).st_ino,
                                           'device': os.fstat(tree).st_dev, 'state': 'prepared'}
                                write_json_at(receipts, name, receipt)
                            finally:
                                os.close(tree)
                        # A prepared receipt surviving a crash is not permission
                        # to install a different staged inode or changed bytes.
                        tree = os.open('tree', FLAGS | os.O_DIRECTORY, dir_fd=stage)
                        try:
                            require(os.fstat(tree).st_ino == receipt['inode'] and os.fstat(tree).st_dev == receipt['device']
                                    and snapshot(tree, uid) == entries, 'prepared_tree_mismatch')
                        finally:
                            os.close(tree)
                        if services:
                            desktop_stop_attempted = True
                            subprocess.run(['systemctl', 'stop'] + list(reversed(WORKSPACE_SERVICES)), check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        os.rename('tree', 'Hivra', src_dir_fd=stage, dst_dir_fd=homefd)
                        os.fsync(homefd)
                    finally:
                        os.close(stage)
                if services:
                    subprocess.run(['systemctl', 'restart'] + WORKSPACE_SERVICES, check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    for unit in WORKSPACE_SERVICES:
                        subprocess.run(['systemctl', 'is-active', '--quiet', unit], check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    desktop_stop_attempted = False
                workspace = os.open('Hivra', FLAGS | os.O_DIRECTORY, dir_fd=homefd)
                try:
                    require(snapshot(workspace, uid) == entries, 'restored_hash_mismatch')
                finally:
                    os.close(workspace)
                receipt['state'] = 'verified'
                write_json_at(receipts, name, receipt)
                # Only the now-empty operation-owned staging parent is removed.
                try:
                    stage = os.open('.hivra-folder-stage-' + operation, FLAGS | os.O_DIRECTORY, dir_fd=homefd)
                except FileNotFoundError:
                    stage = None
                if stage is not None:
                    try:
                        require(os.fstat(stage).st_uid == os.getuid(), 'staging_identity_mismatch')
                        try:
                            require(read_json_at(stage, 'identity.json') == {'operationId':operation, 'artifactSha256':artifact}, 'staging_identity_mismatch')
                            os.unlink('identity.json', dir_fd=stage)
                        except FileNotFoundError:
                            require(not os.listdir(stage), 'staging_identity_missing')
                    finally:
                        os.close(stage)
                    os.rmdir('.hivra-folder-stage-' + operation, dir_fd=homefd)
                return {'operationId': operation, 'artifactSha256': artifact, 'verified': True,
                        'files': sum(entry['kind'] == 'file' for entry in entries),
                        'bytes': sum(len(base64.b64decode(entry['content'])) for entry in entries if entry['kind'] == 'file')}
            finally:
                if services and desktop_stop_attempted:
                    # A refused rename, partial stop, or interrupted restart must
                    # not leave the previously working desktop stopped. This is
                    # best-effort service cleanup, never restore success evidence.
                    try:
                        subprocess.run(['systemctl', 'start'] + WORKSPACE_SERVICES, check=False, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    except Exception:
                        pass
                os.close(lockfd)
        finally:
            os.close(receipts)
    finally:
        os.close(homefd)

def main():
    try:
        raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        require(len(raw) <= 4 * 1024 * 1024, 'request_too_large')
        print('HIVRA_FOLDER_RESULT ' + json.dumps(run(json.loads(raw))))
    except RecoveryError as error:
        print('HIVRA_FOLDER_ERROR ' + str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        print('HIVRA_FOLDER_ERROR recovery_verification_failed', file=sys.stderr)
        raise SystemExit(1)
`;
