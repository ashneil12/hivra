/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { COMPUTER_EXPORT_GUEST_PYTHON } from "../guest";
import { buildComputerExportHostScript, parseComputerExportResult } from "../host";

function python(body: string) {
  const code = `${COMPUTER_EXPORT_GUEST_PYTHON}\n${body}\n`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8", timeout: 60_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  return result.stdout;
}

describe("computer export guest program", () => {
  it("refuses links that are not the export bucket and bad passphrases", () => {
    const out = python(`
import io
def run(req):
    sys.stdin = io.StringIO(json.dumps(req)); main()
run({'action': 'start', 'exportId': '11111111-2222-4333-8444-555555555555', 'partSize': 64 << 20, 'passphrase': 'long enough phrase', 'partUrls': ['https://evil.example/x?a=b']})
run({'action': 'start', 'exportId': '11111111-2222-4333-8444-555555555555', 'partSize': 64 << 20, 'passphrase': 'short', 'partUrls': ['https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/b/k?a=b']})
run({'action': 'status', 'exportId': '../etc'})
`);
    const answers = out.trim().split("\n").map((line) => parseComputerExportResult(line));
    expect(answers.map((a) => a.error)).toEqual(["invalid upload links", "invalid passphrase", "invalid export id"]);
  });

  it("packs, encrypts and uploads parts that decrypt back to the original files", () => {
    const out = python(`
import tempfile, threading, http.server, hashlib
received = {}
class Handler(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        received[self.path] = body
        self.send_response(200); self.send_header('ETag', '"' + hashlib.md5(body).hexdigest() + '"'); self.end_headers()
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory() as t:
    ROOT = t + '/root'; STATUS_DIR = t + '/status'; GNUPG_HOME = t + '/gnupg'
    os.makedirs(GNUPG_HOME, mode=0o700)
    os.makedirs(ROOT + '/home/bux/.hivra'); os.makedirs(ROOT + '/home/bux/.cache'); os.makedirs(ROOT + '/home/bux/work')
    open(ROOT + '/home/bux/.hivra/api-token', 'w').write('never exported')
    open(ROOT + '/home/bux/.cache/junk', 'w').write('cache')
    with open(ROOT + '/home/bux/work/notes.txt', 'wb') as f: f.write(os.urandom(7 << 20))
    urls = ['http://127.0.0.1:%d/part/%d' % (server.server_port, n) for n in range(1, 5)]
    pack({'exportId': 'e', 'partSize': 5 << 20, 'passphrase': 'correct horse battery', 'partUrls': urls})
    status = json.load(open(STATUS_DIR + '/e.json'))
    assert status['state'] == 'uploaded', status
    blob = b''.join(received['/part/%d' % p['partNumber']] for p in status['parts'])
    assert hashlib.sha256(blob).hexdigest() == status['sha256']
    assert len(status['parts']) >= 2 and status['bytes'] == len(blob)
    open(t + '/out.gpg', 'wb').write(blob)
    r, w = os.pipe(); os.write(w, b'correct horse battery'); os.close(w)
    dec = subprocess.run(['gpg', '--batch', '--quiet', '--pinentry-mode', 'loopback', '--passphrase-fd', str(r), '--homedir', GNUPG_HOME, '-d', t + '/out.gpg'], capture_output=True, pass_fds=(r,))
    assert dec.returncode == 0
    os.makedirs(t + '/x')
    comp = 'zstd' if shutil.which('zstd') else 'gzip'
    plain = subprocess.run([comp, '-d', '-c'], input=dec.stdout, capture_output=True).stdout
    subprocess.run(['tar', '-x', '-C', t + '/x'], input=plain, check=True)
    assert open(t + '/x/home/bux/work/notes.txt', 'rb').read() == open(ROOT + '/home/bux/work/notes.txt', 'rb').read()
    assert not os.path.exists(t + '/x/home/bux/.hivra') and not os.path.exists(t + '/x/home/bux/.cache')
    print('PACKED', len(status['parts']))
`);
    expect(out).toContain("PACKED");
  });

  it("fails cleanly when the computer holds more than the size limit", () => {
    const out = python(`
import tempfile
with tempfile.TemporaryDirectory() as t:
    ROOT = t + '/root'; STATUS_DIR = t + '/status'; GNUPG_HOME = t + '/gnupg'
    os.makedirs(GNUPG_HOME, mode=0o700); os.makedirs(ROOT + '/home/bux')
    with open(ROOT + '/home/bux/big', 'wb') as f: f.write(os.urandom(6 << 20))
    put_part = lambda url, data: 'abcdef0123456789'
    pack({'exportId': 'e', 'partSize': 5 << 20, 'passphrase': 'correct horse battery', 'partUrls': ['u1']})
    print(json.load(open(STATUS_DIR + '/e.json'))['state'])
`);
    expect(out.trim()).toBe("failed");
  });
});

describe("computer export host script", () => {
  it("never puts the request into the script and checks the VM identity first", () => {
    const script = buildComputerExportHostScript({ vmid: 123, ip: "10.0.0.5", bindingTag: `hivra-bind-${"a".repeat(32)}`, vmSshKeyPath: "/etc/hivra/vm" });
    expect(script).toContain("EXPECTED_BINDING_TAG='hivra-bind-");
    expect(script).toContain("qm guest exec");
    expect(script).not.toContain("passphrase\"");
    expect(() => buildComputerExportHostScript({ vmid: 1, ip: "not-an-ip", bindingTag: "x", vmSshKeyPath: "/k" })).toThrow();
  });

  it("needs exactly one answer line", () => {
    expect(() => parseComputerExportResult("noise")).toThrow();
    expect(parseComputerExportResult('x\nHIVRA_EXPORT_RESULT {"ok":true}\n')).toEqual({ ok: true });
  });
});
