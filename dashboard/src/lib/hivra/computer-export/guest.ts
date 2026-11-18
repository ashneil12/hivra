// Guest-side program for the whole-computer export. Runs as root inside the
// owner's own computer (sudo over the VMID-bound SSH session), reads one JSON
// request from stdin and prints exactly one `HIVRA_EXPORT_RESULT {json}` line.
//
// "start" validates the request, then detaches (double fork + setsid) so the
// packing outlives the SSH session, and answers at once. The detached child
// packs /home and /a0/usr (Agent Zero's user folder) with tar, compresses with
// zstd (gzip when zstd is missing), encrypts with `gpg --symmetric` (AES-256)
// using the owner's passphrase, and uploads the ciphertext in fixed-size parts
// to presigned links. Progress lives in a root-only status file.
// "status" reads that status file.
//
// Never stored: the passphrase (held in memory and handed to gpg through a
// pipe) and the presigned links. Hivra's own per-computer folder ~/.hivra
// (its connection token and internal state) and caches are left out.

export const COMPUTER_EXPORT_GUEST_PYTHON = String.raw`
import hashlib, json, os, re, shutil, subprocess, sys, time, urllib.request

STATUS_DIR = '/var/lib/hivra-export'
ROOT = '/'
GNUPG_HOME = '/root/.gnupg-hivra-export'
EXPORT_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
URL = re.compile(r'^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com/[A-Za-z0-9/._%-]+\?[A-Za-z0-9=&%._-]+$')
EXCLUDES = [
    'home/*/.hivra', 'home/*/.cache', 'home/*/.npm', 'home/*/.npm-global/lib/node_modules/.cache',
    'home/*/.bun/install/cache', 'home/*/.local/share/Trash', 'home/*/.browser-profile/*/Cache',
    'home/*/.browser-profile/*/Code Cache', 'home/*/.browser-profile/*/GPUCache', 'home/*/snap/*/common/.cache',
    '*.sock',
]

def emit(value):
    sys.stdout.write('HIVRA_EXPORT_RESULT ' + json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def status_path(export_id):
    return os.path.join(STATUS_DIR, export_id + '.json')

def write_status(export_id, value):
    os.makedirs(STATUS_DIR, mode=0o700, exist_ok=True)
    tmp = status_path(export_id) + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle)
    os.replace(tmp, status_path(export_id))

def read_exactly(stream, size):
    chunks, have = [], 0
    while have < size:
        block = stream.read(min(1 << 20, size - have))
        if not block:
            break
        chunks.append(block)
        have += len(block)
    return b''.join(chunks)

def put_part(url, data):
    last = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Length': str(len(data))})
            with urllib.request.urlopen(request, timeout=600) as response:
                etag = (response.headers.get('ETag') or '').strip('"')
                if response.status == 200 and re.match(r'^[0-9a-fA-F-]{8,80}$', etag):
                    return etag
                last = 'bad answer'
        except Exception as error:
            last = type(error).__name__
        time.sleep(2 ** attempt)
    raise RuntimeError('part upload failed: ' + str(last))

def pack(request):
    export_id = request['exportId']
    urls = request['partUrls']
    part_size = request['partSize']
    state = {'state': 'running', 'parts': [], 'bytes': 0, 'startedAt': int(time.time())}
    write_status(export_id, state)
    roots = [p for p in ('home', 'a0/usr') if os.path.isdir(os.path.join(ROOT, p))]
    compressor = ['zstd', '-q', '-T0', '-3', '-c'] if shutil.which('zstd') else ['gzip', '-c', '-6']
    state['compression'] = compressor[0]
    tar_cmd = ['ionice', '-c3', 'nice', '-n', '15', 'tar', '--create', '--file=-', '--directory=' + ROOT,
               '--warning=no-file-changed', '--warning=no-file-removed', '--ignore-failed-read', '--sparse',
               '--anchored', '--wildcards']
    for pattern in EXCLUDES:
        tar_cmd.append('--exclude=' + pattern)
    tar_cmd += roots
    read_fd, write_fd = os.pipe()
    os.write(write_fd, request['passphrase'].encode('utf-8'))
    os.close(write_fd)
    tar = subprocess.Popen(tar_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    comp = subprocess.Popen(['nice', '-n', '15'] + compressor, stdin=tar.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    tar.stdout.close()
    gpg = subprocess.Popen(['gpg', '--batch', '--yes', '--no-tty', '--quiet', '--pinentry-mode', 'loopback',
                            '--passphrase-fd', str(read_fd), '--symmetric', '--cipher-algo', 'AES256',
                            '--compress-algo', 'none', '--homedir', GNUPG_HOME, '-o', '-'],
                           stdin=comp.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, pass_fds=(read_fd,))
    comp.stdout.close()
    os.close(read_fd)
    digest = hashlib.sha256()
    try:
        number = 0
        while True:
            data = read_exactly(gpg.stdout, part_size)
            if not data:
                break
            if number >= len(urls):
                raise RuntimeError('export is larger than the size limit')
            digest.update(data)
            etag = put_part(urls[number], data)
            number += 1
            state['parts'].append({'partNumber': number, 'etag': etag})
            state['bytes'] += len(data)
            write_status(export_id, state)
        if gpg.wait() != 0 or comp.wait() != 0 or tar.wait() not in (0, 1):
            raise RuntimeError('packing failed')
        if number == 0:
            raise RuntimeError('nothing was packed')
        state.update({'state': 'uploaded', 'sha256': digest.hexdigest(), 'finishedAt': int(time.time())})
        write_status(export_id, state)
    except Exception as error:
        for process in (tar, comp, gpg):
            try:
                process.kill()
            except Exception:
                pass
        state.update({'state': 'failed', 'error': str(error)[:200], 'finishedAt': int(time.time())})
        write_status(export_id, state)

def start(request):
    export_id = request.get('exportId')
    urls = request.get('partUrls')
    part_size = request.get('partSize')
    passphrase = request.get('passphrase')
    if not isinstance(export_id, str) or not EXPORT_ID.match(export_id):
        return emit({'ok': False, 'error': 'invalid export id'})
    if not isinstance(urls, list) or not (1 <= len(urls) <= 2000) or not all(isinstance(u, str) and URL.match(u) for u in urls):
        return emit({'ok': False, 'error': 'invalid upload links'})
    if not isinstance(part_size, int) or not (5 << 20) <= part_size <= (512 << 20):
        return emit({'ok': False, 'error': 'invalid part size'})
    if not isinstance(passphrase, str) or not (12 <= len(passphrase.encode('utf-8')) <= 1024) or '\n' in passphrase:
        return emit({'ok': False, 'error': 'invalid passphrase'})
    for tool in ('tar', 'gpg', 'ionice', 'nice'):
        if not shutil.which(tool):
            return emit({'ok': False, 'error': 'missing tool: ' + tool})
    if os.path.exists(status_path(export_id)):
        return emit({'ok': True, 'started': False, 'alreadyStarted': True})
    os.makedirs(GNUPG_HOME, mode=0o700, exist_ok=True)
    write_status(export_id, {'state': 'queued', 'parts': [], 'bytes': 0})
    if os.fork() > 0:
        return emit({'ok': True, 'started': True})
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    try:
        pack(request)
    finally:
        os._exit(0)

def status(request):
    export_id = request.get('exportId')
    if not isinstance(export_id, str) or not EXPORT_ID.match(export_id):
        return emit({'ok': False, 'error': 'invalid export id'})
    try:
        with open(status_path(export_id)) as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return emit({'ok': True, 'state': 'missing'})
    value['ok'] = True
    emit(value)

def main():
    try:
        request = json.loads(sys.stdin.read(4 << 20))
    except Exception:
        return emit({'ok': False, 'error': 'invalid request'})
    if not isinstance(request, dict):
        return emit({'ok': False, 'error': 'invalid request'})
    action = request.get('action')
    if action == 'start':
        return start(request)
    if action == 'status':
        return status(request)
    emit({'ok': False, 'error': 'unknown action'})
`;
