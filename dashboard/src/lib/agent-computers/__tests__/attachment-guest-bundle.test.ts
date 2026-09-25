jest.mock("server-only", () => ({}));

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAttachmentGuestBundle } from "../attachment-guest-bundle";
const expected = {
  identity: { operationId: "11111111-1111-4111-8111-111111111111", dispatchId: "22222222-2222-4222-8222-222222222222",
    installationId: "33333333-3333-4333-8333-333333333333", bindingId: "44444444-4444-4444-8444-444444444444",
    computerId: "55555555-5555-4555-8555-555555555555", sourceId: "66666666-6666-4666-8666-666666666666", architecture: "x86_64" as const },
  bootId: "77777777-7777-4777-8777-777777777777",
};

it.each(["fetch", "stage", "observe"] as const)("packages only verified sources for the explicit %s action within QGA limits", action => {
  const bundle = buildAttachmentGuestBundle(action, expected);
  const value = JSON.parse(bundle.stdin);
  expect(value).toMatchObject({ version: 1, action, identity: expected.identity, bootId: expected.bootId });
  expect(Object.keys(value.assets).sort()).toEqual(["fetcher", "stager", "worker"]);
  expect(Buffer.byteLength(bundle.stdin)).toBeLessThanOrEqual(65536);
  expect(bundle.program).toBe(readFileSync(path.resolve(process.cwd(), "provisioner/run-attached-codex-bundle.py"), "utf8"));
});

it("rejects invalid identity/boot/action before reading any asset", () => {
  const reader = jest.fn();
  expect(() => buildAttachmentGuestBundle("fetch", { ...expected, bootId: expected.bootId + "\n" }, reader)).toThrow();
  expect(() => buildAttachmentGuestBundle("fetch", { ...expected, identity: { ...expected.identity, sourceId: "invalid" } }, reader)).toThrow();
  expect(() => buildAttachmentGuestBundle("arbitrary" as "stage", expected, reader)).toThrow();
  expect(reader).not.toHaveBeenCalled();
});

it("rejects altered assets rather than executing or sending them", () => {
  expect(() => buildAttachmentGuestBundle("stage", expected, () => Buffer.from("print('unreviewed')"))).toThrow(/reviewed revision/);
});

// The pinned runner, run for real (design 5.5, T3): every refusal is one
// named line, and a dispatched stage's observation says whether the stage is
// still running, ended without a receipt, or left no journal at all.
const RUNNER_PROBE = String.raw`import fcntl,json,os,runpy,subprocess,sys,tempfile
runner=sys.argv[1]
identity=json.loads(sys.argv[2])
boot=sys.argv[3]
out={}
def run(stdin):
    proc=subprocess.run([sys.executable,'-I','-B',runner],input=stdin,capture_output=True,timeout=30)
    return {'status':proc.returncode,'stdout':proc.stdout.decode()}
out['invalid']=run(b'{}')
out['offGuest']=run(sys.stdin.buffer.read())
module=runpy.run_path(runner,run_name='hivra_probe')
observe=module['observe_staged']
root=tempfile.mkdtemp()
observe.__globals__['journal_root']=lambda: os.open(root,os.O_RDONLY|os.O_DIRECTORY)
observe.__globals__['private_file']=lambda info: None
worker={'checked_receipt':lambda receipt,expected: receipt}
def outcome():
    try:
        return observe(identity,boot,worker)['phase']
    except module['Refused'] as error:
        return error.code
    except ValueError:
        return 'unnamed'
def journal(record):
    with open(os.path.join(root,'staging.json'),'w') as output:
        json.dump(record,output)
out['noLock']=outcome()
os.close(os.open(os.path.join(root,'installer.lock'),os.O_RDWR|os.O_CREAT,0o600))
out['noJournal']=outcome()
holder=os.open(os.path.join(root,'installer.lock'),os.O_RDWR)
fcntl.flock(holder,fcntl.LOCK_EX)
journal({'version':1,'identity':identity,'bootId':boot,'phase':'started'})
out['running']=outcome()
fcntl.flock(holder,fcntl.LOCK_UN)
out['ended']=outcome()
journal({'version':1,'identity':dict(identity,installationId='88888888-8888-4888-8888-888888888888'),'bootId':boot,'phase':'started'})
out['another']=outcome()
journal({'version':1,'identity':identity,'bootId':boot,'phase':'staged','receipt':{}})
out['staged']=outcome()
print(json.dumps(out))
`;

it("names every refusal on one line, and tells a running stage from one that ended without a receipt (T3)", () => {
  const runner = path.resolve(process.cwd(), "provisioner/run-attached-codex-bundle.py");
  const { stdin } = buildAttachmentGuestBundle("observe", expected);
  const out = JSON.parse(execFileSync("python3", ["-I", "-B", "-c", RUNNER_PROBE, runner, JSON.stringify(expected.identity), expected.bootId],
    { input: stdin, encoding: "utf8", timeout: 60_000 }));
  expect(out.invalid).toEqual({ status: 1, stdout: "HIVRA_GUEST_STEP_REFUSED bundle_invalid\n" });
  // Every asset verified, then refused off the bound guest root, named for its action.
  expect(out.offGuest).toEqual({ status: 1, stdout: "HIVRA_GUEST_STEP_REFUSED staging_unresolved\n" });
  expect(out).toMatchObject({ noLock: "staging_absent", noJournal: "staging_absent", running: "staging_in_progress",
    ended: "staging_failed", another: "unnamed", staged: "staged" });
});
