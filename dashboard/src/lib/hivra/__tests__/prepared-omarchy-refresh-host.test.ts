import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { OMARCHY_REFRESH_GUEST_ACCEPTANCE, OMARCHY_REFRESH_GUEST_CONTROL, OMARCHY_REFRESH_GUEST_STAGE,
  OMARCHY_REFRESH_HOST_RUNNER, preparedOmarchyRefreshHostScript } from "../prepared-omarchy-refresh-host";
import { readOmarchyRefreshHostStatus } from "../prepared-omarchy-refresh-contract";

const request = { version: 1 as const, operationId: "018f6d3c-1d91-7c65-9d86-37fc915b8377", computerId: "44444444-4444-4444-8444-444444444444",
  bindingTag: "hivra-bind-"+"a".repeat(32), slot: { host: "node-b", node: "node-b", vmid: 2099, ip: "10.240.20.99", claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1" },
  release: { release: "v4.0.6", releaseCommit: "b".repeat(40), isoFilename: "omarchy-4.0.6.iso", isoUrl: "https://iso.omarchy.org/omarchy-4.0.6.iso", isoSha256: "c".repeat(64) } };

it.each([OMARCHY_REFRESH_GUEST_STAGE, OMARCHY_REFRESH_GUEST_CONTROL, OMARCHY_REFRESH_GUEST_ACCEPTANCE, OMARCHY_REFRESH_HOST_RUNNER])("compiles the exact emitted Python worker program", source => {
  const result = spawnSync("python3", ["-c", "import sys;compile(sys.stdin.read(),'<prepared-refresh>','exec')"], { input: source, encoding: "utf8" });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});

it("queues one durable worker and leaves an immutable manifest across HTTP retries", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "prepared-refresh-host-"));
  try {
    const bin = path.join(root, "bin"); fs.mkdirSync(bin); const log = path.join(root,"queued");
    fs.writeFileSync(path.join(bin,"systemctl"), "#!/bin/sh\nif [ -e \"$TEST_ACTIVE\" ]; then echo active; else echo inactive; fi\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin,"systemd-run"), "#!/bin/sh\necho queued >> \"$TEST_QUEUE\"\ntouch \"$TEST_ACTIVE\"\n", { mode: 0o755 });
    const env = { ...process.env, PATH: bin+":"+process.env.PATH, TEST_ACTIVE: path.join(root,"active"), TEST_QUEUE: log };
    const script = (cancel = false) => preparedOmarchyRefreshHostScript(request,cancel).replace("/var/lib/hivra/prepared-omarchy-refresh",path.join(root,"operations"));
    expect(spawnSync("bash",["-n"],{input:script(),encoding:"utf8"}).status).toBe(0);
    const first = spawnSync("bash",["-c",script()],{env,encoding:"utf8"});
    expect({ status:first.status,stderr:first.stderr }).toEqual({status:0,stderr:""});
    expect(readOmarchyRefreshHostStatus(first.stdout).state).toBe("queued");
    const second = spawnSync("bash",["-c",script()],{env,encoding:"utf8"});
    expect(readOmarchyRefreshHostStatus(second.stdout).state).toBe("running");
    expect(fs.readFileSync(log,"utf8").trim().split("\n")).toHaveLength(1);
    const base=path.join(root,"operations",request.operationId);
    expect(JSON.parse(fs.readFileSync(path.join(base,"request.json"),"utf8"))).toEqual(request);
    const cancel=spawnSync("bash",["-c",script(true)],{env,encoding:"utf8"});
    expect(cancel.status).toBe(0); expect(fs.existsSync(path.join(base,"cancel"))).toBe(true);
    expect(spawnSync("bash",["-c",script()],{env,encoding:"utf8"}).status).toBe(0);
    expect(fs.existsSync(path.join(base,"cancel"))).toBe(true);
    const changed=preparedOmarchyRefreshHostScript({...request,release:{...request.release,releaseCommit:"d".repeat(40)}}).replace("/var/lib/hivra/prepared-omarchy-refresh",path.join(root,"operations"));
    const mismatch=spawnSync("bash",["-c",changed],{env,encoding:"utf8"});
    expect(mismatch.status).not.toBe(0);expect(mismatch.stderr).toContain("refresh_manifest_changed");
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

it("uses narrow native updater privileges and refuses deferred migrations instead of root-running home migrations", () => {
  expect(OMARCHY_REFRESH_GUEST_STAGE).toContain("sudo -n /usr/bin/omarchy-update-keyring");
  expect(OMARCHY_REFRESH_GUEST_STAGE).toContain("sudo -n /usr/bin/omarchy-update-system-pkgs");
  expect(OMARCHY_REFRESH_GUEST_STAGE).not.toContain("sudo -n true");
  expect(OMARCHY_REFRESH_GUEST_STAGE).toContain("system_migration_needs_review");
  expect(OMARCHY_REFRESH_GUEST_STAGE).toContain("migration_package_digest_mismatch");
  expect(OMARCHY_REFRESH_GUEST_STAGE).toContain("omarchy_migrations_pending");
  expect(OMARCHY_REFRESH_GUEST_STAGE).not.toContain("NOPASSWD");
  expect(OMARCHY_REFRESH_GUEST_ACCEPTANCE).toContain("omarchy_migrations_pending");
});

it.each([true, 1])("executes identity checks, QGA exited=%s, reboot and terminal recovery", exited => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "prepared-refresh-runner-"));
  try {
    const base = path.join(root,"operation"); const bin = path.join(root,"bin"); fs.mkdirSync(base); fs.mkdirSync(bin);
    const expected = { packageVersion:"4.0.6-1",osVersion:"4.0.6",selectedKernel:"7.2.15-1-omarchy",bootIdBefore:"33333333-3333-4333-8333-333333333333",ownerUid:1000,ownerName:"hivra" };
    fs.writeFileSync(path.join(base,"request.json"),JSON.stringify(request));
    for(const [name,source] of [["guest-stage.py",OMARCHY_REFRESH_GUEST_STAGE],["guest-control.py",OMARCHY_REFRESH_GUEST_CONTROL],["guest-acceptance.py",OMARCHY_REFRESH_GUEST_ACCEPTANCE]])fs.writeFileSync(path.join(base,name),source);
    const fake = `#!/usr/bin/env python3
import json,os,pathlib,sys
root=pathlib.Path(os.environ['TEST_ROOT']);args=sys.argv[1:]
expected=json.loads(os.environ['TEST_EXPECTED'])
if args[0]=='config':print('name: hivra-omarchy-canary\\ndescription: hivra-omarchy-operation:${request.slot.claim}\\ntags: ${request.bindingTag}')
elif args[0]=='status':print('status: '+('stopped' if (root/'stopped').exists() else 'running'))
elif args[0]=='shutdown':(root/'stopped').touch();(root/'rebooted').touch()
elif args[0]=='start':(root/'stopped').unlink()
elif args[:2]==['guest','exec']:
 code=args[args.index('-c')+1]
 if "mode=sys.argv[1]" in code:result={'active':False,'exitCode':0,'result':expected}
 elif "expected=json.loads(sys.argv[1])" in code:
  assert (root/'rebooted').exists()
  result={k:expected[k] for k in ['packageVersion','osVersion','selectedKernel','bootIdBefore']}
  result.update(kernelRelease=expected['selectedKernel'],bootIdAfter='55555555-5555-4555-8555-555555555555',desktopReady=True,migrationsComplete=True,observedAt='2026-11-03T01:00:00Z')
 else:result=expected['bootIdBefore']
 print(json.dumps({'exited':${exited === true ? "True" : "1"},'exitcode':0,'out-data':json.dumps(result)}))
else:raise RuntimeError(args)
`;
    fs.writeFileSync(path.join(bin,"qm"),fake,{mode:0o755});
    const source=OMARCHY_REFRESH_HOST_RUNNER.replace("socket.gethostname().split('.')[0]", "'node-b'").replace("'/run/lock/hivra-prepared-'",JSON.stringify(path.join(root,"lock-")));
    const result=spawnSync("python3",["-c",source,base],{encoding:"utf8",timeout:10_000,env:{...process.env,PATH:bin+":"+process.env.PATH,TEST_ROOT:root,TEST_EXPECTED:JSON.stringify(expected)}});
    expect({status:result.status,stderr:result.stderr}).toEqual({status:0,stderr:""});
    const receipt=JSON.parse(fs.readFileSync(path.join(base,"receipt.json"),"utf8"));
    expect(receipt.state).toBe("complete");expect(receipt.observed.bootIdAfter).not.toBe(expected.bootIdBefore);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

it("executes guest discovery and boot-selection patterns against native Omarchy fixtures", () => {
  const harness = String.raw`import ast,re,sys
source=sys.stdin.read();tree=ast.parse(source)
strings=[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str)]
uid=next(s for s in strings if s.startswith('^Uid:'))
assert re.search(uid,'Uid:\t1000\t1000\t1000\t1000',re.M).groups()==('1000',)*4
channel=next(s for s in strings if s.startswith('https://pkgs'))
assert re.fullmatch(channel,'https://pkgs.omarchy.org/stable/x86_64')
assert not re.fullmatch(channel,'https://pkgs.omarchy.org/unstable/x86_64')
config='default_entry: 2\n  //linux-omarchy\n    comment: Kernel version: 7.2.15-1-omarchy\n    path: boot():/EFI/Linux/omarchy.efi#abc123\n  //linux\n'
default=next(s for s in strings if s.startswith('^default_entry:'))
assert re.search(default,config,re.M)
custom=next(s for s in strings if s.startswith('  //linux-omarchy'))
standard=next(s for s in strings if s.startswith('  //linux') and 'omarchy' not in s)
a=config.index(custom);assert a<config.index(standard)
path=next(s for s in strings if s.startswith('path: boot'))
assert re.search(path,config).groups()==('/EFI/Linux/omarchy.efi','abc123')
`;
  const result=spawnSync("python3",["-c",harness],{encoding:"utf8",input:OMARCHY_REFRESH_GUEST_STAGE});
  expect({status:result.status,stderr:result.stderr}).toEqual({status:0,stderr:""});
});
